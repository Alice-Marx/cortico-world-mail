/**
 * 7 个工具的装配（PLAN 第 5 节）。
 *
 * 声明逐字取自 definition.ts 的 TOOL_SPECS：名字、description、parameters、tags 一个字节都不许改，
 * 否则 describe.json 与代码同源的那条测试会红。这个文件只做三件事：读参数、把结果写成回执、
 * 按 5 类失败把错误翻成人话（见 receipt.ts）。
 *
 * 发信门禁在 world.sendNow / world.replyNow 里（调用 service 之前就拦住）；这里只决定回执怎么写。
 * 正文只出现一次：mail_read 与 mail_send 的成功回执都是「头部各一行 + 正文一段」。
 *
 * 依赖方向：tools → world（只 import type）→ {...}；本文件对框架只 import type。
 */
import type { ToolDef, ToolOutcome } from 'cortico/core/types.ts';
import { FAILURE_ADVICE, FAILURE_LABEL, classifyFailure } from '../i18n.ts';
import type { MailAddress, MailHeader, MailMessage } from '../mail/types.ts';
import { TOOL_SPECS } from '../definition.ts';
import type {
  ComposeOutcome,
  ListOutcome,
  MailWorld,
  ReadOutcome,
  ReplyOutcome,
  ScanOutcome,
  SearchOutcome,
  StatusSnapshot,
} from '../world.ts';
import type { StoredMail } from '../vault/types.ts';
import {
  BadArgs,
  DATA_WARNING,
  RECEIPT_MAX_CHARS,
  clampInt,
  failureText,
  intArg,
  itemLine,
  limitReceipt,
  oneLine,
  optionalText,
  textArg,
} from './receipt.ts';

/** 地址的最低限度检查：有且只有一个 @、域名带点、无空白。 */
const ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 必填字符串（允许空串的场景用；to/query 这类另有非空检查）。 */
function stringArg(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new BadArgs(name + ' 必填，而且要是字符串。');
  return value;
}

/** 日期时间显示成 `YYYY-MM-DD HH:mm`（UTC）；解析不了就原样截短。 */
function formatWhen(raw: unknown): string {
  const text = String(raw ?? '').trim();
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return oneLine(text, 20);
  const iso = new Date(ms).toISOString();
  return iso.slice(0, 10) + ' ' + iso.slice(11, 16);
}

function formatAddress(address: MailAddress): string {
  const name = String(address.name ?? '').trim();
  const mail = String(address.address ?? '').trim();
  return name === '' ? mail : name + ' <' + mail + '>';
}

function formatSender(header: { from?: MailAddress[] }): string {
  const first = Array.isArray(header.from) ? header.from[0] : undefined;
  if (!first) return '未知发件人';
  const name = String(first.name ?? '').trim();
  return name !== '' ? name : String(first.address ?? '').trim() || '未知发件人';
}

function unreadMark(header: { flags?: { seen?: boolean } }): string {
  return header.flags && header.flags.seen === true ? '' : ' · 未读';
}

function formatBytes(bytes: number): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return String(n) + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/** 解析工具参数里的收件人：逗号分隔，支持 "名字 <a@b>" 与裸地址；不合法直接报参数错误。 */
function parseRecipients(raw: unknown, name: string): MailAddress[] {
  const text = optionalText(raw);
  if (text === '') throw new BadArgs(name + ' 不能是空的：至少一个邮箱地址，多个用逗号分隔。');
  const out: MailAddress[] = [];
  for (const part of text.split(/[,;]/)) {
    const piece = part.trim();
    if (piece === '') continue;
    const angled = /^(.*?)<([^<>]+)>$/.exec(piece);
    const display = angled ? angled[1].trim().replace(/^"([\s\S]*)"$/, '$1').trim() : '';
    const address = (angled ? angled[2] : piece).trim();
    if (!ADDRESS_RE.test(address)) {
      throw new BadArgs(name + ' 里有一个不是邮箱地址：「' + piece + '」。要写成 a@example.com，多个用逗号分隔。');
    }
    out.push({ name: display, address });
  }
  if (out.length === 0) throw new BadArgs(name + ' 里没有可用的邮箱地址。');
  return out;
}

