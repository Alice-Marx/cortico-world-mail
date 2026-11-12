/**
 * MailWorld：邮箱 World 的真身（PLAN 第 5、6、7、8、9 节）。
 *
 * 契约 core/types.ts 的 World：id / envPromptVars() / tools() / webUi?(language) / start(host) / stop()。
 *
 * ★ start() 绝不抛错（PLAN 第 7 节）：没凭据、没网络、服务器连不上，一律投一条 mail.down 之后安静返回。
 *   装配层不会因为一个 World 的启动失败而掉整条时间线；工具调用时再按 5 类失败回报。
 *
 * ★ 事件是第三方内容的唯一出口（PLAN 第 9 节）：
 *   - internal 事件（mail.ready / mail.down / mail.scanned）只许出现我们自己写的固定文案与计数，
 *     绝不出现主题、发件人、正文或服务器原文；
 *   - mail.new 是 external，正文只放 digest（发件人显示名 / 时间 / 主题 / 截断片段）。
 *
 * 落盘（都在 dataDir/<vaultSubdir> 下，别写别处）：
 *   mail.jsonl / mail.md   知识库本体，归 src/vault；
 *   cursor.json            增量游标 { folders: { INBOX: { uidValidity, lastUid, lastSyncAt } } }。
 *
 * 依赖方向：world → { config, i18n, mail/service, vault, tools }；tools 只对 world 做 import type。
 */
import { readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type {
  EventOrigin,
  ToolDef,
  TriggerMode,
  World,
  WorldHost,
  WorldLamp,
  WorldWebUiDecl,
} from 'cortico/core/types.ts';
import { WORLD_ID, folderLines, mailConfigGroups, type MailConfigSection } from './config.ts';
import { MODEL, strings } from './i18n.ts';
import { DEMO_ACCOUNT } from './mail/demo.ts';
import type { CreateMailboxOptions } from './mail/service.ts';
import { createMailbox } from './mail/service.ts';
import { MailError, type Mailbox, type MailboxStatus, type MailFailure, type MailHeader, type MailMessage, type MailMode, type SendDraft, type SendResult } from './mail/types.ts';
import type { Vault } from './vault/types.ts';
import { mailId, type StoredMail, type VaultStats } from './vault/types.ts';
import { createVault } from './vault/vault.ts';
import { digest } from './vault/digest.ts';
import { classifyMailFailure, RECEIPT_LABEL } from './tools/receipt.ts';
import { buildTools } from './tools/index.ts';

/** 环境提示词模板的绝对路径。框架直接按它读文件；与 src/index.ts 里的同名常量同值。 */
export const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
/** envPrompt 的 key 惯例：worlds.<id>.<名>。 */
export const ENV_PROMPT_KEY = 'worlds.' + WORLD_ID + '.envPrompt';

/** 增量游标文件：与知识库同目录，重启后仍知道「上次收信」是何时。 */
export const CURSOR_FILE = 'cursor.json';

/** 冷启动第一轮：demo 3 秒后就收（马上能看到演示数据），live 60 秒后（不在启动瞬间打服务器）。 */
export const DEMO_FIRST_SCAN_DELAY_MS = 3_000;
export const LIVE_FIRST_SCAN_DELAY_MS = 60_000;

/** 等宿主落库的上限：宿主不回话不许把整轮扫描堵死。 */
const EVENT_PUSH_TIMEOUT_MS = 5_000;
/** stop() 等一轮在飞扫描落地的上限。 */
const STOP_WAIT_MS = 10_000;

/** 定时器注入点：测试用假的数句柄，生产用全局实现。 */
export interface MailWorldTimers {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

const GLOBAL_TIMERS: MailWorldTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** create(ctx) 交给实例的东西。ctx 本身不进实例：它带着装配层的对象图，实例只留自己用得上的。 */
export interface MailWorldOptions {
  /** worlds.mail 的活引用：热改的键现读即生效。 */
  cfg: MailConfigSection;
  timezone: string;
  /** 部署数据目录；知识库与游标落在它下面。 */
  dataDir: string;
  /** 包目录；包内模板从这里读。 */
  packageDir: string;
  /** ctx.secret(name)；授权码的第二个来源。 */
  secret?: (name: string) => string;
  /** ctx.restart()；改完必须重建的配置项由它触发（本版暂未使用）。 */
  restart?: () => Promise<void>;
  /** 定时器；省略＝全局 setTimeout。测试注入用。 */
  timers?: MailWorldTimers;
  /** 时钟；省略＝new Date()。测试注入用（游标/事件时间可复现）。 */
  clock?: () => Date;
  /** 服务工厂；省略＝ src/mail/service.ts 的 createMailbox。测试注入假 Mailbox 用。 */
  serviceFactory?: (cfg: MailConfigSection, options: CreateMailboxOptions) => Mailbox;
}

/** 一个文件夹的增量游标（PLAN 第 7 节）。 */
export interface FolderCursor {
  uidValidity: number;
  lastUid: number;
  lastSyncAt: string;
}

export interface MailCursor {
  folders: Record<string, FolderCursor>;
}

const EMPTY_CURSOR: MailCursor = { folders: {} };

/** 一个文件夹这一轮读到了什么。 */
export interface FolderScan {
  folder: string;
  /** 本轮新出现的封数（uid 大于游标） */
  fresh: number;
  /** 文件夹里现有的总封数（服务器 SELECT 的 exists；拿不到时用本轮取到的条数） */
  total: number;
  /** 真正新入库的封数（知识库去重后） */
  stored: number;
  /** 库里已有、跳过的封数 */
  skipped: number;
}

/** 一轮收信的结果。工具回执与事件文本都从这里算，不各自猜。 */
export interface ScanOutcome {
  at: string;
  perFolder: FolderScan[];
  /** 本轮真正新入库的邮件，按收到顺序 */
  added: StoredMail[];
  /** 失败的文件夹与本轮异常（错误对象原样交给回执去分类） */
  failures: Array<{ folder: string; error: unknown }>;
  /** mail.new 是否真的投出去了（deliverDigest 控制） */
  delivered: boolean;
}

/** mail_list 的结果。 */
export interface ListOutcome {
  folder: string;
  headers: MailHeader[];
  /** 写进知识库的封数 */
  stored: number;
}

/** mail_read 的结果。 */
export interface ReadOutcome {
  folder: string;
  message: MailMessage;
  /** 这封是这次新写进知识库的，还是库里已有 */
  stored: boolean;
  /** 正文是否按 maxBodyChars 截断 */
  truncated: boolean;
  /** 是否把服务器上的这封标记成已读（markSeenOnRead=true 且邮箱支持时） */
  markedSeen: boolean;
}

/** mail_search 的结果。 */
export interface SearchOutcome {
  folder: string;
  headers: MailHeader[];
  /** 服务器端 SEARCH 不可用、退化成最近 N 封本地过滤时为 true */
  degraded: boolean;
}

/** mail_send / mail_reply 的结果。sent=false 表示这几是预览，什么都没发。 */
export interface ComposeOutcome {
  mode: MailMode;
  draft: SendDraft;
  sent: boolean;
  result?: SendResult;
}

/** mail_reply 的附加信息：原邮件是谁、回了哪封。 */
export interface ReplyOutcome extends ComposeOutcome {
  original: { folder: string; uid: number; subject: string; from: string };
}

/** 回信要的原始头信息（从 MailMessage 里折出来）。 */
export interface ReplyTarget {
  folder: string;
  uid: number;
  subject: string;
  from: string;
  to: SendDraft['to'];
  inReplyTo: string;
  references: string[];
}

/** mail_status 的快照。 */
export interface StatusSnapshot {
  mode: MailMode;
  connected: boolean;
  account: string;
  /** 服务端列出来的文件夹（连上后才有）；没连上时等于配置的文件夹 */
  folders: string[];
  configFolders: string[];
  lastSyncAt: string;
  lastError?: MailFailure;
  vault: VaultStats;
  lastScanAt: string | null;
  lastScanAdded: number;
  scans: number;
  intervalMinutes: number;
  nextScanAt: string | null;
  vaultDir: string;
  mounted: boolean;
  /** 这一轮是冷启动（还没扫过第一轮）：demo 首轮 3 秒、live 首轮 60 秒。 */
  cold: boolean;
  /** 已经投过 mail.ready 了没有。 */
  ready: boolean;
}

/** 可选能力：不是 Mailbox 主接口的成员（PLAN §3.1 不许改），探测后使用。 */
interface MailboxExtras {
  markSeen?: (folder: string, uid: number) => Promise<void>;
  selectInfo?: (folder: string) => Promise<{ exists: number; uidValidity: number; uidNext: number }>;
}

function asExtras(service: Mailbox): Mailbox & MailboxExtras {
  return service as Mailbox & MailboxExtras;
}

/** 有上限的等待：超时只记日志，不把整条流程卡死。 */
async function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' 超过 ' + String(ms) + ' 毫秒没回话')), ms);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error === null || error === undefined ? '' : error);
}

