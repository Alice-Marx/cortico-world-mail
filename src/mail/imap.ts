/**
 * cortico-world-mail · 裸 TCP/TLS 自写 IMAP 客户端（PLAN.md §3.2，W1 独占文件）。
 *
 * 零第三方依赖：node:net、node:tls、node:buffer。
 * 支持的命令：CAPABILITY / LOGIN / LIST "" "*" / SELECT / EXAMINE（内部保留）/ UID SEARCH /
 * UID FETCH（UID、FLAGS、RFC822.SIZE、BODY.PEEK[HEADER.FIELDS (...)]、BODY.PEEK[]）/
 * UID STORE +FLAGS \Seen / LOGOUT。
 *
 * 协议细节：
 * - 行读取 + IMAP literal（`{n}\r\n` 后 n 字节，可能跨多个 TCP 包）；
 * - untagged 收集、标签匹配、`+` continuation（收到时回空行，命令继续等待）；
 * - 文件夹名：命令参数用修改版 UTF-7 编码 + 引号（imap-utf7.ts），LIST 结果解码；
 * - 任何失败一律抛 MailError：TCP/DNS → connect，TLS 握手 → tls，LOGIN 被拒 → auth，
 *   NO/BAD → protocol，命令超时 → timeout，连接中途断 → dropped。
 *   `message` 只说类别与关键事实，服务器原文只进 `detail`（绝不进工具回执）。
 * - 连接失败后下一条命令会重新建连（live.ts 的“失败后重试一次”语义由此兜底）。
 */

import { Buffer } from 'node:buffer';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { MailError } from './types.ts';
import type {
  FetchRange,
  ImapClient,
  ImapOptions,
  ImapSelectInfo,
  MailFlags,
  MailHeader,
  MailMessage,
} from './types.ts';
import { decodeHeaderValue, parseAddressList, parseHeaders, parseMail, splitHeaderBody } from './mime.ts';
import { decodeImapUtf7, quoteImapMailbox } from './imap-utf7.ts';

// 类型从契约文件转出：调用方既可以从 types.ts 也可以从本文件 import。
export type { FetchRange, ImapClient, ImapOptions, ImapSelectInfo } from './types.ts';

// ───────────────────────── 常量 ─────────────────────────

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_FETCH_LIMIT = 20;
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_UNSOLICITED = 200;
const HEADER_FIELDS =
  'MESSAGE-ID SUBJECT FROM TO CC DATE CONTENT-TYPE CONTENT-DISPOSITION REPLY-TO IN-REPLY-TO REFERENCES';

const TCP_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'ECONNRESET',
  'EPIPE',
]);

// ───────────────────────── 内部类型 ─────────────────────────

interface Response {
  /** 逻辑响应文本；literal 位置写成 `\u0000L<index>\u0000` 占位符 */
  text: string;
  literals: Buffer[];
}

/** 一条命令的完整结果：tagged 响应 + 期间收集到的所有 untagged 响应。 */
interface CommandResult extends Response {
  untagged: Response[];
}

type ResponseStatus = 'OK' | 'NO' | 'BAD';

interface PendingCommand {
  tag: string;
  /** 人话命令名（只用于我们自己的错误文案，不含服务器原文/凭据） */
  label: string;
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  untagged: Response[];
  continuations: string[];
  onContinuation?: (line: string) => string | void;
}

interface GreetingWaiter {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

interface FetchRecord {
  seq: number;
  uid: number;
  flags: string[];
  size: number;
  headerLiteral: Buffer | null;
  bodyLiteral: Buffer | null;
}

interface ListEntry {
  flags: string[];
  name: string;
}

// ───────────────────────── 小工具 ─────────────────────────

function getErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = getErrorCode(error);
    return `${error.name}: ${error.message}${code ? ` (${code})` : ''}`;
  }
  return String(error);
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function quoteImapString(value: string): string {
  return `"${String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')}"`;
}

