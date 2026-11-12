/**
 * W3 测试的共用夹具：假宿主、假定时器、假 Mailbox、临时数据目录。
 * 文件名带 world. 前缀，归 W3（tests/world.*.test.ts / tests/tools.*.test.ts / tests/injection.test.ts）专用。
 *
 * 全部离线：假 Mailbox 不发一个包，假宿主不落库，假定时器不真等；临时目录用 mkdtemp。
 * 只用包内代码与 node 内建模块：包必须能裸 node 跑测试。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { EventEnvelope, WorldHost } from 'cortico/core/types.ts';
import type { MailConfigSection } from '../src/config.ts';
import { MAIL_DEFAULTS } from '../src/config.ts';
import { MailError } from '../src/mail/types.ts';
import type {
  ListOptions,
  MailAddress,
  MailAttachment,
  Mailbox,
  MailboxStatus,
  MailFailure,
  MailHeader,
  MailMessage,
  SearchOptions,
  SendDraft,
  SendResult,
} from '../src/mail/types.ts';
import { MailWorld, type MailWorldTimers } from '../src/world.ts';

export const ROOT = resolve(import.meta.dirname, '..');

/** 固定时钟：所有测试不依赖真实时间。 */
export const FIXED_NOW = '2026-11-10T08:00:00.000Z';

// ───────────────────────── 假宿主 ─────────────────────────

export interface PushedEvent {
  type: string;
  text: string;
  origin: string;
  deliver: boolean;
  trigger?: string;
  ts: string;
}

export interface FakeHost {
  host: WorldHost;
  events: PushedEvent[];
  logs: string[];
  of(type: string): PushedEvent[];
  texts(type: string): string[];
}

/** 假宿主：pushEvent 记下来，其余按框架契约给最小实现。 */
export function makeHost(): FakeHost {
  const events: PushedEvent[] = [];
  const logs: string[] = [];
  const host = {
    pushEvent: async (event: Record<string, unknown>, opts: Record<string, unknown> = {}) => {
      events.push({
        type: String(event.type),
        text: String(event.text),
        origin: String(event.origin ?? 'external'),
        deliver: opts.deliver === undefined ? true : Boolean(opts.deliver),
        ...(opts.trigger === undefined ? {} : { trigger: String(opts.trigger) }),
        ts: String(event.ts),
      });
      return { cursor: events.length, ...event, origin: String(event.origin ?? 'external') } as unknown as EventEnvelope;
    },
    pushDeferred: () => undefined,
    store: {
      get: () => undefined,
      latestCursor: () => 0,
      range: () => [],
      around: () => [],
      grep: () => [],
    },
    drainPendingEvents: async () => [],
    modelFacts: { vision: false, toolCalling: true },
    blob: () => null,
    reportUsage: () => undefined,
    log: {
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string) => logs.push(String(message)),
      error: () => undefined,
      emit: () => undefined,
      child: () => host.log,
    },
  };
  return {
    host: host as unknown as WorldHost,
    events,
    logs,
    of: (type: string) => events.filter((one) => one.type === type),
    texts: (type: string) => events.filter((one) => one.type === type).map((one) => one.text),
  };
}

// ───────────────────────── 假定时器 ─────────────────────────

interface TimerRecord {
  handle: unknown;
  ms: number;
  fn: () => void;
  cleared: boolean;
  fired: boolean;
}

export interface FakeTimers {
  timers: MailWorldTimers;
  created: TimerRecord[];
  live(): TimerRecord[];
  /** 拨一跳（默认拨最新挂着的那一只）。 */
  fire(index?: number): void;
}

/** 假定时器：数得清挂了几只、清了几只，还能手动拨一跳。 */
export function makeTimers(): FakeTimers {
  const created: TimerRecord[] = [];
  const timers: MailWorldTimers = {
    setTimeout: (fn, ms) => {
      const handle = {
        id: created.length + 1,
        unref() {
          return handle;
        },
      };
      created.push({ handle, ms, fn, cleared: false, fired: false });
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      const found = created.find((one) => one.handle === handle);
      if (found) found.cleared = true;
    },
  };
  const live = (): TimerRecord[] => created.filter((one) => !one.cleared && !one.fired);
  return {
    timers,
    created,
    live,
    fire: (index?: number) => {
      const pending = live();
      const target = index === undefined ? pending[pending.length - 1] : pending[index];
      if (!target) return;
      target.fired = true;
      target.fn();
    },
  };
}