/** vaultSubdir 只允许落在 dataDir 里面：去掉盘符、绝对路径与 .. 段。 */
export function vaultPath(dataDir: string, subdir: unknown): string {
  const raw = String(subdir === null || subdir === undefined ? '' : subdir).trim();
  const parts = raw
    .replace(/[\\/]+/g, sep)
    .split(sep)
    .filter((part) => part !== '' && part !== '.' && part !== '..' && part !== ':');
  return join(dataDir, parts.length ? parts.join(sep) : WORLD_ID);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** 邮件头 → 知识库条目。id 规则唯一出处是 vault/types.ts 的 mailId。 */
function toStored(header: MailHeader, learnedAt: string, mode: MailMode, text?: string): StoredMail {
  const item: StoredMail = {
    id: mailId(header.folder, header.uid),
    folder: header.folder,
    uid: header.uid,
    subject: String(header.subject ?? ''),
    from: senderName(header),
    date: String(header.date ?? ''),
    snippet: String(header.snippet ?? ''),
    learnedAt,
    mode,
  };
  if (typeof text === 'string' && text !== '') item.text = text;
  return item;
}

/** 发件人显示名：优先 name，没有就用地址；多个发件人只留第一个。 */
export function senderName(header: { from?: Array<{ name?: string; address?: string }> }): string {
  const first = Array.isArray(header.from) ? header.from[0] : undefined;
  if (!first) return '';
  const name = String(first.name ?? '').trim();
  if (name !== '') return name;
  return String(first.address ?? '').trim();
}

/** 把地址从 "名字 <a@example.com>, b@example.com" 折成 MailAddress[]（回信取 Reply-To/From 用）。 */
export function parseAddressValue(raw: unknown): Array<{ name: string; address: string }> {
  const text = String(raw === null || raw === undefined ? '' : raw);
  const out: Array<{ name: string; address: string }> = [];
  for (const part of text.split(/[,;]/)) {
    const piece = part.trim();
    if (piece === '') continue;
    const angled = /^(.*?)<([^<>]+)>$/.exec(piece);
    if (angled) {
      const name = angled[1].trim().replace(/^"([\s\S]*)"$/, '$1').trim();
      const address = angled[2].trim();
      if (address !== '') out.push({ name, address });
      continue;
    }
    if (piece.includes('@')) out.push({ name: '', address: piece });
  }
  return out;
}

/** 回信草稿：Re: 主题、In-Reply-To/References，收件人取 Reply-To/From（PLAN 第 5 节）。 */
export function buildReplyDraft(target: ReplyTarget, text: string): SendDraft {
  const subject = String(target.subject ?? '').trim();
  const draft: SendDraft = {
    to: target.to.length ? target.to.map((a) => ({ ...a })) : [{ name: '', address: '' }],
    subject: /^re\s*:/i.test(subject) ? subject : 'Re: ' + (subject === '' ? '（无主题）' : subject),
    text: String(text ?? ''),
  };
  if (target.inReplyTo !== '') draft.inReplyTo = target.inReplyTo;
  if (target.references.length) draft.references = [...target.references];
  return draft;
}

/** 原子写：tmp + rename。掉电最多丢掉这一次写入，不会把旧文件撕成半截。 */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmp = path + '.' + String(Math.random()).slice(2) + '.tmp';
  await mkdir(dirname(path), { recursive: true });
  let renamed = false;
  try {
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, path);
    renamed = true;
  } finally {
    if (!renamed) await rm(tmp, { force: true }).catch(() => undefined);
  }
}