function decodeHeaderBytes(bytes: Buffer): string {
  if (bytes.length === 0) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatImapDate(source: string): string {
  const value = source.trim();
  if (!value) return '';
  // 已经是 DD-Mon-YYYY 就直接用
  if (/^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(value)) {
    const firstDash = value.indexOf('-');
    return `${value.slice(0, firstDash).padStart(2, '0')}${value.slice(firstDash)}`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getUTCDate()).padStart(2, '0')}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

function parseDateHeader(value: string): string {
  if (!value) return '';
  try {
    const date = new Date(value.trim());
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString();
  } catch {
    return '';
  }
}

function makeSnippet(text: string): string {
  const collapsed = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return collapsed.length > 200 ? collapsed.slice(0, 200) : collapsed;
}

function headerBlockToHeaders(bytes: Buffer | null): Record<string, string> {
  if (!bytes || bytes.length === 0) return {};
  try {
    const split = splitHeaderBody(new Uint8Array(bytes));
    return parseHeaders(split.header);
  } catch {
    return {};
  }
}

function mailHeaderFromRaw(
  folder: string,
  uid: number,
  rawFlags: string[],
  size: number,
  rawHeaders: Record<string, string>,
): MailHeader {
  const flagText = rawFlags.join(' ');
  const flags: MailFlags = {
    seen: /\\Seen\b/i.test(flagText),
    flagged: /\\Flagged\b/i.test(flagText),
    answered: /\\Answered\b/i.test(flagText),
    draft: /\\Draft\b/i.test(flagText),
    deleted: /\\Deleted\b/i.test(flagText),
  };
  const contentType = (rawHeaders['content-type'] ?? '').trim();
  const disposition = (rawHeaders['content-disposition'] ?? '').trim();
  return {
    folder,
    uid,
    messageId: (rawHeaders['message-id'] ?? '').trim(),
    subject: decodeHeaderValue(rawHeaders['subject'] ?? ''),
    from: parseAddressList(rawHeaders['from'] ?? ''),
    to: parseAddressList(rawHeaders['to'] ?? ''),
    cc: parseAddressList(rawHeaders['cc'] ?? ''),
    date: parseDateHeader(rawHeaders['date'] ?? ''),
    flags,
    size: Number.isFinite(size) && size > 0 ? size : 0,
    snippet: '',
    hasAttachments: /^multipart\/(mixed|related)/i.test(contentType) || /attachment/i.test(disposition),
  };
}

function decodeSearchUids(response: Response): number[] {
  const uids: number[] = [];
  for (const item of response.untagged) {
    const match = /^\* SEARCH\b([\s\S]*)$/i.exec(item.text);
    if (!match) continue;
    for (const token of match[1].trim().split(/\s+/)) {
      if (!token) continue;
      const uid = Number(token);
      if (Number.isFinite(uid) && uid > 0) uids.push(uid);
    }
  }
  uids.sort((a, b) => a - b);
  return uids;
}

function parseListResponse(response: Response): ListEntry | null {
  const match = /^\* LIST \(([^)]*)\) (NIL|"(?:[^"\\]|\\.)*"|\S+) ([\s\S]*)$/i.exec(response.text);
  if (!match) return null;
  const flags = match[1].split(/\s+/).filter(Boolean);
  let rawName = match[3].trim();
  const literalRef = /^\u0000L(\d+)\u0000$/.exec(rawName);
  if (literalRef) {
    const literal = response.literals[Number(literalRef[1])];
    rawName = literal ? decodeHeaderBytes(literal).trim() : '';
  } else if (rawName.startsWith('"') && rawName.endsWith('"') && rawName.length >= 2) {
    rawName = rawName.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return { flags, name: decodeImapUtf7(rawName) };
}

function parseFetchResponse(response: Response): FetchRecord | null {
  const match = /^\* (\d+) FETCH \(([\s\S]*)\)\s*$/i.exec(response.text);
  if (!match) return null;
  const record: FetchRecord = {
    seq: Number(match[1]),
    uid: 0,
    flags: [],
    size: 0,
    headerLiteral: null,
    bodyLiteral: null,
  };
  const payload = match[2];
  const uidMatch = /(?:^|\s)UID (\d+)/i.exec(payload);
  if (uidMatch) record.uid = Number(uidMatch[1]);
  const flagsMatch = /FLAGS \(([^)]*)\)/i.exec(payload);
  if (flagsMatch) record.flags = flagsMatch[1].split(/\s+/).filter(Boolean);
  const sizeMatch = /RFC822\.SIZE (\d+)/i.exec(payload);
  if (sizeMatch) record.size = Number(sizeMatch[1]);
  const referenceRe = /\u0000L(\d+)\u0000/g;
  let reference: RegExpExecArray | null;
  while ((reference = referenceRe.exec(payload)) !== null) {
    const literal = response.literals[Number(reference[1])];
    if (!literal) continue;
    const before = payload.slice(0, reference.index).toUpperCase();
    if (/BODY\[HEADER\.FIELDS[^\]]*\]\s*$/.test(before)) record.headerLiteral = literal;
    else if (/BODY\[\]\s*$/.test(before)) record.bodyLiteral = literal;
  }
  return record;
}

