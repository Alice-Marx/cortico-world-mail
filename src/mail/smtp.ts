/**
 * cortico-world-mail · 自写 SMTP 客户端（PLAN.md §3.3，W1 独占文件）。
 *
 * 零第三方依赖：node:net、node:tls、node:buffer、node:crypto。
 * 流程：EHLO（多行）→ [STARTTLS] → AUTH LOGIN（服务器只给 AUTH PLAIN 时用 PLAIN）→
 *      MAIL FROM → RCPT TO（逐个收集 250/251，5xx 进 rejected）→
 *      DATA（dot-stuffing、CRLF 规范化、`\r\n.\r\n` 结束）→ QUIT。
 *
 * 失败按 PLAN §6 分类并抛 MailError（SMTP 登录被拒也归 auth）；
 * `message` 只说类别与关键事实，服务器原文只进 `detail`。
 * `send()` 内部惰性建连（契约没有 connect）；一次 send 成功后连接保持复用，`close()` 幂等。
 */

import { Buffer } from 'node:buffer';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { MailError } from './types.ts';
import type {
  MailAddress,
  OutgoingMessage,
  SendDraft,
  SendResult,
  SmtpClient,
  SmtpOptions,
} from './types.ts';
import { buildMime } from './mime.ts';

// 类型从契约文件转出：调用方既可以从 types.ts 也可以从本文件 import。
export type { MailAddress, OutgoingMessage, SendDraft, SendResult, SmtpClient, SmtpOptions } from './types.ts';

// ───────────────────────── 常量 ─────────────────────────

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
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

interface SmtpResponse {
  code: number;
  lines: string[];
  text: string;
}

interface Waiter {
  lines: string[];
  resolve: (response: SmtpResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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

function normalizeTimeout(value: number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  return DEFAULT_TIMEOUT_MS;
}

/** 信封地址清洗：去 CRLF/空白/尖括号，防止命令行注入。 */
function envelopeAddress(value: unknown): string {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>]/g, '')
    .trim();
}

function normalizeSecure(options: SmtpOptions): 'implicit' | 'starttls' | false {
  const secure = options?.secure;
  if (secure === 'implicit' || secure === 'starttls' || secure === false) return secure;
  return 'implicit';
}

function parseEhloCapabilities(lines: string[]): string[] {
  const capabilities: string[] = [];
  for (const line of lines) {
    const match = /^\d{3}[ -](.*)$/.exec(line);
    if (!match) continue;
    const value = match[1].trim();
    if (value) capabilities.push(value.toUpperCase());
  }
  return capabilities;
}

/**
 * DATA 阶段内容准备：CRLF 规范化 + dot-stuffing + `\r\n.\r\n` 结束符。
 * 单独导出便于测试（也方便 W3 诊断“发出去的字节到底是什么”）。
 */