/**
 * 邮件列表行（mail_list / mail_search / mail_recall 同一格式）：· #uid 发件人 时间 主题 · 未读。
 * uid 必须在行首露出——mail_read / mail_reply 的必填参数就是它，列表不带 uid 等于这两个工具用不了。
 */
function headerLine(header: MailHeader): string {
  return itemLine('#' + String(header.uid) + ' ' + formatSender(header), formatWhen(header.date), header.subject) + unreadMark(header);
}

/** 知识库条目的列表行：同样把 uid 露出来（来自哪封邮件要能回查）。 */
function recallLine(item: StoredMail): string {
  const who = item.from === '' ? '未知发件人' : item.from;
  const line = itemLine('#' + String(item.uid) + ' ' + who, formatWhen(item.date || item.learnedAt), item.subject);
  return line;
}

/** 收件人的可读列表。 */
function recipientLine(label: string, list: MailAddress[]): string | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  return label + '：' + list.map(formatAddress).join('、');
}

/** 把参数错误、5 类失败收在同一处。 */
async function guard(what: string, fn: () => Promise<string>): Promise<ToolOutcome> {
  try {
    return { text: limitReceipt(await fn()) };
  } catch (error) {
    if (error instanceof BadArgs) {
      return { text: limitReceipt('[参数不对] ' + what + '\n' + error.message), failed: true };
    }
    return { text: limitReceipt(failureText(error, what)), failed: true };
  }
}

// ───────────────────────── 各工具的回执行 ─────────────────────────

/** mail_status：模式、账号、文件夹、连接、上次同步、失败原因；不联网也可答。 */
function statusLines(snapshot: StatusSnapshot, world: MailWorld): string[] {
  const lines: string[] = [];
  const demo = snapshot.mode === 'demo';
  lines.push(
    demo
      ? '[模式] demo：内置演示邮箱，不联网、不需要凭据（账号 ' + snapshot.account + '）'
      : '[模式] live：连真实邮箱，收发都走网络（账号 ' + snapshot.account + '）',
  );

  if (snapshot.connected) {
    lines.push('[连接] 已连上');
  } else if (demo) {
    lines.push('[连接] 演示邮箱已载入');
  } else if (snapshot.lastError !== undefined) {
    const kind = classifyFailure(snapshot.lastError.code);
    lines.push('[连接] 没连上（' + FAILURE_LABEL[kind] + '）');
    lines.push('[该做什么] ' + FAILURE_ADVICE[kind]);
  } else {
    lines.push('[连接] 还没连：第一次收信时才建连，连接失败会自动再试一次');
  }

  const configFolders = snapshot.configFolders.length ? snapshot.configFolders : ['INBOX'];
  lines.push(
    '[文件夹] 配置 ' + String(configFolders.length) + ' 个：' + configFolders.join('、')
      + (snapshot.connected && snapshot.folders.length ? ' · 服务端 ' + String(snapshot.folders.length) + ' 个' : ''),
  );

  if (snapshot.lastError !== undefined && snapshot.lastError.code === 'no-config') {
    const kind = classifyFailure('no-config');
    lines.push('[失败原因] ' + FAILURE_LABEL[kind] + '：' + oneLine(snapshot.lastError.message, 300));
    lines.push('[该做什么] ' + FAILURE_ADVICE[kind]);
  }

  const intervalOff = !Number.isFinite(snapshot.intervalMinutes) || snapshot.intervalMinutes <= 0;
  let cadence: string;
  if (intervalOff) cadence = '自动收信已关闭（intervalMinutes=0），只能用工具手动触发';
  else if (snapshot.cold) cadence = '冷启动：' + (demo ? '3 秒' : '60 秒') + '后收第一轮，之后每 ' + String(snapshot.intervalMinutes) + ' 分钟一次';
  else cadence = '每 ' + String(snapshot.intervalMinutes) + ' 分钟一次';
  lines.push('[自动收信] ' + cadence + (snapshot.nextScanAt ? ' · 下一次约 ' + snapshot.nextScanAt : ''));
  lines.push(
    snapshot.lastScanAt !== null
      ? '[上次收信] ' + snapshot.lastScanAt + '（新增 ' + String(snapshot.lastScanAdded) + ' 封，累计 ' + String(snapshot.scans) + ' 轮）'
      : '[上次收信] 还没收过',
  );
  lines.push('[上次同步] ' + (snapshot.lastSyncAt !== '' ? snapshot.lastSyncAt : '还没同步过'));

  const stats = snapshot.vault;
  const folderCounts = Object.entries(stats.folders)
    .map(([folder, count]) => folder + ' ' + String(count))
    .join('、');
  lines.push(
    '[知识库] ' + String(stats.items) + ' 封 · ' + formatBytes(stats.bytes)
      + (stats.lastLearnedAt ? ' · 最后学到 ' + stats.lastLearnedAt : ' · 还是空的')
      + (folderCounts !== '' ? '（' + folderCounts + '）' : ''),
  );
  lines.push('[库目录] ' + world.knowledgeDir);
  return lines;
}