// ───────────────────────── 假 Mailbox ─────────────────────────

/** 一封种子邮件的形状；list/read/search/send 都从它物化。 */
export interface SeedMail {
  folder: string;
  uid: number;
  subject: string;
  fromName?: string;
  fromAddress?: string;
  date?: string;
  seen?: boolean;
  snippet?: string;
  text?: string;
  messageId?: string;
  headers?: Record<string, string>;
  attachments?: MailAttachment[];
  to?: MailAddress[];
  cc?: MailAddress[];
}

export type FakeErrorKind = 'list' | 'read' | 'search' | 'send' | 'folders' | 'close';

export interface FakeMailboxOptions {
  mode?: 'demo' | 'live';
  account?: string;
  folders?: string[];
  mails?: SeedMail[];
  uidValidity?: number;
  /** status().lastError（live 缺配置那类） */
  statusError?: MailFailure;
  /** 是否提供可选 selectInfo（live 的 UIDVALIDITY 来源）。 */
  withSelectInfo?: boolean;
  /** 是否提供可选 markSeen。 */
  withMarkSeen?: boolean;
  /** 指定操作抛错（5 类失败的注入点）。 */
  fail?: Partial<Record<FakeErrorKind, Error>>;
  /** 按文件夹抛错（list 用）。 */
  failFolder?: Record<string, Error>;
  /** 是否已连接（status 里报）。 */
  connected?: boolean;
}

export interface FakeMailboxState {
  list: ListOptions[];
  read: Array<{ uid: number; folder?: string }>;
  search: SearchOptions[];
  send: SendDraft[];
  markSeen: Array<{ folder: string; uid: number }>;
  closed: number;
  folders: number;
}

export interface FakeMailbox {
  mailbox: Mailbox;
  state: FakeMailboxState;
  setError(kind: FakeErrorKind, error: Error | undefined): void;
  setStatusError(failure: MailFailure | undefined): void;
  setConnected(connected: boolean): void;
  addMail(seed: SeedMail): void;
}

function addressOf(name: string, address: string): MailAddress {
  return { name, address };
}

function headerOf(seed: SeedMail): MailHeader {
  return {
    folder: seed.folder,
    uid: seed.uid,
    messageId: seed.messageId ?? '<seed-' + seed.folder + '-' + String(seed.uid) + '@example.com>',
    subject: seed.subject,
    from: [addressOf(seed.fromName ?? '发件人', seed.fromAddress ?? 'sender@example.com')],
    to: seed.to ?? [addressOf('', 'me@example.com')],
    cc: seed.cc ?? [],
    date: seed.date ?? FIXED_NOW,
    flags: {
      seen: seed.seen === true,
      flagged: false,
      answered: false,
      draft: false,
      deleted: false,
    },
    size: (seed.text ?? seed.snippet ?? '').length,
    snippet: seed.snippet ?? (seed.text ?? '').slice(0, 200),
    hasAttachments: (seed.attachments ?? []).length > 0,
  };
}

function messageOf(seed: SeedMail): MailMessage {
  const header = headerOf(seed);
  return {
    ...header,
    body: { text: seed.text ?? '', html: '' },
    attachments: (seed.attachments ?? []).map((one) => ({ ...one })),
    headers: seed.headers ?? {
      'message-id': header.messageId,
      from: header.from.map((one) => (one.name === '' ? one.address : one.name + ' <' + one.address + '>')).join(', '),
      subject: header.subject,
      date: header.date,
    },
  };
}

/**
 * 假 Mailbox：内存里的种子邮件 + 可控失败。全部离线。
 * 默认 mode='demo'、connected=true；live 的惰性连接语义用 fake ImapClient 单独测（tests 里直接构造）。
 */