function extractCapabilities(response: Response): string[] {
  for (const item of response.untagged) {
    const match = /^\* CAPABILITY\b([\s\S]*)$/i.exec(item.text);
    if (match) return match[1].trim().split(/\s+/).filter(Boolean);
  }
  return [];
}

// ───────────────────────── 客户端实现 ─────────────────────────

class ImapConnection implements ImapClient {
  private readonly options: ImapOptions;

  private socket: Socket | TLSSocket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private connected = false;
  private authenticated = false;
  private tagCounter = 0;
  private pending: PendingCommand | null = null;
  private greetingWaiter: GreetingWaiter | null = null;
  private unsolicited: Response[] = [];
  private selectedFolder: string | null = null;
  private selectedInfo: ImapSelectInfo | null = null;
  private capabilities: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: ImapOptions) {
    this.options = options && typeof options === 'object' ? options : ({} as ImapOptions);
  }

  // ───────────── 公共 API ─────────────

  connect(): Promise<void> {
    return this.serialized(() => this.ensureConnected());
  }

  folders(): Promise<string[]> {
    return this.serialized(async () => {
      await this.ensureConnected();
      const response = await this.command('LIST "" "*"', '列文件夹');
      const names: string[] = [];
      for (const item of response.untagged) {
        const entry = parseListResponse(item);
        if (!entry) continue;
        if (entry.flags.some((flag) => /^\\Noselect$/i.test(flag))) continue;
        if (!entry.name) continue;
        names.push(entry.name);
      }
      return names;
    });
  }

  select(folder: string): Promise<ImapSelectInfo> {
    return this.serialized(async () => {
      await this.ensureConnected();
      return this.selectInternal(folder);
    });
  }

  fetchHeaders(folder: string, range?: FetchRange): Promise<MailHeader[]> {
    return this.serialized(async () => {
      await this.ensureConnected();
      const info = await this.ensureSelected(folder);
      const limit = normalizeLimit(range?.limit, DEFAULT_FETCH_LIMIT);
      const afterUid =
        typeof range?.afterUid === 'number' && Number.isFinite(range.afterUid) && range.afterUid > 0
          ? Math.floor(range.afterUid)
          : undefined;

      const fields = `UID FLAGS RFC822.SIZE BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS})]`;

      let unreadUids: number[] | null = null;
      if (range?.unreadOnly) {
        unreadUids = await this.searchUnseenUids();
        if (afterUid !== undefined) unreadUids = unreadUids.filter((uid) => uid > afterUid);
        unreadUids = unreadUids.slice(Math.max(0, unreadUids.length - limit));
        if (unreadUids.length === 0) return [];
      }

      let commandText: string;
      if (unreadUids) {
        commandText = `UID FETCH ${unreadUids.join(',')} (${fields})`;
      } else if (afterUid !== undefined) {
        commandText = `UID FETCH ${afterUid + 1}:* (${fields})`;
      } else {
        if (info.exists <= 0) return [];
        const start = Math.max(1, info.exists - limit + 1);
        commandText = `FETCH ${start}:* (${fields})`;
      }

      const response = await this.command(commandText, '读取邮件');
      const records: FetchRecord[] = [];
      for (const item of response.untagged) {
        const record = parseFetchResponse(item);
        if (record) records.push(record);
      }
      let headers = records.map((record) =>
        mailHeaderFromRaw(folder, record.uid, record.flags, record.size, headerBlockToHeaders(record.headerLiteral)),
      );
      if (afterUid !== undefined) headers = headers.filter((header) => header.uid > afterUid);
      headers.sort((a, b) => b.uid - a.uid);
      return headers.slice(0, limit);
    });
  }

  fetchMessage(folder: string, uid: number): Promise<MailMessage> {
    return this.serialized(async () => {
      await this.ensureConnected();
      await this.ensureSelected(folder);
      const targetUid = Math.floor(Number(uid));
      if (!Number.isFinite(targetUid) || targetUid <= 0) {
        throw new MailError('protocol', 'IMAP 邮件 UID 无效', { hint: '刷新邮件列表后重试' });
      }
      const response = await this.command(`UID FETCH ${targetUid} (UID FLAGS RFC822.SIZE BODY.PEEK[])`, '读取邮件');
      let record: FetchRecord | null = null;
      for (const item of response.untagged) {
        const candidate = parseFetchResponse(item);
        if (!candidate) continue;
        if (candidate.bodyLiteral || candidate.uid === targetUid) {
          record = candidate;
          break;
        }
      }
      if (!record || !record.bodyLiteral) {
        throw new MailError('protocol', 'IMAP 未找到该邮件', {
          hint: '刷新邮件列表后重试；邮件可能已被移动或删除',
          detail: `uid=${targetUid} folder=${folder}`,
        });
      }
      let parsed: ReturnType<typeof parseMail>;
      try {
        parsed = parseMail(record.bodyLiteral);
      } catch (error) {
        throw new MailError('parse', '邮件内容解析失败', {
          hint: '换一封或跳过该邮件',
          detail: describeError(error),
        });
      }
      const header = mailHeaderFromRaw(
        folder,
        record.uid || targetUid,
        record.flags,
        record.size,
        parsed.headers,
      );
      const decodedHeaders: Record<string, string> = {};
      for (const key of ['reply-to', 'references', 'in-reply-to', 'date', 'message-id', 'content-type']) {
        const raw = parsed.headers[key];
        if (raw !== undefined) decodedHeaders[key] = decodeHeaderValue(raw);
      }
      return {
        ...header,
        snippet: makeSnippet(parsed.body.text),
        body: parsed.body,
        attachments: parsed.attachments,
        headers: decodedHeaders,
      };
    });
  }

  search(
    folder: string,
    criteria: { text?: string; from?: string; subject?: string; since?: string; unreadOnly?: boolean },
    limit?: number,
  ): Promise<number[]> {
    return this.serialized(async () => {
      await this.ensureConnected();
      await this.ensureSelected(folder);
      const parts: string[] = [];
      const input = criteria ?? {};
      if (input.unreadOnly) parts.push('UNSEEN');
      if (typeof input.text === 'string' && input.text.trim()) parts.push(`TEXT ${quoteImapString(input.text)}`);
      if (typeof input.from === 'string' && input.from.trim()) parts.push(`FROM ${quoteImapString(input.from)}`);
      if (typeof input.subject === 'string' && input.subject.trim()) {
        parts.push(`SUBJECT ${quoteImapString(input.subject)}`);
      }
      if (typeof input.since === 'string' && input.since.trim()) {
        const imapDate = formatImapDate(input.since);
        if (imapDate) parts.push(`SINCE ${imapDate}`);
      }
      if (parts.length === 0) parts.push('ALL');

      const response = await this.command(`UID SEARCH ${parts.join(' ')}`, '搜索邮件');
      let uids = decodeSearchUids(response);
      const effectiveLimit = normalizeLimit(limit, 0);
      if (effectiveLimit > 0 && uids.length > effectiveLimit) {
        uids = uids.slice(uids.length - effectiveLimit);
      }
      return uids;
    });
  }

  markSeen(folder: string, uid: number): Promise<void> {
    return this.serialized(async () => {
      await this.ensureConnected();
      await this.ensureSelected(folder);
      const targetUid = Math.floor(Number(uid));
      if (!Number.isFinite(targetUid) || targetUid <= 0) {
        throw new MailError('protocol', 'IMAP 邮件 UID 无效', { hint: '刷新邮件列表后重试' });
      }
      await this.command(`UID STORE ${targetUid} +FLAGS (\\Seen)`, '标记已读');
    });
  }

  logout(): Promise<void> {
    return this.serialized(async () => {
      const socket = this.socket;
      if (!socket || !this.connected) {
        this.teardownConnection(null);
        return;
      }
      try {
        await this.command('LOGOUT', '退出');
      } catch {
        // LOGOUT 失败无所谓：连接反正要关掉
      }
      this.teardownConnection(null);
    });
  }

  // ───────────── 连接管理 ─────────────

  private commandTimeoutMs(): number {
    const value = this.options.timeoutMs;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
    return DEFAULT_TIMEOUT_MS;
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected && this.authenticated && this.socket && !this.socket.destroyed) return;
    await this.openConnection();
  }

  private async openConnection(): Promise<void> {
    this.teardownConnection(null);
    const options = this.options;
    if (!options.secure && options.allowPlaintext !== true) {
      throw new MailError('tls', 'IMAP 明文连接未被允许', {
        hint: '仅测试环境可显式开启 allowPlaintext；正式配置请使用隐式 TLS（993）',
      });
    }
    if (!options.host || typeof options.host !== 'string') {
      throw new MailError('connect', 'IMAP 主机未配置', { hint: '检查配置里的 imapHost' });
    }
    if (!Number.isFinite(options.port) || options.port <= 0) {
      throw new MailError('connect', 'IMAP 端口无效', { hint: '检查配置里的 imapPort（隐式 TLS 通常是 993）' });
    }

    try {
      const socket = options.secure
        ? tlsConnect(
            isIP(options.host)
              ? { host: options.host, port: options.port }
              : { host: options.host, port: options.port, servername: options.host },
          )
        : netConnect({ host: options.host, port: options.port });
      this.socket = socket;
      await this.waitForSocketReady(socket);

      this.connected = true;
      socket.on('data', (chunk: Buffer) => {
        if (this.socket !== socket) return;
        this.handleData(chunk);
      });
      socket.on('error', (error: Error) => {
        if (this.socket !== socket) return;
        this.teardownConnection(this.mapRuntimeError(error));
      });
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.teardownConnection(
          new MailError('dropped', 'IMAP 连接已断开', { hint: '检查网络后重试' }),
        );
      });

      const greeting = await this.readGreeting();
      if (/^\* BYE\b/i.test(greeting.text)) {
        throw new MailError('dropped', 'IMAP 服务器拒绝连接', {
          hint: '检查网络/代理/主机端口',
          detail: greeting.text,
        });
      }
      if (!/^\* (OK|PREAUTH)\b/i.test(greeting.text)) {
        throw new MailError('protocol', 'IMAP 问候响应异常', {
          hint: '检查主机端口是否指向 IMAP 服务',
          detail: greeting.text,
        });
      }

      try {
        const capabilityResponse = await this.command('CAPABILITY', '获取服务器能力');
        this.capabilities = extractCapabilities(capabilityResponse);
      } catch {
        // 少数服务器不允许登录前 CAPABILITY；不致命，继续登录
        this.capabilities = [];
      }

      const user = String(options.user ?? '');
      const pass = String(options.pass ?? '');
      if (!user || !pass) {
        throw new MailError('auth', 'IMAP 账号或授权码为空', { hint: '在配置里填写邮箱地址与授权码' });
      }
      if (/[\r\n]/.test(user) || /[\r\n]/.test(pass)) {
        throw new MailError('auth', 'IMAP 凭据含非法字符', { hint: '检查邮箱地址与授权码，不要带换行' });
      }
      await this.command(`LOGIN ${quoteImapString(user)} ${quoteImapString(pass)}`, '登录');
      this.authenticated = true;
      this.selectedFolder = null;
      this.selectedInfo = null;
    } catch (error) {
      this.teardownConnection(null);
      throw error;
    }
  }

  private waitForSocketReady(socket: Socket | TLSSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: MailError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeListener('error', onError);
        if (error) {
          try {
            socket.destroy();
          } catch {
            // 忽略
          }
          reject(error);
        } else {
          resolve();
        }
      };
      const onError = (error: Error): void => finish(this.mapConnectError(error));
      const timer = setTimeout(
        () => finish(new MailError('timeout', 'IMAP 连接超时', { hint: '检查网络/代理/主机端口' })),
        this.commandTimeoutMs(),
      );
      socket.once('error', onError);
      if (this.options.secure) {
        (socket as TLSSocket).once('secureConnect', () => finish());
      } else {
        socket.once('connect', () => finish());
      }
    });
  }

  private mapConnectError(error: unknown): MailError {
    const code = getErrorCode(error);
    const detail = describeError(error);
    if (TCP_ERROR_CODES.has(code)) {
      // TLS 连接里被重置/写失败发生在握手阶段 → tls；其余 TCP/DNS 错误 → connect
      const handshakeReset = this.options.secure && (code === 'ECONNRESET' || code === 'EPIPE');
      if (!handshakeReset) {
        return new MailError('connect', '无法连接 IMAP 服务器', {
          hint: '检查网络/代理/主机端口是否正确',
          detail,
        });
      }
    }
    return new MailError('tls', 'IMAP TLS 握手失败', {
      hint: '检查主机名、证书或网络代理；正式连接应为隐式 TLS',
      detail,
    });
  }

  private mapRuntimeError(error: unknown): MailError {
    return new MailError('dropped', 'IMAP 连接中断', {
      hint: '检查网络后重试；不要立刻反复重试',
      detail: describeError(error),
    });
  }

  private teardownConnection(error: MailError | null): void {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.authenticated = false;
    this.selectedFolder = null;
    this.selectedInfo = null;
    this.buffer = Buffer.alloc(0);
    this.unsolicited = [];
    if (socket) {
      socket.removeAllListeners('data');
      socket.removeAllListeners('close');
      socket.removeAllListeners('error');
      socket.on('error', () => {
        // 销毁过程中的错误忽略
      });
      try {
        socket.destroy();
      } catch {
        // 忽略
      }
    }
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new MailError('dropped', 'IMAP 连接中断', { hint: '检查网络后重试' }));
    }
    const greeting = this.greetingWaiter;
    this.greetingWaiter = null;
    if (greeting) {
      greeting.reject(error ?? new MailError('dropped', 'IMAP 连接中断', { hint: '检查网络后重试' }));
    }
  }

  // ───────────── 响应读取 ─────────────

  private handleData(chunk: Buffer): void {
    if (!Buffer.isBuffer(chunk)) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      this.teardownConnection(new MailError('protocol', 'IMAP 响应过大', { hint: '换一个文件夹或稍后重试' }));
      return;
    }
    this.pump();
  }

  private readGreeting(): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.greetingWaiter) return;
        const waiter = this.greetingWaiter;
        this.greetingWaiter = null;
        waiter.reject(new MailError('timeout', 'IMAP 等待服务器问候超时', { hint: '检查网络或服务器端口' }));
      }, this.commandTimeoutMs());
      this.greetingWaiter = {
        resolve: (response: Response) => {
          clearTimeout(timer);
          this.greetingWaiter = null;
          resolve(response);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          this.greetingWaiter = null;
          reject(error);
        },
      };
      this.pump();
    });
  }

  /** 从缓冲区里取一个完整响应（处理 literal `{n}` 与跨包）。取不到返回 null。 */
  private takeResponse(): Response | null {
    let position = 0;
    let text = '';
    const literals: Buffer[] = [];
    for (;;) {
      const newline = this.buffer.indexOf(0x0a, position);
      if (newline < 0) return null;
      let lineEnd = newline;
      if (lineEnd > position && this.buffer[lineEnd - 1] === 0x0d) lineEnd -= 1;
      const line = this.buffer.toString('latin1', position, lineEnd);
      const literalMatch = /\{(\d+)\}$/.exec(line);
      if (literalMatch) {
        const size = Number(literalMatch[1]);
        const literalStart = newline + 1;
        if (this.buffer.length < literalStart + size) return null;
        text += line.slice(0, line.length - literalMatch[0].length);
        literals.push(this.buffer.subarray(literalStart, literalStart + size));
        text += `\u0000L${literals.length - 1}\u0000`;
        position = literalStart + size;
        continue;
      }
      text += line;
      position = newline + 1;
      break;
    }
    this.buffer = this.buffer.subarray(position);
    return { text, literals };
  }

  private pump(): void {
    for (;;) {
      const response = this.takeResponse();
      if (!response) return;
      this.dispatch(response);
    }
  }

  private dispatch(response: Response): void {
    const text = response.text;
    if (text.startsWith('+')) {
      const pending = this.pending;
      if (pending) {
        pending.continuations.push(text);
        let reply = '';
        try {
          reply = pending.onContinuation?.(text) ?? '';
        } catch {
          reply = '';
        }
        try {
          this.socket?.write(`${reply}\r\n`);
        } catch {
          // 忽略：写失败会走 close/error 分支
        }
        return;
      }
      return;
    }
    const tagged = /^(A\d+)\s+(OK|NO|BAD)\b/i.exec(text);
    if (tagged) {
      const pending = this.pending;
      if (pending && pending.tag === tagged[1]) {
        this.settlePending(response, tagged[2].toUpperCase() as ResponseStatus);
      } else {
        this.pushUnsolicited(response);
      }
      return;
    }
    if (text.startsWith('*')) {
      const pending = this.pending;
      if (pending) pending.untagged.push(response);
      else if (this.greetingWaiter) this.greetingWaiter.resolve(response);
      else this.pushUnsolicited(response);
      return;
    }
    if (this.greetingWaiter) this.greetingWaiter.resolve(response);
    else this.pushUnsolicited(response);
  }

  private pushUnsolicited(response: Response): void {
    this.unsolicited.push(response);
    if (this.unsolicited.length > MAX_UNSOLICITED) this.unsolicited.shift();
  }

  private settlePending(response: Response, status: ResponseStatus): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    if (status === 'OK') pending.resolve({ ...response, untagged: pending.untagged });
    else pending.reject(this.commandFailure(pending.label, status, response));
  }

  private commandFailure(label: string, status: ResponseStatus, response: Response): MailError {
    const detail = response.text;
    if (label === '登录') {
      return new MailError('auth', 'IMAP 登录被拒', {
        hint: '检查邮箱地址与授权码；QQ 邮箱需先在设置里开启 IMAP/SMTP 服务并生成授权码',
        detail,
      });
    }
    return new MailError('protocol', `IMAP ${label}被服务器拒绝`, {
      hint: '检查文件夹名写法或服务器是否支持该命令',
      detail: status === 'BAD' ? `${status} ${detail}` : `${status} ${detail}`,
    });
  }

  private command(
    text: string,
    label: string,
    options?: { onContinuation?: (line: string) => string | void },
  ): Promise<CommandResult> {
    const socket = this.socket;
    if (!socket || !this.connected) {
      return Promise.reject(new MailError('connect', 'IMAP 连接尚未建立', { hint: '检查网络/主机端口' }));
    }
    if (this.pending) {
      return Promise.reject(
        new MailError('protocol', 'IMAP 上一条命令尚未完成', { detail: `pending=${this.pending.label}` }),
      );
    }
    const tag = `A${++this.tagCounter}`;
    return new Promise<CommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.tag !== tag) return;
        this.teardownConnection(
          new MailError('timeout', `IMAP ${label}超时`, {
            hint: '检查网络或服务器端口；不要立刻反复重试',
            detail: `timeout after ${this.commandTimeoutMs()}ms`,
          }),
        );
      }, this.commandTimeoutMs());
      this.pending = {
        tag,
        label,
        resolve,
        reject,
        timer,
        untagged: [],
        continuations: [],
        onContinuation: options?.onContinuation,
      };
      try {
        socket.write(`${tag} ${text}\r\n`);
      } catch (error) {
        const pending = this.pending;
        this.pending = null;
        clearTimeout(timer);
        pending?.reject(
          new MailError('dropped', 'IMAP 发送命令失败', { hint: '检查网络后重试', detail: describeError(error) }),
        );
      }
    });
  }

  // ───────────── 命令封装 ─────────────

  private async selectInternal(folder: string): Promise<ImapSelectInfo> {
    const response = await this.command(`SELECT ${quoteImapMailbox(folder)}`, '选择文件夹');
    const info: ImapSelectInfo = { exists: 0, uidValidity: 0, uidNext: 0 };
    for (const item of [...response.untagged, response]) {
      const existsMatch = /^\* (\d+) EXISTS\b/i.exec(item.text);
      if (existsMatch) info.exists = Number(existsMatch[1]);
      const validityMatch = /\[UIDVALIDITY\s+(\d+)\]/i.exec(item.text);
      if (validityMatch) info.uidValidity = Number(validityMatch[1]);
      const nextMatch = /\[UIDNEXT\s+(\d+)\]/i.exec(item.text);
      if (nextMatch) info.uidNext = Number(nextMatch[1]);
    }
    this.selectedFolder = folder;
    this.selectedInfo = info;
    return info;
  }

  private async ensureSelected(folder: string): Promise<ImapSelectInfo> {
    const name = typeof folder === 'string' && folder ? folder : 'INBOX';
    if (this.selectedFolder === name && this.selectedInfo) return this.selectedInfo;
    return this.selectInternal(name);
  }

  private async searchUnseenUids(): Promise<number[]> {
    const response = await this.command('UID SEARCH UNSEEN', '搜索邮件');
    return decodeSearchUids(response);
  }
}

/** 创建 IMAP 客户端；同一实例串行执行命令，连接失败后下一条命令自动重连。 */
export function createImapClient(options: ImapOptions): ImapClient {
  return new ImapConnection(options);
}

/** 便于测试/诊断：读取当前客户端能力列表（非契约接口，保留给 W1 测试用）。 */
export function getImapCapabilities(client: ImapClient): string[] {
  const internal = client as unknown as { capabilities?: string[] };
  return Array.isArray(internal.capabilities) ? [...internal.capabilities] : [];
}
