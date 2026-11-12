/**
 * 真邮箱 Mailbox（PLAN §3.6）：IMAP 读 + SMTP 发，协议层全在 W1 的 imap.ts / smtp.ts。
 *
 * 三件事是这个文件自己的：
 * 1. **惰性连接**：构造 createLiveMailbox 不建任何连接；第一条命令才连。连接失败后丢弃这一代的
 *    client，**下一条命令重新建连再试一次**（不会卡死在第一次失败上）。
 * 2. **原样上抛 W1 的 MailError**：这里只记 lastError 供 status() 用，绝不改写 code/message
 *    （分类由 tools/receipt.ts 按 code 做，服务器原文只可能在 MailError.detail，且只在 world 日志里）。
 * 3. **可选能力**：`markSeen(folder, uid)` 与 `selectInfo(folder)` 不是 Mailbox 主接口的成员
 *    （PLAN §3.1 不许改），这里作为可选成员挂在返回对象上；world 用交叉类型探测后再调用。
 *
 * 依赖方向：live → {imap, smtp, types}；world 只 import type 或 createLiveMailbox。
 */
import type {
  FetchRange,
  ImapClient,
  ImapOptions,
  ImapSelectInfo,
  ListOptions,
  MailAddress,
  Mailbox,
  MailboxStatus,
  MailFailure,
  MailHeader,
  MailMessage,
  SearchOptions,
  SendDraft,
  SendResult,
  SmtpClient,
  SmtpOptions,
} from './types.ts';
import { MailError } from './types.ts';
import { createImapClient } from './imap.ts';
import { buildOutgoingMessage, createSmtpClient } from './smtp.ts';

/** PLAN §3.6 的公开签名。imapFactory/smtpFactory 只给测试注入，生产传空。 */
export interface LiveMailboxOptions {
  email: string;
  authCode: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  fromName: string;
  timeoutMs?: number;
  imapFactory?: (o: ImapOptions) => ImapClient;
  smtpFactory?: (o: SmtpOptions) => SmtpClient;
}

/** Mailbox 之外的可选能力：几代 live 实现都可能有，别把它们塞进主接口。 */
export interface LiveMailboxExtras {
  /** 把服务器上的这封标记为已读（只在 cfg.markSeenOnRead=true 时由 world 调用）。 */
  markSeen?(folder: string, uid: number): Promise<void>;
  /** 选一个文件夹，拿 UIDVALIDITY 与邮件总数（增量游标要它）。 */
  selectInfo?(folder: string): Promise<ImapSelectInfo>;
}

const DEFAULT_FOLDER = 'INBOX';
/** 单条命令的超时预算与 W1 的默认值一致。 */
const DEFAULT_TIMEOUT_MS = 15_000;

/** 这些失败说明「这一代连接已经不能用了」：丢掉它，下一条命令重新建连。 */
const RECONNECT_CODES: ReadonlySet<string> = new Set(['connect', 'tls', 'timeout', 'dropped']);

/** 数字参数夹取：非法值回默认，不把 NaN 传进协议层。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function folderOf(options?: { folder?: string }): string {
  const raw = String(options?.folder ?? '').trim();
  return raw === '' ? DEFAULT_FOLDER : raw;
}

/** 失败快照：只留 code/message/hint，detail（服务器原文）绝不进 status。 */
function failureOf(error: unknown): MailFailure {
  if (error instanceof MailError) {
    const failure: MailFailure = { code: error.code, message: error.message };
    if (typeof error.hint === 'string' && error.hint !== '') failure.hint = error.hint;
    return failure;
  }
  return { code: 'protocol', message: '邮箱操作失败（内部异常）。', hint: '具体原因看 data/logs/core.log。' };
}