export function prepareSmtpData(rawMessage: string): string {
  const normalized = String(rawMessage ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const stuffed = normalized.split('\n').map((line) => (line.startsWith('.') ? `.${line}` : line));
  let text = stuffed.join('\r\n');
  if (!text.endsWith('\r\n')) text += '\r\n';
  return `${text}.\r\n`;
}

// ───────────────────────── 客户端实现 ─────────────────────────

class SmtpConnection implements SmtpClient {
  private readonly options: SmtpOptions;

  private socket: Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private connected = false;
  private authenticated = false;
  private capabilities: string[] = [];
  private waiters: Waiter[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: SmtpOptions) {
    this.options = options && typeof options === 'object' ? options : ({} as SmtpOptions);
  }

  // ───────────── 公共 API ─────────────

  send(message: OutgoingMessage): Promise<SendResult> {
    return this.serialized(async () => {
      try {
        await this.ensureConnected();
        return await this.sendInternal(message);
      } catch (error) {
        if (this.socket) this.teardownConnection(null);
        throw error;
      }
    });
  }

  close(): Promise<void> {
    return this.serialized(async () => {
      if (this.socket && this.connected) {
        try {
          await this.command('QUIT', '退出', [221]);
        } catch {
          // QUIT 失败无所谓：连接反正要关
        }
      }
      this.teardownConnection(null);
    });
  }

  // ───────────── 连接管理 ─────────────

  private timeoutMs(): number {
    return normalizeTimeout(this.options.timeoutMs);
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
    const mode = normalizeSecure(options);
    if (mode === false && options.allowPlaintext !== true) {
      throw new MailError('tls', 'SMTP 明文连接未被允许', {
        hint: '仅测试环境可显式开启 allowPlaintext；正式配置请使用 implicit(465) 或 starttls(587)',
      });
    }
    if (!options.host || typeof options.host !== 'string') {
      throw new MailError('connect', 'SMTP 主机未配置', { hint: '检查配置里的 smtpHost' });
    }
    if (!Number.isFinite(options.port) || options.port <= 0) {
      throw new MailError('connect', 'SMTP 端口无效', { hint: '检查配置里的 smtpPort（465 隐式 TLS / 587 STARTTLS）' });
    }

    try {
      if (mode === 'implicit') {
        const socket = tlsConnect(
          isIP(options.host)
            ? { host: options.host, port: options.port }
            : { host: options.host, port: options.port, servername: options.host },
        );
        this.socket = socket;
        await this.waitForSocketReady(socket, true);
        this.connected = true;
        this.attachSocket(socket);
      } else {
        const socket = netConnect({ host: options.host, port: options.port });
        this.socket = socket;
        await this.waitForSocketReady(socket, false);
        this.connected = true;
        this.attachSocket(socket);
      }

      const greeting = await this.readResponse('连接');
      if (greeting.code !== 220) {
        throw new MailError('protocol', 'SMTP 服务未就绪', {
          hint: '检查主机端口是否指向 SMTP 服务',
          detail: greeting.text,
        });
      }

      await this.ehlo();

      if (mode === 'starttls') {
        if (!this.supportsCapability('STARTTLS')) {
          throw new MailError('tls', 'SMTP 服务器不支持 STARTTLS', {
            hint: '改用 465 隐式 TLS，或检查主机端口配置',
          });
        }
        await this.command('STARTTLS', 'STARTTLS', [220]);
        const plainSocket = this.socket;
        if (!plainSocket) {
          throw new MailError('tls', 'SMTP STARTTLS 升级失败', { hint: '检查网络后重试' });
        }
        this.detachSocket(plainSocket);
        await this.upgradeToTls(plainSocket);
        this.buffer = Buffer.alloc(0);
        await this.ehlo();
      }

      await this.authenticate();
      this.authenticated = true;
    } catch (error) {
      this.teardownConnection(null);
      throw error;
    }
  }

  private waitForSocketReady(socket: Socket, secure: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => finish(new MailError('timeout', 'SMTP 连接超时', { hint: '检查网络/代理/主机端口' })),
        this.timeoutMs(),
      );
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
      const onError = (error: Error): void => finish(this.mapConnectError(error, secure));
      socket.once('error', onError);
      if (secure) (socket as TLSSocket).once('secureConnect', () => finish());
      else socket.once('connect', () => finish());
    });
  }

  private async upgradeToTls(plainSocket: Socket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const secureSocket = tlsConnect(
        isIP(this.options.host)
          ? { socket: plainSocket }
          : { socket: plainSocket, servername: this.options.host },
      );
      const timer = setTimeout(
        () => finish(new MailError('timeout', 'SMTP TLS 握手超时', { hint: '检查网络/代理设置' })),
        this.timeoutMs(),
      );
      const finish = (error?: MailError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        secureSocket.removeListener('error', onError);
        if (error) {
          try {
            secureSocket.destroy();
          } catch {
            // 忽略
          }
          reject(error);
          return;
        }
        resolve();
      };
      const onError = (error: Error): void =>
        finish(
          new MailError('tls', 'SMTP TLS 握手失败', {
            hint: '检查主机名、证书或网络代理',
            detail: describeError(error),
          }),
        );
      secureSocket.once('error', onError);
      secureSocket.once('secureConnect', () => {
        this.socket = secureSocket;
        this.attachSocket(secureSocket);
        finish();
      });
    });
  }

  private mapConnectError(error: unknown, secure: boolean): MailError {
    const code = getErrorCode(error);
    const detail = describeError(error);
    if (TCP_ERROR_CODES.has(code)) {
      return new MailError('connect', '无法连接 SMTP 服务器', {
        hint: '检查网络/代理/主机端口是否正确',
        detail,
      });
    }
    if (secure) {
      return new MailError('tls', 'SMTP TLS 握手失败', {
        hint: '检查主机名、证书或网络代理；正式连接应为隐式 TLS 或 STARTTLS',
        detail,
      });
    }
    return new MailError('connect', '无法连接 SMTP 服务器', {
      hint: '检查网络/代理/主机端口是否正确',
      detail,
    });
  }

  private mapRuntimeError(error: unknown): MailError {
    return new MailError('dropped', 'SMTP 连接中断', {
      hint: '检查网络后重试；不要立刻反复重试',
      detail: describeError(error),
    });
  }

  private attachSocket(socket: Socket): void {
    socket.on('data', (chunk: Buffer) => {
      if (this.socket !== socket) return;
      if (!Buffer.isBuffer(chunk)) return;
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > MAX_BUFFER_BYTES) {
        this.teardownConnection(new MailError('protocol', 'SMTP 响应过大', { hint: '检查服务器或网络' }));
        return;
      }
      this.pump();
    });
    socket.on('error', (error: Error) => {
      if (this.socket !== socket) return;
      this.teardownConnection(this.mapRuntimeError(error));
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.teardownConnection(new MailError('dropped', 'SMTP 连接已断开', { hint: '检查网络后重试' }));
    });
  }

  private detachSocket(socket: Socket): void {
    socket.removeAllListeners('data');
    socket.removeAllListeners('error');
    socket.removeAllListeners('close');
    socket.on('error', () => {
      // TLS 升级过程中的错误由 TLS socket 处理
    });
  }

  private teardownConnection(error: MailError | null): void {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.authenticated = false;
    this.capabilities = [];
    this.buffer = Buffer.alloc(0);
    if (socket) {
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      socket.removeAllListeners('close');
      socket.on('error', () => {
        // 销毁过程中的错误忽略
      });
      try {
        socket.destroy();
      } catch {
        // 忽略
      }
    }
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error ?? new MailError('dropped', 'SMTP 连接中断', { hint: '检查网络后重试' }));
    }
  }

  // ───────────── 响应读取 ─────────────

  private pump(): void {
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      let lineEnd = newline;
      if (lineEnd > 0 && this.buffer[lineEnd - 1] === 0x0d) lineEnd -= 1;
      const line = this.buffer.toString('latin1', 0, lineEnd);
      const waiter = this.waiters[0];
      if (!waiter) return; // 没有等待者时保留未消费数据（下一次 readResponse 再处理）
      this.buffer = this.buffer.subarray(newline + 1);
      waiter.lines.push(line);
      const final = /^(\d{3})(?: ([\s\S]*))?$/.exec(line);
      if (final) {
        this.waiters.shift();
        clearTimeout(waiter.timer);
        waiter.resolve({ code: Number(final[1]), lines: waiter.lines.slice(), text: waiter.lines.join('\n') });
      }
    }
  }

  private readResponse(label: string): Promise<SmtpResponse> {
    return new Promise<SmtpResponse>((resolve, reject) => {
      const waiter: Waiter = {
        lines: [],
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          const error = new MailError('timeout', `SMTP ${label}超时`, {
            hint: '检查网络或服务器端口；不要立刻反复重试',
            detail: `timeout after ${this.timeoutMs()}ms`,
          });
          waiter.reject(error);
          this.teardownConnection(error);
        }, this.timeoutMs()),
      };
      this.waiters.push(waiter);
      this.pump();
    });
  }

  private async exchange(text: string, label: string): Promise<SmtpResponse> {
    const socket = this.socket;
    if (!socket || !this.connected) {
      throw new MailError('connect', 'SMTP 连接尚未建立', { hint: '检查网络/主机端口' });
    }
    try {
      socket.write(`${text}\r\n`);
    } catch (error) {
      throw new MailError('dropped', 'SMTP 发送命令失败', {
        hint: '检查网络后重试',
        detail: describeError(error),
      });
    }
    return this.readResponse(label);
  }

  private async command(text: string, label: string, expected: number[]): Promise<SmtpResponse> {
    const response = await this.exchange(text, label);
    if (!expected.includes(response.code)) throw this.responseFailure(label, response);
    return response;
  }

  private responseFailure(label: string, response: SmtpResponse): MailError {
    return new MailError('protocol', `SMTP ${label}被服务器拒绝`, {
      hint: '按回执提示处理；检查发件人/收件人地址或服务器策略',
      detail: `code=${response.code} ${response.text}`,
    });
  }

  // ───────────── EHLO / AUTH ─────────────

  private async ehlo(): Promise<SmtpResponse> {
    this.capabilities = [];
    try {
      const response = await this.command('EHLO localhost', 'EHLO', [250]);
      this.capabilities = parseEhloCapabilities(response.lines);
      return response;
    } catch (error) {
      if (error instanceof MailError && error.code === 'protocol') {
        // 老服务器只认 HELO
        const response = await this.command('HELO localhost', 'HELO', [250]);
        this.capabilities = [];
        return response;
      }
      throw error;
    }
  }

  private supportsCapability(name: string): boolean {
    return this.capabilities.some((capability) => capability === name || capability.startsWith(`${name} `));
  }

  private authMechanisms(): string[] {
    const mechanisms = new Set<string>();
    for (const capability of this.capabilities) {
      if (capability.startsWith('AUTH=')) {
        for (const item of capability.slice(5).split(/\s+/)) if (item) mechanisms.add(item);
      } else if (capability.startsWith('AUTH ')) {
        for (const item of capability.slice(5).split(/\s+/)) if (item) mechanisms.add(item);
      }
    }
    return [...mechanisms];
  }

  private async authenticate(): Promise<void> {
    const user = String(this.options.user ?? '');
    const pass = String(this.options.pass ?? '');
    if (!user || !pass) {
      throw new MailError('auth', 'SMTP 账号或授权码为空', { hint: '在配置里填写邮箱地址与授权码' });
    }
    if (/[\r\n]/.test(user) || /[\r\n]/.test(pass)) {
      throw new MailError('auth', 'SMTP 凭据含非法字符', { hint: '检查邮箱地址与授权码，不要带换行' });
    }
    const mechanisms = this.authMechanisms();
    const hasLogin = mechanisms.includes('LOGIN');
    const hasPlain = mechanisms.includes('PLAIN');
    const preferLogin = hasLogin || !hasPlain;

    if (preferLogin) {
      try {
        await this.withAuthErrors(() => this.authLogin(user, pass));
        return;
      } catch (error) {
        // 服务器不认识 AUTH LOGIN（5xx）但支持 PLAIN 时退一步用 PLAIN
        if (error instanceof MailError && error.code === 'protocol' && hasPlain) {
          await this.withAuthErrors(() => this.authPlain(user, pass));
          return;
        }
        throw error;
      }
    }
    await this.withAuthErrors(() => this.authPlain(user, pass));
  }

  private async withAuthErrors<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MailError && error.code === 'protocol') {
        throw new MailError('auth', 'SMTP 登录被拒', {
          hint: '检查邮箱地址与授权码；QQ 邮箱需先在设置里开启 SMTP 服务并生成授权码',
          detail: error.detail ?? error.message,
        });
      }
      throw error;
    }
  }

  private async authLogin(user: string, pass: string): Promise<void> {
    await this.command('AUTH LOGIN', '登录', [334]);
    await this.command(Buffer.from(user, 'utf8').toString('base64'), '登录', [334]);
    await this.command(Buffer.from(pass, 'utf8').toString('base64'), '登录', [235]);
  }

  private async authPlain(user: string, pass: string): Promise<void> {
    const payload = Buffer.from(`\u0000${user}\u0000${pass}`, 'utf8').toString('base64');
    const response = await this.command(`AUTH PLAIN ${payload}`, '登录', [235, 334]);
    if (response.code === 334) await this.command(payload, '登录', [235]);
  }

  // ───────────── 发信 ─────────────

  private async sendInternal(message: OutgoingMessage): Promise<SendResult> {
    const source = message && typeof message === 'object' ? message : ({} as OutgoingMessage);
    const fromAddress = envelopeAddress(source.from?.address);
    if (!fromAddress) {
      throw new MailError('protocol', '缺少发件人地址', { hint: '检查配置里的邮箱地址' });
    }
    const targets: string[] = [];
    const seen = new Set<string>();
    const addressLists: unknown[] = [source.to, source.cc, source.bcc];
    for (const list of addressLists) {
      if (!Array.isArray(list)) continue;
      for (const address of list) {
        const value = envelopeAddress(address?.address);
        if (!value) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push(value);
      }
    }
    if (targets.length === 0) {
      throw new MailError('protocol', '没有有效收件人', { hint: '检查收件人地址格式' });
    }

    const mime = buildMime(source);
    const messageIdMatch = /^message-id:\s*(<[^>]+>)/im.exec(mime);
    const messageId = messageIdMatch ? messageIdMatch[1] : '';

    await this.command(`MAIL FROM:<${fromAddress}>`, '发件人', [250]);

    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const target of targets) {
      const response = await this.exchange(`RCPT TO:<${target}>`, '收件人');
      if (response.code >= 200 && response.code < 300) {
        accepted.push(target);
      } else if (response.code === 421) {
        // 服务正在关闭：后续命令也别试了，按连接中断处理
        throw new MailError('dropped', 'SMTP 服务器正在关闭连接', {
          hint: '稍后重试；不要立刻反复重试',
          detail: `code=421 ${response.text}`,
        });
      } else {
        rejected.push(target);
      }
    }

    if (accepted.length === 0) {
      try {
        await this.exchange('RSET', '重置');
      } catch {
        // 忽略
      }
      return { accepted, rejected, messageId };
    }

    await this.command('DATA', '发信数据', [354]);
    const socket = this.socket;
    if (!socket) throw new MailError('dropped', 'SMTP 连接中断', { hint: '检查网络后重试' });
    try {
      socket.write(prepareSmtpData(mime));
    } catch (error) {
      throw new MailError('dropped', 'SMTP 发送内容失败', {
        hint: '检查网络后重试',
        detail: describeError(error),
      });
    }
    const result = await this.readResponse('发信数据');
    if (result.code !== 250 && result.code !== 251) throw this.responseFailure('发信数据', result);

    return { accepted, rejected, messageId };
  }
}

