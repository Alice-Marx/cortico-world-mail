/**
 * cortico-world-mail · 邮件域类型与客户端契约（PLAN.md §3.1–§3.4）。
 *
 * 本文件是 W1（协议层）、W2（demo 邮箱）、W3（live 邮箱 / world）之间的唯一类型出口：
 * - 纯类型接口（编译期擦除，运行时只剩 `MailError` 一个值）；
 * - `MailError` 是跨层错误载体：`message` 只写类别与关键事实（可进工具回执），
 *   `detail` 只放服务器原文 / 底层异常（只进日志，绝不进回执）。
 *
 * 约定：所有相对 import 必须带 `.ts` 后缀；本文件不 import 任何外部模块。
 */

// ───────────────────────── 基础域类型 ─────────────────────────

export type MailMode = 'demo' | 'live';

export interface MailAddress {
  /** 显示名；未知时为空串 */
  name: string;
  /** 邮箱地址，例如 someone@example.com */
  address: string;
}

export interface MailFlags {
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  deleted: boolean;
}

export interface MailHeader {
  /** IMAP mailbox 名，例如 INBOX */
  folder: string;
  /** 该文件夹内稳定；随 UIDVALIDITY 变化 */
  uid: number;
  /** 无则 '' */
  messageId: string;
  /** RFC2047 已解码 */
  subject: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  /** ISO 8601，无 / 不可解析则 '' */
  date: string;
  flags: MailFlags;
  /** 字节，未知 0 */
  size: number;
  /** 纯文本预览，<= 200 字符 */
  snippet: string;
  hasAttachments: boolean;
}

export interface MailAttachment {
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
}

export interface MailMessage extends MailHeader {
  /** 两者都是纯文本化结果；html 无则 '' */
  body: { text: string; html: string };
  attachments: MailAttachment[];
  /** 已解码的 reply-to / references / in-reply-to / date 原值等 */
  headers: Record<string, string>;
}

// ───────────────────────── 选项 / 草稿 ─────────────────────────

export interface ListOptions {
  folder?: string;
  limit?: number;
  unreadOnly?: boolean;
}

export interface SearchOptions {
  folder?: string;
  query: string;
  limit?: number;
  since?: string;
  from?: string;
  subject?: string;
}

export interface SendDraft {
  to: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  replyTo?: MailAddress[];
}

export interface SendResult {
  accepted: string[];
  rejected: string[];
  messageId: string;
}

// ───────────────────────── 失败 / 状态 ─────────────────────────

export interface MailFailure {
  code: MailErrorCode;
  message: string;
  hint?: string;
}

export interface MailboxStatus {
  mode: MailMode;
  connected: boolean;
  account: string;
  folders: string[];
  lastSyncAt: string;
  lastError?: MailFailure;
}

export type MailErrorCode =
  | 'no-config'
  | 'connect'
  | 'tls'
  | 'auth'
  | 'protocol'
  | 'parse'
  | 'timeout'
  | 'dropped';

export class MailError extends Error {
  readonly code: MailErrorCode;
  readonly hint?: string;
  /** 只进日志，绝不进工具回执 */
  readonly detail?: string;

  constructor(
    code: MailErrorCode,
    message: string,
    options?: { hint?: string; detail?: string; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MailError';
    this.code = code;
    this.hint = options?.hint;
    this.detail = options?.detail;
  }
}

/** 跨层级判断错误用的小工具（值导出，不改变 MailError 契约）。 */
export function isMailError(value: unknown): value is MailError {
  return value instanceof MailError;
}

// ───────────────────────── Mailbox（W2/W3 实现） ─────────────────────────

export interface Mailbox {
  readonly mode: MailMode;
  status(): Promise<MailboxStatus>;
  folders(): Promise<string[]>;
  list(options?: ListOptions): Promise<MailHeader[]>;
  read(uid: number, options?: { folder?: string; maxChars?: number }): Promise<MailMessage>;
  search(options: SearchOptions): Promise<MailHeader[]>;
  send(draft: SendDraft): Promise<SendResult>;
  close(): Promise<void>;
}

// ───────────────────────── IMAP（src/mail/imap.ts 实现） ─────────────────────────

export interface ImapOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  /** 默认 15000；单条命令 15000 */
  timeoutMs?: number;
  /** 仅测试用：连明文假服务器 */
  allowPlaintext?: boolean;
}

export interface ImapSelectInfo {
  exists: number;
  uidValidity: number;
  uidNext: number;
}

export interface FetchRange {
  limit?: number;
  unreadOnly?: boolean;
  afterUid?: number;
}

export interface ImapClient {
  connect(): Promise<void>;
  folders(): Promise<string[]>;
  select(folder: string): Promise<ImapSelectInfo>;
  fetchHeaders(folder: string, range?: FetchRange): Promise<MailHeader[]>;
  fetchMessage(folder: string, uid: number): Promise<MailMessage>;
  search(
    folder: string,
    criteria: { text?: string; from?: string; subject?: string; since?: string; unreadOnly?: boolean },
    limit?: number,
  ): Promise<number[]>;
  markSeen(folder: string, uid: number): Promise<void>;
  logout(): Promise<void>;
}

// ───────────────────────── SMTP（src/mail/smtp.ts 实现） ─────────────────────────

export interface SmtpOptions {
  host: string;
  port: number;
  /** 默认 implicit（465）；587 用 starttls */
  secure: 'implicit' | 'starttls' | false;
  user: string;
  pass: string;
  timeoutMs?: number;
  /** 仅测试 */
  allowPlaintext?: boolean;
}

export interface OutgoingMessage {
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  text: string;
  html?: string;
  date?: Date;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
}

export interface SmtpClient {
  send(message: OutgoingMessage): Promise<SendResult>;
  close(): Promise<void>;
}