function listLines(outcome: ListOutcome, limitRequested: number): string[] {
  const unread = outcome.headers.filter((header) => header.flags.seen !== true).length;
  const lines: string[] = [];
  lines.push(
    '[列完了] ' + outcome.folder + ' · ' + String(outcome.headers.length) + ' 封（未读 ' + String(unread) + '）'
      + (outcome.stored > 0 ? ' · 新入库 ' + String(outcome.stored) + ' 封' : ' · 库里都有'),
  );
  if (outcome.headers.length === 0) {
    lines.push('（这个文件夹没有邮件）');
  } else {
    for (const header of outcome.headers) lines.push(headerLine(header));
    if (outcome.headers.length >= limitRequested) {
      lines.push('（只是一批：还有更早的没有列出来，用 limit 调大或去下一批）');
    }
  }
  lines.push(DATA_WARNING);
  return lines;
}

function attachmentLines(message: MailMessage): string[] {
  const list = Array.isArray(message.attachments) ? message.attachments : [];
  if (list.length === 0) return [];
  const shown = list.slice(0, 10).map((one) => {
    const size = formatBytes(one.size);
    return one.filename + '（' + (one.contentType || '未知类型') + '，' + size + (one.inline ? '，内联' : '') + '）';
  });
  const extra = list.length > 10 ? '…还有 ' + String(list.length - 10) + ' 个' : '';
  return ['[附件] ' + String(list.length) + ' 个：' + shown.join('、') + extra];
}

function readLines(outcome: ReadOutcome, world: MailWorld, maxChars: number): string[] {
  const message = outcome.message;
  const lines: string[] = [];
  lines.push(
    '[读到了] ' + outcome.folder + '#' + String(message.uid) + ' · ' + formatSender(message)
      + ' · ' + formatWhen(message.date) + ' · ' + (message.subject === '' ? '（无主题）' : message.subject),
  );
  lines.push(...attachmentLines(message));
  lines.push('[正文]');
  lines.push(message.body.text === '' ? '（这封没有可读的纯文本正文）' : message.body.text);
  if (outcome.truncated) lines.push('（正文按 worlds.mail.maxBodyChars=' + String(maxChars) + ' 截断）');
  if (outcome.markedSeen) lines.push('（已把这封标记为已读）');
  lines.push(outcome.stored ? '（已写入知识库：' + world.knowledgeDir + '）' : '（库里已有这封）');
  lines.push(DATA_WARNING);
  return lines;
}

function searchLines(outcome: SearchOutcome, query: string, from: string, since: string): string[] {
  const lines: string[] = [];
  lines.push(
    '[搜到 ' + String(outcome.headers.length) + ' 封] 关键词「' + query + '」'
      + (from !== '' ? ' · 发件人含「' + from + '」' : '')
      + (since !== '' ? ' · ' + since + ' 之后' : '')
      + ' · ' + outcome.folder,
  );
  if (outcome.headers.length === 0) {
    lines.push('服务器上没搜到。可以换个关键词，或者用 mail_list 看看最近的邮件。');
  } else {
    for (const header of outcome.headers) lines.push(headerLine(header));
  }
  if (outcome.degraded) {
    lines.push('[说明] 服务器端 SEARCH 不可用，这是最近一批邮件里本地过滤出来的结果，可能不全。');
  }
  lines.push(DATA_WARNING);
  return lines;
}

