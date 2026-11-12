/**
 * 本地邮件知识库的类型（PLAN 第 8 节）。
 *
 * 依赖方向（PLAN 第 2 节）：vault 不 import mail/imap|smtp，也不 import 框架之外的东西。
 * 这里刻意不 import src/mail/types.ts：知识库只吃纯数据，MailMode 在这里是一份字面量联合，
 * 与 mail/types.ts 的 MailMode 结构一致，两边互赋不会出错；这样 vault 的单测不依赖协议层文件。
 */

/** 与 mail/types.ts 的 MailMode 结构相同：demo＝演示邮箱，live＝真邮箱。 */
export type VaultMode = 'demo' | 'live';

/**
 * 一封落进知识库的邮件。正文可以没有：mail_list 只取头部，不该为了记一条索引去拉整封。
 */
export interface StoredMail {
  /** 去重键，固定为 "<folder>#<uid>"（PLAN 第 8 节）；规则唯一出处见 mailId()。 */
  id: string;
  /** IMAP mailbox 名，例如 INBOX。 */
  folder: string;
  /** 该文件夹内稳定；随 UIDVALIDITY 变化。 */
  uid: number;
  /** RFC2047 已解码的主题；无则 ''。 */
  subject: string;
  /** 发件人显示名；没有显示名时是地址。多个发件人只留第一个。 */
  from: string;
  /** ISO 8601；无/不可解析则 ''。 */
  date: string;
  /** 纯文本预览，<= 200 字符。 */
  snippet: string;
  /** 纯文本正文：只有 readNow 落库时才有。 */
  text?: string;
  /** 学习（落库）时刻，ISO 8601。 */
  learnedAt: string;
  /** 这封邮件来自哪种邮箱。 */
  mode: VaultMode;
}

/** vault.stats() 的快照。 */
export interface VaultStats {
  items: number;
  /** mail.jsonl 的字节数。 */
  bytes: number;
  lastLearnedAt?: string;
  /** 各文件夹条数。 */
  folders: Record<string, number>;
}

/** 知识库接口。put 只追加，检索按 learnedAt 新→旧。 */
export interface Vault {
  has(id: string): Promise<boolean>;
  put(items: StoredMail[]): Promise<{ added: number; skipped: number }>;
  search(q: string, o?: { limit?: number }): Promise<StoredMail[]>;
  recent(limit?: number): Promise<StoredMail[]>;
  stats(): Promise<VaultStats>;
}

/** 记忆包导出类型（结构同 cortico-bot-memory 的 cortico-memory-export v1）。 */
export type MemoryExport = { version: number; kind: 'cortico-memory-export'; [k: string]: unknown };

/** 邮件 id 规则的唯一出处：去重、has() 预检、回执里都用它，别各自拼字符串。 */
export function mailId(folder: string, uid: number): string {
  return String(folder === undefined || folder === null ? '' : folder) + '#' + String(uid);
}