export function makeFakeMailbox(options: FakeMailboxOptions = {}): FakeMailbox {
  const mode = options.mode ?? 'demo';
  const account = options.account ?? 'test@example.com';
  const seeds: SeedMail[] = (options.mails ?? []).map((one) => ({ ...one }));
  let statusError = options.statusError;
  let connected = options.connected ?? true;
  const fail: Partial<Record<FakeErrorKind, Error>> = { ...(options.fail ?? {}) };
  const failFolder = options.failFolder ?? {};
  const uidValidity = options.uidValidity ?? 1;
  const state: FakeMailboxState = { list: [], read: [], search: [], send: [], markSeen: [], closed: 0, folders: 0 };

  const assertOk = (kind: FakeErrorKind): void => {
    const error = fail[kind];
    if (error) throw error;
  };

  const headersOf = (folder: string): MailHeader[] =>
    seeds
      .filter((one) => one.folder === folder)
      .map(headerOf)
      .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0) || b.uid - a.uid);

  const mailbox: Mailbox & {
    selectInfo?: (folder: string) => Promise<{ exists: number; uidValidity: number; uidNext: number }>;
    markSeen?: (folder: string, uid: number) => Promise<void>;
  } = {
    mode,
    async status(): Promise<MailboxStatus> {
      assertOk('folders');
      const base: MailboxStatus = {
        mode,
        connected,
        account,
        folders: options.folders ?? ['INBOX'],
        lastSyncAt: FIXED_NOW,
      };
      if (statusError !== undefined) base.lastError = statusError;
      return base;
    },
    async folders(): Promise<string[]> {
      assertOk('folders');
      state.folders += 1;
      return [...(options.folders ?? ['INBOX'])];
    },
    async list(listOptions?: ListOptions): Promise<MailHeader[]> {
      state.list.push({ ...(listOptions ?? {}) });
      assertOk('list');
      const folder = String(listOptions?.folder ?? 'INBOX');
      const folderError = failFolder[folder];
      if (folderError) throw folderError;
      const limit = Number.isFinite(Number(listOptions?.limit)) ? Math.max(1, Math.floor(Number(listOptions?.limit))) : 20;
      return headersOf(folder)
        .filter((one) => listOptions?.unreadOnly !== true || one.flags.seen !== true)
        .slice(0, limit);
    },
    async read(uid: number, readOptions?: { folder?: string; maxChars?: number }): Promise<MailMessage> {
      assertOk('read');
      const folder = String(readOptions?.folder ?? 'INBOX');
      state.read.push({ uid, ...(readOptions?.folder === undefined ? {} : { folder: readOptions.folder }) });
      const seed = seeds.find((one) => one.folder === folder && one.uid === Number(uid));
      if (!seed) {
        throw new MailError('protocol', '没有找到 uid=' + String(uid) + ' 的邮件（文件夹 ' + folder + '）。', {
          hint: '先用 mail_list 拿到最新的 uid。',
        });
      }
      const message = messageOf(seed);
      const maxChars = Number(readOptions?.maxChars);
      if (Number.isFinite(maxChars) && maxChars > 0 && message.body.text.length > maxChars) {
        message.body.text = message.body.text.slice(0, Math.max(0, maxChars - 1)) + '…';
      }
      return message;
    },
    async search(searchOptions: SearchOptions): Promise<MailHeader[]> {
      state.search.push({ ...searchOptions });
      assertOk('search');
      const folder = String(searchOptions.folder ?? 'INBOX');
      const words = String(searchOptions.query ?? '').trim().toLowerCase().split(/\s+/).filter((one) => one !== '');
      const from = String(searchOptions.from ?? '').trim().toLowerCase();
      const limit = Number.isFinite(Number(searchOptions.limit)) ? Math.max(1, Math.floor(Number(searchOptions.limit))) : 10;
      return headersOf(folder)
        .filter((one) => {
          const sender = (one.from ?? []).map((a) => a.name + ' ' + a.address).join(' ').toLowerCase();
          if (from !== '' && !sender.includes(from)) return false;
          const seed = seeds.find((s) => s.folder === one.folder && s.uid === one.uid);
          const hay = [one.subject, sender, seed?.snippet ?? '', seed?.text ?? ''].join(' ').toLowerCase();
          return words.every((word) => hay.includes(word));
        })
        .slice(0, limit);
    },
    async send(draft: SendDraft): Promise<SendResult> {
      assertOk('send');
      state.send.push({ ...draft });
      const accepted = [...draft.to, ...(draft.cc ?? []), ...(draft.bcc ?? [])].map((one) => one.address);
      return { accepted, rejected: [], messageId: '<fake-' + String(state.send.length) + '@example.com>' };
    },
    async close(): Promise<void> {
      assertOk('close');
      state.closed += 1;
    },
  };

  if (options.withSelectInfo === true) {
    mailbox.selectInfo = async (folder: string) => {
      const count = seeds.filter((one) => one.folder === folder).length;
      return { exists: count, uidValidity, uidNext: count + 1 };
    };
  }
  if (options.withMarkSeen === true) {
    mailbox.markSeen = async (folder: string, uid: number) => {
      state.markSeen.push({ folder, uid });
      const seed = seeds.find((one) => one.folder === folder && one.uid === Number(uid));
      if (seed) seed.seen = true;
    };
  }

  return {
    mailbox,
    state,
    setError: (kind, error) => {
      if (error === undefined) delete fail[kind];
      else fail[kind] = error;
    },
    setStatusError: (failure) => {
      statusError = failure;
    },
    setConnected: (value) => {
      connected = value;
    },
    addMail: (seed) => {
      seeds.push({ ...seed });
    },
  };
}