/** 发信回执（预览/已发共用）：正文只出现一次，收件人、抄送、密送、主题各一行。 */
function composeLines(outcome: ComposeOutcome): string[] {
  const draft = outcome.draft;
  const recipients: string[] = [];
  for (const line of [
    recipientLine('收件人', draft.to),
    recipientLine('抄送', draft.cc ?? []),
    recipientLine('密送', draft.bcc ?? []),
  ]) {
    if (line !== null) recipients.push(line);
  }
  const body = String(draft.text ?? '');
  const lines: string[] = [];
  if (!outcome.sent) {
    lines.push('[草案] 还没有发送：带 confirm: true 才会真的发。');
    lines.push(
      outcome.mode === 'demo'
        ? '模式：demo（内置演示邮箱；带 confirm 后只写进演示发件箱，不联网）'
        : '模式：live（真实发送，会发到互联网上）',
    );
    lines.push(...recipients);
    lines.push('主题：' + (draft.subject === '' ? '（无主题）' : draft.subject));
    lines.push('[正文]');
    lines.push(body === '' ? '（空正文）' : body);
    lines.push('确认无误后，用同样的内容带 confirm: true 再调一次。');
    return lines;
  }
  const result = outcome.result;
  const accepted = result && Array.isArray(result.accepted) ? result.accepted : [];
  const rejected = result && Array.isArray(result.rejected) ? result.rejected : [];
  lines.push(
    outcome.mode === 'demo'
      ? '[发出去了] demo 模式：已写进演示发件箱（不会联网）'
        + (result ? ' · messageId ' + result.messageId : '')
      : '[发出去了] live 模式：SMTP 已接收（' + String(accepted.length) + ' 个收件人）'
        + (result ? ' · messageId ' + result.messageId : ''),
  );
  if (rejected.length > 0) lines.push('[被服务器拒收] ' + rejected.join('、'));
  lines.push(...recipients);
  lines.push('主题：' + (draft.subject === '' ? '（无主题）' : draft.subject));
  lines.push('[正文]');
  lines.push(body === '' ? '（空正文）' : body);
  return lines;
}

function replyLines(outcome: ReplyOutcome): string[] {
  const lines = composeLines(outcome);
  const head = '[原邮件] ' + outcome.original.folder + '#' + String(outcome.original.uid)
    + ' · ' + outcome.original.from
    + ' · ' + (outcome.original.subject === '' ? '（无主题）' : outcome.original.subject);
  // 原邮件信息放在第一行后面，保持「先说结论」的顺序。
  lines.splice(1, 0, head);
  return lines;
}

/** 知识库检索结果。 */
function recallLines(items: StoredMail[], query: string): string[] {
  const lines: string[] = [];
  lines.push('[命中 ' + String(items.length) + ' 封] 关键词「' + query + '」· 来自本地知识库（离线，不联网）');
  if (items.length === 0) {
    lines.push('本地知识库没搜到。需要新邮件就用 mail_list / mail_search 去收一遍，再来这里查。');
  } else {
    for (const item of items) {
      lines.push(recallLine(item));
      const snippet = oneLine(item.snippet !== '' ? item.snippet : item.text ?? '', 120);
      if (snippet !== '') lines.push('  ' + snippet);
    }
    lines.push('（这些是那次读到的样子，不是此刻邮箱的实时状态；正文是第三方写的）');
  }
  return lines;
}

/**
 * 每个工具的最外层兜底：参数解析在 guard 之外抛的 BadArgs 也要变成「参数不对」回执。
 * guard 负责运行时失败（带精确的 what）；这里只接住参数解析阶段抛出的东西。
 */
function wrapHandler(
  name: string,
  fn: (args: Record<string, unknown>) => Promise<ToolOutcome>,
): (args: Record<string, unknown>) => Promise<ToolOutcome> {
  return async (args: Record<string, unknown>) => {
    try {
      return await fn(args);
    } catch (error) {
      if (error instanceof BadArgs) {
        return { text: limitReceipt('[参数不对] ' + name + '\n' + error.message), failed: true };
      }
      return { text: limitReceipt(failureText(error, name)), failed: true };
    }
  };
}