/** 把意料之外的异常折成 MailError；W1 抛的 MailError 一律原样返回。 */
function asMailError(error: unknown, what: string): MailError {
  if (error instanceof MailError) return error;
  const name = error instanceof Error ? error.name : typeof error;
  return new MailError('protocol', '邮箱操作失败（' + what + '）。', {
    hint: '具体原因看 data/logs/core.log。',
    detail: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

function truncateText(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return text;
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)) + '…';
}

class LiveMailbox implements Mailbox, LiveMailboxExtras {
  readonly mode = 'live' as const;

  readonly #opts: LiveMailboxOptions;

  #imap: ImapClient | null = null;
  #connected = false;
  #folders: string[] = [];
  #lastSyncAt = '';
  #lastError: MailFailure | undefined;

  constructor(options: LiveMailboxOptions) {
    this.#opts = options;
  }

  // ───────────────────────── 连接管理 ─────────────────────────

  #imapOptions(): ImapOptions {
    return {
      host: this.#opts.imapHost,
      port: this.#opts.imapPort,
      secure: true,
      user: this.#opts.email,
      pass: this.#opts.authCode,
      timeoutMs: clampInt(this.#opts.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 120_000),
    };
  }

  #smtpOptions(): SmtpOptions {
    return {
      host: this.#opts.smtpHost,
      port: this.#opts.smtpPort,
      // QQ 邮箱 465 是隐式 TLS；PLAN §3.3 默认就是 implicit。587 的用户改端口后这里仍是 implicit，
      // 属于第一版已知限制（文档里写清：只支持 465 隐式 TLS）。
      secure: 'implicit',
      user: this.#opts.email,
      pass: this.#opts.authCode,
      timeoutMs: clampInt(this.#opts.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 120_000),
    };
  }

  /** 建立/复用 IMAP 连接。失败时丢掉半成品，下一条命令会重新建连再试一次。 */
  async #ensureImap(): Promise<ImapClient> {
    if (this.#imap !== null && this.#connected) return this.#imap;
    if (this.#imap !== null) await this.#dropImap();
    const factory = this.#opts.imapFactory ?? createImapClient;
    const client = factory(this.#imapOptions());
    try {
      await client.connect();
    } catch (error) {
      // 半成品必须收干净：不 logout 的话假服务器/真服务器都会留一个半开会话。
      try {
        await client.logout();
      } catch {
        // 连接本来就没建起来，logout 失败无所谓
      }
      const failure = asMailError(error, '连接邮件服务器');
      this.#lastError = failureOf(failure);
      throw failure;
    }
    this.#imap = client;
    this.#connected = true;
    this.#lastError = undefined;
    return client;
  }

  async #dropImap(): Promise<void> {
    const client = this.#imap;
    this.#imap = null;
    this.#connected = false;
    if (client !== null) {
      try {
        await client.logout();
      } catch {
        // 已经断了就算了：下一条命令会建新的
      }
    }
  }

  /**
   * 跑一条 IMAP 命令。失败时：
   * - W1 的 MailError 原样上抛；
   * - 连接类失败（connect/tls/timeout/dropped）丢掉这一代连接，下一条命令重试一次；
   * - 成功就把 lastError 清掉、刷新 lastSyncAt。
   */
  async #withImap<T>(what: string, fn: (client: ImapClient) => Promise<T>): Promise<T> {
    let client: ImapClient;
    try {
      client = await this.#ensureImap();
    } catch (error) {
      throw asMailError(error, what);
    }
    try {
      const result = await fn(client);
      this.#lastError = undefined;
      this.#lastSyncAt = new Date().toISOString();
      return result;
    } catch (error) {
      const failure = asMailError(error, what);
      this.#lastError = failureOf(failure);
      if (RECONNECT_CODES.has(failure.code)) await this.#dropImap();
      throw failure;
    }
  }

  // ───────────────────────── Mailbox ─────────────────────────

  async status(): Promise<MailboxStatus> {
    // 刻意不连：mail_status 必须「不联网也能答」（PLAN §5）。
    const state: MailboxStatus = {
      mode: 'live',
      connected: this.#connected && this.#imap !== null,
      account: this.#opts.email,
      folders: [...this.#folders],
      lastSyncAt: this.#lastSyncAt,
    };
    if (this.#lastError !== undefined) state.lastError = this.#lastError;
    return state;
  }

  async folders(): Promise<string[]> {
    const list = await this.#withImap('列出文件夹', (client) => client.folders());
    this.#folders = [...list];
    return [...list];
  }

  async list(options: ListOptions = {}): Promise<MailHeader[]> {
    const folder = folderOf(options);
    const limit = clampInt(options.limit, 20, 1, 100);
    const range: FetchRange = { limit };
    if (options.unreadOnly === true) range.unreadOnly = true;
    return this.#withImap('列出 ' + folder, (client) => client.fetchHeaders(folder, range));
  }

  async read(uid: number, options: { folder?: string; maxChars?: number } = {}): Promise<MailMessage> {
    const folder = folderOf(options);
    const key = Math.floor(Number(uid));
    if (!Number.isFinite(key) || key < 0) {
      throw new MailError('protocol', 'uid 要不是非负整数，现在是「' + String(uid) + '」。', {
        hint: 'uid 用 mail_list / mail_search 返回的那个数字。',
      });
    }
    const message = await this.#withImap('读 ' + folder + '#' + String(key), (client) => client.fetchMessage(folder, key));
    const maxChars = clampInt(options.maxChars, Number.POSITIVE_INFINITY, 1, 200_000);
    if (!Number.isFinite(maxChars)) return message;
    return {
      ...message,
      body: {
        text: truncateText(message.body.text, maxChars),
        html: truncateText(message.body.html, maxChars),
      },
    };
  }

  async search(options: SearchOptions): Promise<MailHeader[]> {
    const folder = folderOf(options);
    const query = String(options.query ?? '').trim();
    const limit = clampInt(options.limit, 10, 1, 100);
    if (query === '' && String(options.from ?? '').trim() === '' && String(options.subject ?? '').trim() === '') {
      return [];
    }
    return this.#withImap('搜索 ' + folder, async (client) => {
      // 服务器端 SEARCH 优先（PLAN §5）。criteria 由 W1 翻成 IMAP SEARCH 参数。
      const uids = await client.search(
        folder,
        {
          text: query,
          ...(String(options.from ?? '').trim() === '' ? {} : { from: String(options.from).trim() }),
          ...(String(options.subject ?? '').trim() === '' ? {} : { subject: String(options.subject).trim() }),
          ...(String(options.since ?? '').trim() === '' ? {} : { since: String(options.since).trim() }),
        },
        limit,
      );
      if (uids.length === 0) return [];
      // W1 的 search 返回 UID 升序（旧→新）；这里要最新在前。
      const wanted = [...uids].sort((a, b) => b - a).slice(0, limit);
      // 一次取一个足够大的头部窗口，命中不了（UID 太旧/被删）的再逐封补拉，最多 limit 封。
      const window = clampInt(Math.max(50, limit * 5), 50, 50, 200);
      const latest = await client.fetchHeaders(folder, { limit: window });
      const byUid = new Map<number, MailHeader>();
      for (const header of latest) byUid.set(header.uid, header);
      const out: MailHeader[] = [];
      for (const uid of wanted) {
        if (out.length >= limit) break;
        const header = byUid.get(uid);
        if (header !== undefined) {
          out.push(header);
          continue;
        }
        try {
          const message = await client.fetchMessage(folder, uid);
          out.push(message);
        } catch {
          // 这一封已经不在了（被删/移动）：跳过，不整批失败
        }
      }
      return out;
    });
  }

  async send(draft: SendDraft): Promise<SendResult> {
    const from: MailAddress = {
      name: String(this.#opts.fromName ?? '').trim(),
      address: String(this.#opts.email ?? '').trim(),
    };
    // 每次发信新建一个 SMTP client，send 完就 close：连接惰性、失败后下一条命令自然重试一次。
    const factory = this.#opts.smtpFactory ?? createSmtpClient;
    const client = factory(this.#smtpOptions());
    try {
      const outgoing = buildOutgoingMessage(draft, from);
      const result = await client.send(outgoing);
      this.#lastError = undefined;
      this.#lastSyncAt = new Date().toISOString();
      return result;
    } catch (error) {
      const failure = asMailError(error, '发送邮件');
      this.#lastError = failureOf(failure);
      throw failure;
    } finally {
      try {
        await client.close();
      } catch {
        // close 失败不影响这封信已经发出去的事实
      }
    }
  }

  // ───────────────────────── 可选能力 ─────────────────────────

  /** 标记已读（PLAN §3.6：只在 cfg.markSeenOnRead=true 时由上层调用）。 */
  async markSeen(folder: string, uid: number): Promise<void> {
    const target = folderOf({ folder });
    await this.#withImap('标记已读 ' + target + '#' + String(uid), (client) => client.markSeen(target, uid));
  }

  /** SELECT 一个文件夹，拿 UIDVALIDITY / 总数给增量游标用。 */
  async selectInfo(folder: string): Promise<ImapSelectInfo> {
    const target = folderOf({ folder });
    return this.#withImap('选择 ' + target, (client) => client.select(target));
  }

  async close(): Promise<void> {
    await this.#dropImap();
    this.#folders = [];
  }
}

/**
 * 创建真邮箱 Mailbox。构造不建连（见文件头）；返回对象带 LiveMailboxExtras 的可选成员。
 */
export function createLiveMailbox(options: LiveMailboxOptions): Mailbox & LiveMailboxExtras {
  return new LiveMailbox(options);
}