export class MailWorld implements World {
  readonly id = WORLD_ID;

  private readonly opts: MailWorldOptions;
  private readonly vault: Vault;
  private readonly vaultDir: string;

  private host: WorldHost | null = null;
  private startedAt: string | null = null;
  private failure: string | null = null;
  private lastFailure: unknown = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private service: Mailbox | null = null;
  private statusCache: MailboxStatus | null = null;

  private scanning = false;
  /** stop() 之后要让在飞的那一轮尽快收手。 */
  private cancelled = false;
  private inflight: Promise<void> | null = null;

  private cursor: MailCursor = { folders: {} };
  private cursorLoaded = false;
  private lastScanAt: string | null = null;
  private lastScanAdded = 0;
  private scans = 0;
  private nextScanAt: string | null = null;
  private cold = true;
  /** 已经投过 mail.ready（每次 start 重置）。 */
  private ready = false;
  /** 已经投过 mail.down：同一次启动只投一条，免得每轮扫描吵一次。 */
  private down = false;
  private toolCache: ToolDef[] | null = null;

  constructor(opts: MailWorldOptions) {
    this.opts = opts;
    this.vaultDir = vaultPath(opts.dataDir, opts.cfg.vaultSubdir);
    // createVault 只记目录，不建文件：装配层随时会构造实例（含 enabled=false），构造必须无副作用。
    this.vault = createVault(this.vaultDir);
  }

  get cfg(): MailConfigSection {
    return this.opts.cfg;
  }

  /** 知识库目录（绝对路径）。回执要把它给模型看。 */
  get knowledgeDir(): string {
    return this.vaultDir;
  }

  /** 给测试用：现在挂着宿主吗。 */
  get mounted(): boolean {
    return this.host !== null;
  }

  /** 给测试 / 状态快照用：最近一次失败的原始异常。 */
  get lastError(): unknown {
    return this.lastFailure;
  }

  /** 配置里要收的文件夹（PLAN 第 4 节 folders：每行一个，# 注释）。空配置回落到 INBOX。 */
  get configuredFolders(): string[] {
    const lines = folderLines(this.opts.cfg.folders);
    return lines.length ? lines : ['INBOX'];
  }

  private firstFolder(): string {
    return this.configuredFolders[0] ?? 'INBOX';
  }