// ───────────────────────── 工厂 / 便捷构造 ─────────────────────────

/** 创建 SMTP 客户端；send() 惰性建连并在多次 send 之间复用连接，close() 幂等。 */
export function createSmtpClient(options: SmtpOptions): SmtpClient {
  return new SmtpConnection(options);
}

/**
 * 由工具层草稿构造 OutgoingMessage：
 * - to 原样；cc/bcc 缺省 []；date/messageId 由 options 注入（保证测试确定性）；
 * - inReplyTo/references/html 透传；
 * - SendDraft.replyTo 在 OutgoingMessage 契约里没有对应字段，本版忽略（不写 Reply-To 头）。
 */
export function buildOutgoingMessage(
  draft: SendDraft,
  from: MailAddress,
  options?: { date?: Date; messageId?: string },
): OutgoingMessage {
  const input = draft && typeof draft === 'object' ? draft : ({} as SendDraft);
  const outgoing: OutgoingMessage = {
    from: {
      name: String(from?.name ?? ''),
      address: String(from?.address ?? ''),
    },
    to: Array.isArray(input.to) ? [...input.to] : [],
    cc: Array.isArray(input.cc) ? [...input.cc] : [],
    bcc: Array.isArray(input.bcc) ? [...input.bcc] : [],
    subject: String(input.subject ?? ''),
    text: String(input.text ?? ''),
  };
  if (input.html !== undefined) outgoing.html = input.html;
  if (options?.date instanceof Date) outgoing.date = options.date;
  if (typeof options?.messageId === 'string' && options.messageId) outgoing.messageId = options.messageId;
  if (typeof input.inReplyTo === 'string' && input.inReplyTo) outgoing.inReplyTo = input.inReplyTo;
  if (Array.isArray(input.references) && input.references.length > 0) {
    outgoing.references = [...input.references];
  }
  return outgoing;
}