// ───────────────────────── World 夹具 ─────────────────────────

export interface MakeWorldOptions {
  cfg?: Partial<MailConfigSection>;
  /** 注入假 Mailbox（给它就用它当 service；不给且 mode=demo 时用真的演示邮箱）。 */
  service?: FakeMailbox;
  /** 直接注入一个 Mailbox（tests/world.start 用来看 close 计数时更直接）。 */
  mailbox?: Mailbox;
  timers?: FakeTimers;
  dataDir?: string;
  secret?: (name: string) => string;
  clock?: () => Date;
}

export interface BuiltWorld {
  world: MailWorld;
  host: FakeHost;
  timers: FakeTimers;
  dir: string;
  cleanup(): Promise<void>;
}

export async function makeWorld(options: MakeWorldOptions = {}): Promise<BuiltWorld> {
  const dir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'cortico-mail-w3-')));
  const cfg = { ...MAIL_DEFAULTS, ...(options.cfg ?? {}) } as MailConfigSection;
  const timers = options.timers ?? makeTimers();
  const host = makeHost();
  const injected = options.mailbox ?? options.service?.mailbox;
  const world = new MailWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    dataDir: dir,
    packageDir: ROOT,
    secret: options.secret ?? (() => ''),
    restart: async () => undefined,
    timers: timers.timers,
    clock: options.clock ?? (() => new Date(FIXED_NOW)),
    ...(injected === undefined ? {} : { serviceFactory: () => injected }),
  });
  return {
    world,
    host,
    timers,
    dir,
    cleanup: async () => {
      if (options.dataDir === undefined) await rm(dir, { recursive: true, force: true });
    },
  };
}

/** 按名字取一个工具并直接调用 handler；断言只看回执文本。 */
export async function callTool(
  world: MailWorld,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; failed: boolean }> {
  const def = world.tools().find((one) => one.name === name);
  if (!def) throw new Error('没有这个工具：' + name);
  const outcome = await def.handler(args, { role: 'test', log: { warn: () => undefined } } as never);
  return typeof outcome === 'string' ? { text: outcome, failed: false } : { text: outcome.text, failed: outcome.failed === true };
}

/** 等异步条件成立（定时器那一跳里的 scan 要等落盘）。 */
export async function until(check: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('等不到：' + label);
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** 这一跳跑完了（下一跳已经排上）。 */
export async function settled(timers: FakeTimers): Promise<void> {
  await until(() => timers.live().length > 0, '下一跳排上');
}