  private now(): Date {
    const factory = this.opts.clock;
    const value = factory ? factory() : new Date();
    return value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date(0);
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  // ───────────────────────── World 契约 ─────────────────────────

  /** 7 个工具：声明逐字取自 definition.ts 的 TOOL_SPECS，这里只挂 handler。 */
  tools(): ToolDef[] {
    if (this.toolCache === null) this.toolCache = buildTools(this);
    return this.toolCache;
  }

  webUi(language?: Language): WorldWebUiDecl {
    const s = strings(language);
    const state = this.lampState();
    return {
      label: s.label,
      lamps: [{ label: s.lamp.label, state, hint: s.lamp.hint[state] }],
      panels: [{
        id: 'state',
        title: s.panel.title,
        description: '邮箱状态：模式、账号、文件夹、连接、知识库与上次同步。',
        getMethods: ['status'],
      }],
      config: mailConfigGroups(language),
      promptDocs: [
        {
          key: ENV_PROMPT_KEY,
          title: s.env.title,
          description: s.env.description,
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'mail.mode', description: '当前是 demo 还是 live，以及它意味着什么（一句固定文案）。' },
            { name: 'mail.account', description: '正在用的账号；demo 模式是内置演示邮箱。' },
            { name: 'mail.folders', description: s.env.vars.folders },
            { name: 'mail.interval', description: s.env.vars.interval },
            { name: 'mail.status', description: s.env.vars.status },
            { name: 'mail.vault', description: s.env.vars.vault },
          ],
        },
      ],
      invoke: async (panel: string, method: string): Promise<unknown> => {
        if (panel !== 'state') throw new Error('没有这个面板：' + panel);
        if (method !== 'status') throw new Error('没有这个方法：' + method);
        return this.statusSnapshot();
      },
    };
  }

  /**
   * 进系统前缀的变量（PLAN 第 3 节 / W3 任务书）：每次都现算。
   * 只放我们自己写的文案与配置值，不放主题、正文等第三方内容。
   */
  envPromptVars(): Record<string, string> {
    const mode = this.opts.cfg.mode === 'live' ? 'live' : 'demo';
    const folders = this.configuredFolders;
    const minutes = Number(this.opts.cfg.intervalMinutes);
    const status = this.statusCache;
    const account = status !== null && status.account !== ''
      ? status.account
      : mode === 'demo'
        ? DEMO_ACCOUNT
        : String(this.opts.cfg.email ?? '').trim();
    return {
      'mail.mode': mode === 'demo' ? MODEL.status.demo : MODEL.status.live,
      'mail.account': account === '' ? '（还没填邮箱地址）' : account,
      'mail.folders': folders.length ? MODEL.foldersSome(folders) : MODEL.foldersNone,
      'mail.interval': Number.isFinite(minutes) && minutes > 0 ? MODEL.intervalOn(minutes) : MODEL.intervalOff,
      'mail.status': this.statusText(),
      'mail.vault': MODEL.vault(String(this.opts.cfg.vaultSubdir || WORLD_ID)),
    };
  }

  /**
   * 启动：建 service → 必要时投 ready / down → 排第一轮。
   * 整段包在 try/catch 里，**绝不向外抛**（PLAN 第 7 节）。
   */
  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.startedAt = this.nowIso();
    this.failure = null;
    this.lastFailure = null;
    this.ready = false;
    this.down = false;
    this.cold = true;
    this.cancelled = false;
    try {
      this.service = this.buildService();
      await this.loadCursor();
      const status = await this.service.status();
      this.statusCache = status;
      if (status.lastError !== undefined) {
        // live 缺配置回退 demo：配置没填完是唯一会在启动期变成 lastError 的情况。
        this.lastFailure = new MailError(status.lastError.code, status.lastError.message, { hint: status.lastError.hint });
        this.failure = status.lastError.message;
        await this.markDown(this.lastFailure, 'start');
      } else if (this.service.mode === 'demo') {
        // demo 载入即就绪（不联网）。
        await this.markReady(status);
      }
      // live 且配置齐全：连接是惰性的，start 不打服务器；第一轮收信成功后再投 mail.ready。
    } catch (error) {
      this.failure = errorText(error);
      this.lastFailure = error;
      await this.markDown(error, 'start');
    }
    try {
      this.armNext(this.firstScanDelayMs());
    } catch (error) {
      this.failure = errorText(error);
      this.lastFailure = error;
    }
  }

  /** stop()：清定时器、等这一轮收手、关服务。绝不抛。 */
  async stop(): Promise<void> {
    this.cancelled = true;
    this.disarmTimer();
    const inflight = this.inflight;
    if (inflight !== null) {
      try {
        await Promise.race([inflight, sleep(STOP_WAIT_MS)]);
      } catch {
        // 那一轮自己失败了也不影响 stop
      }
    }
    const service = this.service;
    this.service = null;
    this.statusCache = null;
    this.host = null;
    this.startedAt = null;
    this.failure = null;
    this.lastFailure = null;
    this.down = false;
    this.ready = false;
    this.nextScanAt = null;
    if (service !== null) {
      try {
        await service.close();
      } catch {
        // 服务可能已经断了；stop 也不许抛
      }
    }
  }

  // ───────────────────────── 收信 ─────────────────────────

  /**
   * 一轮收信：逐文件夹 list（增量游标）→ 新邮件写 vault → mail.scanned（internal）。
   * 有新邮件且 deliverDigest 时投 mail.new（external，只有摘要）。
   */
  async scan(): Promise<ScanOutcome> {
    if (this.scanning) throw new Error('上一轮收信还没结束，等它完成或稍后再试。');
    this.scanning = true;
    this.cancelled = false;
    const task = this.runScan();
    this.inflight = task.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await task;
    } finally {
      this.scanning = false;
      this.inflight = null;
    }
  }

  private async runScan(): Promise<ScanOutcome> {
    const at = this.nowIso();
    const service = await this.ensureService();
    const mode = service.mode;
    const limit = clampInt(this.opts.cfg.limitPerFetch, 20, 1, 100);
    await this.loadCursor();
    const outcome: ScanOutcome = { at, perFolder: [], added: [], failures: [], delivered: false };

    for (const folder of this.configuredFolders) {
      if (this.cancelled) break;
      try {
        const headers = await service.list({ folder, limit });
        const select = await this.selectInfoOf(service, folder);
        const prev = this.cursor.folders[folder];
        const uidValidity = select !== undefined ? select.uidValidity : (prev?.uidValidity ?? 1);
        // UIDVALIDITY 变了 = 服务器重建过 uid 空间：这一轮全量重扫，不能拿旧 lastUid 去增量。
        const reset = prev !== undefined && select !== undefined && prev.uidValidity !== uidValidity;
        const fresh = reset ? headers.slice() : headers.filter((one) => one.uid > (prev?.lastUid ?? 0));
        const items = fresh.map((header) => toStored(header, at, mode));
        const stored = await this.store(items);
        outcome.perFolder.push({
          folder,
          fresh: fresh.length,
          total: select !== undefined ? select.exists : headers.length,
          stored: stored.added.length,
          skipped: stored.skipped,
        });
        outcome.added.push(...stored.added);
        const floor = reset ? 0 : (prev?.lastUid ?? 0);
        const lastUid = headers.reduce((max, one) => (Number.isFinite(one.uid) && one.uid > max ? one.uid : max), floor);
        this.cursor.folders[folder] = { uidValidity, lastUid, lastSyncAt: at };
      } catch (error) {
        outcome.failures.push({ folder, error });
        // 服务器原文（若有）只写日志：日志不是模型通道，internal 事件与回执都不碰它。
        const detail = (error as { detail?: unknown } | null)?.detail;
        this.warn(
          '读文件夹失败（' + folder + '）：' + errorText(error)
            + (typeof detail === 'string' && detail !== '' ? ' ／服务器原文：' + detail : ''),
        );
      }
    }

    // 一个文件夹都没成：把第一个错误原样抛出去，让工具按 5 类失败回报；事件不投（避免假 scanned）。
    if (outcome.perFolder.length === 0 && outcome.failures.length > 0) {
      this.lastFailure = outcome.failures[0].error;
      throw outcome.failures[0].error;
    }

    if (this.cancelled) return outcome;
    this.cold = false;
    this.failure = null;
    this.lastFailure = null;
    this.lastScanAt = at;
    this.lastScanAdded = outcome.added.length;
    this.scans += 1;
    await this.saveCursor();
    // 一轮读成功 = 这一代 live 连接可用：补投一次 mail.ready（每次启动只投一次）。
    if (mode === 'live' && !this.ready) {
      try {
        const status = await service.status();
        this.statusCache = status;
        await this.markReady(status);
      } catch {
        // status 只是补充信息；投不成 ready 不影响这一轮
      }
    }
    await this.publish(outcome);
    return outcome;
  }

  /** 每个文件夹：取 UIDVALIDITY/总数（live 有 selectInfo；demo 没有就留 undefined）。 */
  private async selectInfoOf(service: Mailbox, folder: string): Promise<{ exists: number; uidValidity: number; uidNext: number } | undefined> {
    const extras = asExtras(service);
    if (typeof extras.selectInfo !== 'function') return undefined;
    try {
      return await extras.selectInfo(folder);
    } catch {
      // SELECT 失败不拖垮 list 已经读到的内容；增量游标退化成「按 lastUid 比」。
      return undefined;
    }
  }

  /** mail_list：列最新邮件头并写进知识库（PLAN 第 5 节）。 */
  async listNow(options: { folder?: string; limit?: number; unreadOnly?: boolean } = {}): Promise<ListOutcome> {
    const service = await this.ensureService();
    const folder = String(options.folder ?? '').trim() || this.firstFolder();
    const limit = clampInt(options.limit, clampInt(this.opts.cfg.limitPerFetch, 20, 1, 100), 1, 100);
    const headers = await service.list({ folder, limit, unreadOnly: options.unreadOnly === true });
    const at = this.nowIso();
    const stored = await this.store(headers.map((header) => toStored(header, at, service.mode)));
    this.statusCache = await this.safeStatus(service);
    return { folder, headers, stored: stored.added.length };
  }

  /** mail_read：读一封正文、截到 maxBodyChars、按配置决定是否标已读，并写进知识库。 */
  async readNow(uid: number, options: { folder?: string; maxChars?: number } = {}): Promise<ReadOutcome> {
    const service = await this.ensureService();
    const folder = String(options.folder ?? '').trim() || this.firstFolder();
    const maxChars = clampInt(options.maxChars, clampInt(this.opts.cfg.maxBodyChars, 20_000, 200, 200_000), 200, 200_000);
    const message = await service.read(uid, { folder });
    const full = String(message.body.text ?? '');
    const truncated = full.length > maxChars;
    const text = truncated ? full.slice(0, Math.max(0, maxChars - 1)) + '…' : full;
    const view: MailMessage = { ...message, body: { text, html: message.body.html } };
    const at = this.nowIso();
    const stored = await this.store([toStored(message, at, service.mode, text)]);
    let markedSeen = false;
    if (this.opts.cfg.markSeenOnRead === true) {
      const extras = asExtras(service);
      if (typeof extras.markSeen === 'function') {
        try {
          await extras.markSeen(folder, uid);
          markedSeen = true;
        } catch (error) {
          // 标已读失败不该让「读到了什么」变成失败；记一条日志就够。
          this.warn('标记已读失败（' + folder + '#' + String(uid) + '）：' + errorText(error));
        }
      }
    }
    this.statusCache = await this.safeStatus(service);
    return { folder, message: view, stored: stored.added.length > 0, truncated, markedSeen };
  }

  /** mail_search：服务器端 SEARCH 优先；服务器不支持（protocol）时退化为最近 N 封本地过滤。 */
  async searchNow(options: { query: string; folder?: string; limit?: number; from?: string; since?: string }): Promise<SearchOutcome> {
    const service = await this.ensureService();
    const folder = String(options.folder ?? '').trim() || this.firstFolder();
    const limit = clampInt(options.limit, 10, 1, 100);
    const query = String(options.query ?? '').trim();
    try {
      const headers = await service.search({
        folder,
        query,
        limit,
        ...(String(options.from ?? '').trim() === '' ? {} : { from: String(options.from).trim() }),
        ...(String(options.since ?? '').trim() === '' ? {} : { since: String(options.since).trim() }),
      });
      this.statusCache = await this.safeStatus(service);
      return { folder, headers, degraded: false };
    } catch (error) {
      if (!(error instanceof MailError) || error.code !== 'protocol') throw error;
      // 服务器明确说这条 SEARCH 不认：退化成本地过滤，并如实告诉模型这是退化结果。
      this.warn('服务器端搜索失败，退化为本地过滤：' + errorText(error));
      const window = Math.max(limit, clampInt(this.opts.cfg.limitPerFetch, 20, 1, 100)) * 5;
      const recent = await service.list({ folder, limit: clampInt(window, 100, 1, 100) });
      const filtered = localFilter(recent, { query, from: options.from, since: options.since });
      this.statusCache = await this.safeStatus(service);
      return { folder, headers: filtered.slice(0, limit), degraded: true };
    }
  }

  /**
   * mail_send 的真正实现，**危险门禁在这里**：confirm!==true 时在调用 service 之前就返回预览草稿，
   * 一个字都不发（PLAN 第 9 节第 4 条）。
   */
  async sendNow(draft: SendDraft, confirm: boolean): Promise<ComposeOutcome> {
    const service = await this.ensureService();
    if (confirm !== true) return { mode: service.mode, draft, sent: false };
    const result = await service.send(draft);
    this.statusCache = await this.safeStatus(service);
    return { mode: service.mode, draft, sent: true, result };
  }

  /**
   * mail_reply：读原邮件 → 组装 Re:/In-Reply-To/References 草稿 → 同样要 confirm===true 才发。
   */
  async replyNow(uid: number, text: string, options: { folder?: string; confirm?: boolean } = {}): Promise<ReplyOutcome> {
    const service = await this.ensureService();
    const folder = String(options.folder ?? '').trim() || this.firstFolder();
    const original = await service.read(uid, { folder });
    const target = replyTargetOf(original, folder);
    const draft = buildReplyDraft(target, text);
    const preview: ReplyOutcome = {
      mode: service.mode,
      draft,
      sent: false,
      original: { folder, uid, subject: target.subject, from: target.from },
    };
    if (options.confirm !== true) return preview;
    const result = await service.send(draft);
    this.statusCache = await this.safeStatus(service);
    return { ...preview, sent: true, result };
  }

  /** mail_recall：只在本地知识库检索，不联网、不改任何东西。 */
  async recallNow(query: string, limit?: number): Promise<StoredMail[]> {
    return this.vault.search(String(query === undefined || query === null ? '' : query), {
      limit: clampInt(limit, 10, 1, 50),
    });
  }

  /** mail_status 的快照：不联网也能答（live 的 status() 本身不建连）。 */
  async statusSnapshot(): Promise<StatusSnapshot> {
    await this.loadCursor();
    const service = await this.ensureService();
    const status = await this.safeStatus(service);
    const stats = await this.vault.stats();
    const folders = status.folders.length ? [...status.folders] : [...this.configuredFolders];
    const snapshot: StatusSnapshot = {
      mode: status.mode,
      connected: status.connected,
      account: status.account,
      folders,
      configFolders: [...this.configuredFolders],
      lastSyncAt: status.lastSyncAt,
      vault: stats,
      lastScanAt: this.lastScanAt,
      lastScanAdded: this.lastScanAdded,
      scans: this.scans,
      intervalMinutes: Number(this.opts.cfg.intervalMinutes),
      nextScanAt: this.nextScanAt,
      vaultDir: this.vaultDir,
      mounted: this.host !== null,
      cold: this.cold,
      ready: this.ready,
    };
    if (status.lastError !== undefined) snapshot.lastError = status.lastError;
    return snapshot;
  }

  // ───────────────────────── 事件 ─────────────────────────

  /**
   * ready 的正文只用固定模板 + 我们自己知道的事实（模式、文件夹数、demo 账号）。
   * internal 事件：不许出现任何第三方文本，也不出现 live 的邮箱地址。
   */
  private async markReady(status: MailboxStatus): Promise<void> {
    this.ready = true;
    this.down = false;
    const folders = status.folders.length ? status.folders.length : this.configuredFolders.length;
    const text = status.mode === 'demo'
      ? '邮箱已就绪：demo 模式（内置演示邮箱，不联网、不需要凭据），账号 ' + DEMO_ACCOUNT
        + '，' + String(folders) + ' 个文件夹。'
      : '邮箱已就绪：live 模式（连真实邮箱），' + String(folders) + ' 个文件夹。';
    await this.emit('mail.ready', text);
  }

  /**
   * down 通知：只写失败类别与固定建议。
   * ★ 这里只许拼固定模板 + 我们自己的分类词：绝不能带 error.message / detail（可能是服务器原文）。
   */
  private async markDown(error: unknown, where: 'start' | 'ensure'): Promise<void> {
    const first = !this.down;
    this.down = true;
    if (!first) return;
    const kind = classifyMailFailure(error);
    const when = where === 'start' ? '启动时' : '连接时';
    await this.emit(
      'mail.down',
      '邮箱没能用起来（' + when + '：' + RECEIPT_LABEL[kind] + '）。'
        + '工具会按失败回报，World 不消失；具体原因看工具回执或 data/logs/core.log。',
    );
  }

  /** 一轮收信之后的投递：有新增才投摘要（external），扫完必投一条只落库的 scanned（internal）。 */
  private async publish(outcome: ScanOutcome): Promise<void> {
    if (outcome.added.length > 0) {
      const maxChars = clampInt(this.opts.cfg.digestMaxChars, 800, 200, 8000);
      const text = digest(outcome.added, { maxChars });
      if (text.trim() !== '') {
        const deliver = this.opts.cfg.deliverDigest !== false;
        // 全包唯一允许带第三方文本的通道：origin 必须是 external。
        await this.emit('mail.new', text, { origin: 'external', deliver, trigger: 'debounce' });
        outcome.delivered = deliver;
      }
    }
    // scanned 也是 internal：只放文件夹名（配置值）与计数，绝不出现主题/发件人。
    const parts = outcome.perFolder.map(
      (one) => one.folder + ' 新增 ' + String(one.stored) + ' 封（共 ' + String(one.total) + ' 封）',
    );
    if (outcome.failures.length > 0) parts.push('失败 ' + String(outcome.failures.length) + ' 个文件夹');
    const head = '收信完成：新增 ' + String(outcome.added.length) + ' 封。';
    await this.emit('mail.scanned', head + (parts.length ? ' ' + parts.join('；') : ''), { deliver: false });
  }

  private async emit(
    type: string,
    text: string,
    o: { origin?: EventOrigin; deliver?: boolean; trigger?: TriggerMode } = {},
  ): Promise<void> {
    const host = this.host;
    if (host === null) return;
    try {
      // 宿主不回话不许把整轮收信（连带 scanning 锁）堵死：超时就只记日志，本轮照常结束。
      await withTimeout(
        host.pushEvent(
          {
            type,
            ts: this.nowIso(),
            source: this.id,
            origin: o.origin ?? 'internal',
            senderKey: this.id,
            text,
          },
          { deliver: o.deliver === undefined ? true : o.deliver, trigger: o.trigger },
        ),
        EVENT_PUSH_TIMEOUT_MS,
        'pushEvent(' + type + ')',
      );
    } catch (error) {
      this.warn('事件投递失败：' + type + '（' + errorText(error) + '）');
    }
  }

  private warn(message: string): void {
    try {
      this.host?.log.warn(message);
    } catch {
      // 日志失败也不许冒泡到调用方。
    }
  }

  // ───────────────────────── 服务与知识库 ─────────────────────────

  private buildService(): Mailbox {
    const factory = this.opts.serviceFactory ?? createMailbox;
    return factory(this.opts.cfg, {
      dataDir: this.opts.dataDir,
      secret: this.opts.secret,
      clock: this.opts.clock,
    });
  }

  /** 工具可能在 start 之前被调用（装配层的顺序不归我们管）：按需建服务，绝不抛。 */
  private async ensureService(): Promise<Mailbox> {
    if (this.service === null) this.service = this.buildService();
    return this.service;
  }

  private async safeStatus(service: Mailbox): Promise<MailboxStatus> {
    try {
      const status = await service.status();
      this.statusCache = status;
      return status;
    } catch (error) {
      this.warn('读取邮箱状态失败：' + errorText(error));
      const fallback: MailboxStatus = {
        mode: service.mode,
        connected: false,
        account: service.mode === 'demo' ? DEMO_ACCOUNT : String(this.opts.cfg.email ?? '').trim(),
        folders: [...this.configuredFolders],
        lastSyncAt: '',
      };
      return fallback;
    }
  }

  /** 逐条 has() 预检后再 put：put 只回计数，而摘要与回执需要「到底哪几封是新的」。 */
  private async store(items: StoredMail[]): Promise<{ added: StoredMail[]; skipped: number }> {
    const seen = new Set<string>();
    const fresh: StoredMail[] = [];
    let skipped = 0;
    for (const item of items) {
      if (seen.has(item.id)) {
        skipped += 1;
        continue;
      }
      seen.add(item.id);
      if (await this.vault.has(item.id)) {
        skipped += 1;
        continue;
      }
      fresh.push(item);
    }
    if (fresh.length === 0) return { added: [], skipped };
    const put = await this.vault.put(fresh);
    return { added: fresh, skipped: skipped + put.skipped };
  }

  // ───────────────────────── 定时器 ─────────────────────────

  /** 第一轮延迟：demo 3 秒（马上看到演示数据），live 60 秒（不在启动瞬间打服务器）。 */
  private firstScanDelayMs(): number {
    return this.opts.cfg.mode === 'live' ? LIVE_FIRST_SCAN_DELAY_MS : DEMO_FIRST_SCAN_DELAY_MS;
  }

  /** 排下一次收信。intervalMinutes=0 就一只定时器都不挂（PLAN 第 7 节：0＝只由工具触发）。 */
  private armNext(delayMs?: number): void {
    this.disarmTimer();
    const intervalMs = this.intervalMs();
    if (intervalMs === null) {
      this.nextScanAt = null;
      return;
    }
    const delay = delayMs === undefined ? this.nextDelay(intervalMs) : delayMs;
    const timers = this.opts.timers ?? GLOBAL_TIMERS;
    const handle = timers.setTimeout(() => {
      void this.tick();
    }, delay);
    const unref = (handle as { unref?: () => void }).unref;
    if (typeof unref === 'function') unref.call(handle);
    this.timer = handle;
    this.nextScanAt = new Date(this.now().getTime() + delay).toISOString();
  }

  private disarmTimer(): void {
    if (this.timer === null) return;
    const handle = this.timer;
    this.timer = null;
    (this.opts.timers ?? GLOBAL_TIMERS).clearTimeout(handle);
  }

  private intervalMs(): number | null {
    const minutes = Number(this.opts.cfg.intervalMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    return Math.max(1000, Math.round(minutes * 60_000));
  }

  private nextDelay(intervalMs: number): number {
    return this.cold ? this.firstScanDelayMs() : intervalMs;
  }

  /** 一跳：跑一轮，按结果决定下一跳；连不上也不许让 World 消失。 */
  private async tick(): Promise<void> {
    try {
      await this.scan();
    } catch (error) {
      this.failure = errorText(error);
      this.lastFailure = error;
      this.cold = false;
      this.warn('自动收信失败：' + errorText(error));
      // 启动后第一次自动收信就连不上（或登录被拒）＝「启动时连不上」：按 PLAN 第 7 节投一条 down。
      // 只投一次（markDown 自己按状态翻转去重），正文只有失败类别，不带服务器原文。
      await this.markDown(error, 'ensure');
    }
    if (this.cancelled) return;
    try {
      this.armNext();
    } catch (error) {
      this.failure = errorText(error);
      this.lastFailure = error;
    }
  }

  // ───────────────────────── 游标 ─────────────────────────

  private cursorPath(): string {
    return join(this.vaultDir, CURSOR_FILE);
  }

  private async loadCursor(): Promise<void> {
    if (this.cursorLoaded) return;
    this.cursorLoaded = true;
    let raw: string;
    try {
      raw = await readFile(this.cursorPath(), 'utf8');
    } catch {
      // 文件不存在是正常的第一次；不是错误。
      this.cursor = { folders: {} };
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<MailCursor>;
      const folders: Record<string, FolderCursor> = {};
      if (parsed && typeof parsed.folders === 'object' && parsed.folders !== null) {
        for (const [folder, value] of Object.entries(parsed.folders)) {
          if (!value || typeof value !== 'object') continue;
          const record = value as Partial<FolderCursor>;
          folders[folder] = {
            uidValidity: Number.isFinite(Number(record.uidValidity)) ? Number(record.uidValidity) : 1,
            lastUid: Number.isFinite(Number(record.lastUid)) ? Number(record.lastUid) : 0,
            lastSyncAt: typeof record.lastSyncAt === 'string' ? record.lastSyncAt : '',
          };
        }
      }
      this.cursor = { folders };
    } catch (error) {
      // 读得懂文件、读不懂内容：留着原文件当证据，别静默清零。
      await this.quarantine(this.cursorPath(), 'cursor.json 内容读不懂');
      this.cursor = { folders: {} };
      this.warn('cursor.json 内容读不懂，已另存：' + errorText(error));
    }
  }

  private async saveCursor(): Promise<void> {
    try {
      await writeFileAtomic(this.cursorPath(), JSON.stringify(this.cursor, null, 2) + '\n');
    } catch (error) {
      this.warn('游标没写进 cursor.json：' + errorText(error));
    }
  }

  /** 坏文件改名留下来，人还能看；不悄悄覆盖掉。 */
  private async quarantine(path: string, why: string): Promise<void> {
    const stamp = this.nowIso().replace(/[:.]/g, '-');
    try {
      await rename(path, path + '.bad-' + stamp);
    } catch {
      this.warn(why + '，而且改名失败：' + path);
    }
  }

  // ───────────────────────── 界面状态 ─────────────────────────

  /** 状态灯：error / online / loading / offline（框架按 state 显示，不从别处推断）。 */
  lampState(): WorldLamp['state'] {
    if (this.lastFailure !== null) return 'error';
    if (this.ready) return 'online';
    if (this.service !== null && this.service.mode === 'demo') return 'online';
    if (!this.opts.cfg.enabled) return 'offline';
    return this.startedAt === null ? 'offline' : 'loading';
  }

  /** 进模型前缀的一句话状态（envPromptVars 的 mail.status）。 */
  private statusText(): string {
    if (this.lastFailure !== null) {
      const kind = classifyMailFailure(this.lastFailure);
      return '邮箱现在不可用（' + RECEIPT_LABEL[kind] + '）：工具会按失败回报，具体原因看工具回执。';
    }
    if (this.opts.cfg.mode === 'demo') return MODEL.status.demo;
    if (this.ready) return MODEL.status.ready;
    if (this.startedAt !== null) return MODEL.status.starting;
    return MODEL.status.idle;
  }
}