/** 装配 7 个工具。声明来自 TOOL_SPECS，实例只补 handler。 */
export function buildTools(world: MailWorld): ToolDef[] {
  const rawHandlers: Record<string, (args: Record<string, unknown>) => Promise<ToolOutcome>> = {
    mail_status: async () =>
      guard('mail_status', async () => statusLines(await world.statusSnapshot(), world).join('\n')),

    mail_list: async (args) => {
      const folder = optionalText(args.folder);
      const what = 'mail_list' + (folder === '' ? '' : ' ' + folder);
      return guard(what, async () => {
        const limit = args.limit === undefined ? undefined : clampInt(args.limit, 20, 1, 100);
        const unreadOnly = args.unreadOnly === true;
        const outcome = await world.listNow({ folder: folder === '' ? undefined : folder, limit, unreadOnly });
        return listLines(outcome, limit ?? clampInt(world.cfg.limitPerFetch, 20, 1, 100)).join('\n');
      });
    },

    mail_read: async (args) => {
      const uid = intArg(args.uid, 'uid', 1, Number.MAX_SAFE_INTEGER);
      const folder = optionalText(args.folder);
      const what = 'mail_read ' + (folder === '' ? '' : folder + '#') + String(uid);
      return guard(what, async () => {
        const maxChars = args.maxChars === undefined ? undefined : clampInt(args.maxChars, world.cfg.maxBodyChars, 200, 200_000);
        const outcome = await world.readNow(uid, { folder: folder === '' ? undefined : folder, maxChars });
        return readLines(outcome, world, maxChars ?? clampInt(world.cfg.maxBodyChars, 20_000, 200, 200_000)).join('\n');
      });
    },

    mail_search: async (args) => {
      const query = textArg(args.query, 'query');
      const from = optionalText(args.from);
      const since = optionalText(args.since);
      if (since !== '' && (!DAY_RE.test(since) || !Number.isFinite(Date.parse(since)))) {
        throw new BadArgs('since 要写成 YYYY-MM-DD（例如 2026-11-01），现在是「' + since + '」。');
      }
      const folder = optionalText(args.folder);
      const what = 'mail_search ' + query;
      return guard(what, async () => {
        const limit = args.limit === undefined ? undefined : clampInt(args.limit, 10, 1, 100);
        const outcome = await world.searchNow({
          query,
          folder: folder === '' ? undefined : folder,
          limit,
          from: from === '' ? undefined : from,
          since: since === '' ? undefined : since,
        });
        return searchLines(outcome, query, from, since).join('\n');
      });
    },

    mail_send: async (args) => {
      const to = parseRecipients(args.to, 'to');
      const cc = optionalText(args.cc) === '' ? [] : parseRecipients(args.cc, 'cc');
      const bcc = optionalText(args.bcc) === '' ? [] : parseRecipients(args.bcc, 'bcc');
      const subject = stringArg(args.subject, 'subject');
      const text = stringArg(args.text, 'text');
      const confirm = args.confirm === true;
      const what = '[预览] mail_send → ' + to.map((one) => one.address).join(', ');
      return guard(confirm ? 'mail_send → ' + to.map((one) => one.address).join(', ') : what, async () => {
        const outcome = await world.sendNow({ to, cc, bcc, subject, text }, confirm);
        return composeLines(outcome).join('\n');
      });
    },

    mail_reply: async (args) => {
      const uid = intArg(args.uid, 'uid', 1, Number.MAX_SAFE_INTEGER);
      const text = stringArg(args.text, 'text');
      const folder = optionalText(args.folder);
      const confirm = args.confirm === true;
      const what = 'mail_reply ' + (folder === '' ? '' : folder + '#') + String(uid);
      return guard(what, async () => {
        const outcome = await world.replyNow(uid, text, {
          folder: folder === '' ? undefined : folder,
          confirm,
        });
        return replyLines(outcome).join('\n');
      });
    },

    mail_recall: async (args) => {
      const query = textArg(args.query, 'query');
      return guard('mail_recall ' + query, async () => {
        const limit = clampInt(args.limit, 10, 1, 50);
        const items = await world.recallNow(query, limit);
        return recallLines(items, query).join('\n');
      });
    },
  };

  return TOOL_SPECS.map((spec) => {
    const raw = rawHandlers[spec.name];
    if (!raw) throw new Error('TOOL_SPECS 里的工具没有 handler：' + spec.name);
    return {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      tags: spec.tags,
      handler: wrapHandler(spec.name, raw),
    } as ToolDef;
  });
}

// 供测试直接断言的格式上限（PLAN 第 5 节）。
export { RECEIPT_MAX_CHARS };