/** 从整封邮件折出回信需要的头信息。 */
export function replyTargetOf(message: MailMessage, folder: string): ReplyTarget {
  const headers = message.headers ?? {};
  const replyTo = String(headers['reply-to'] ?? '').trim();
  const fromHeader = String(headers.from ?? '').trim();
  const parsedReplyTo = parseAddressValue(replyTo);
  const to = parsedReplyTo.length
    ? parsedReplyTo
    : message.from.length
      ? message.from.map((one) => ({ name: String(one.name ?? ''), address: String(one.address ?? '') }))
      : parseAddressValue(fromHeader);
  const inReplyTo = String(headers['in-reply-to'] ?? '').trim() || String(message.messageId ?? '').trim();
  const references = String(headers.references ?? '')
    .split(/\s+/)
    .map((one) => one.trim())
    .filter((one) => one.startsWith('<') && one.endsWith('>'));
  if (inReplyTo.startsWith('<') && !references.includes(inReplyTo)) references.push(inReplyTo);
  return {
    folder,
    uid: message.uid,
    subject: String(message.subject ?? ''),
    from: senderName(message),
    to,
    inReplyTo,
    references,
  };
}

/** 服务器端搜索退化成最近 N 封本地过滤时的过滤器（大小写不敏感的多关键词 AND）。 */
export function localFilter(
  headers: MailHeader[],
  o: { query: string; from?: string; since?: string },
): MailHeader[] {
  const words = String(o.query ?? '').trim().toLowerCase().split(/\s+/).filter((one) => one !== '');
  const from = String(o.from ?? '').trim().toLowerCase();
  const sinceMs = parseDayStart(o.since);
  return headers.filter((header) => {
    if (from !== '') {
      const who = (header.from ?? []).map((one) => one.name + ' ' + one.address).join(' ').toLowerCase();
      if (!who.includes(from)) return false;
    }
    if (sinceMs !== null) {
      const at = Date.parse(header.date);
      if (!Number.isFinite(at) || at < sinceMs) return false;
    }
    if (words.length === 0) return true;
    const hay = [header.subject, header.snippet, (header.from ?? []).map((one) => one.name + ' ' + one.address).join(' ')]
      .join(' ')
      .toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

function parseDayStart(value: unknown): number | null {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (text === '') return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}
