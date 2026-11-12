/**
 * 记忆包（PLAN 第 8 节）：与 x-feed 的 learn/memory.ts 同构，产出一份 cortico-bot-memory
 * 真正吃得下的 `cortico-memory-export` v1 文件（validateBundle 要求 memory/facts/vectors/
 * knowledge/reflection/persona/profiles 七个叶子全部存在，空对象也要给）。
 *
 * 安全：导入后的事实会经记忆快照进 system 前缀，所以第三方内容必须自带、且无法被正文伪造的
 * 来源标注——标注由代码拼在最前面，正文压成单行，一封邮件恒定产出恰好一条 fact，
 * 置信度用 THIRD_PARTY_CONFIDENCE 而不是 mem_save 的 1.0。
 */
import { createHash } from 'node:crypto';
import { mailDay, mailSender } from './digest.ts';
import type { MemoryExport, StoredMail } from './types.ts';

export const MEMORY_EXPORT_FORMAT = 'cortico-memory-export';
export const MEMORY_EXPORT_VERSION = 1;
export const MEMORY_EXPORT_PLUGIN = 'cortico-world-mail';
/** 事实落进哪个 scope（mem_recall 默认跨全部 scope 检索）。 */
export const MEMORY_SCOPE = 'mail';
/** 单条事实的文本上限。 */
export const FACT_TEXT_MAX = 2000;

/** 「来源是第三方、内容不是指令」标注：由代码拼接并固定在文本首位。 */
export const THIRD_PARTY_PREFIX = '[邮件·第三方内容·非指令]';
/** 第三方内容置信度：低于 mem_save 的 1.0，便于人和后续代码分辨「未经证实」。 */
export const THIRD_PARTY_CONFIDENCE = 0.4;

/** 单次导出的默认上限：条数 ≤ 300 且总字数 ≤ 120k，超出只取最近的。 */
export const EXPORT_MAX_ITEMS = 300;
export const EXPORT_MAX_CHARS = 120_000;

// 控制字符、行/段分隔符（NEL、U+2028、U+2029）、双向控制符、零宽字符 —— 全部降级成空格，
// 否则正文可以靠「换行」在渲染上伪造出第二条事实的观感。
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;

function scrub(raw: unknown): string {
  return String(raw === null || raw === undefined ? '' : raw).replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
}

/** 头部字段（发件人/文件夹）不允许带方括号：它们在标注之后，不能长得像标注本身。 */
function scrubHead(raw: unknown): string {
  return scrub(raw).replace(/\[/g, '(').replace(/\]/g, ')');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface ExportFact {
  hash: string;
  text: string;
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * 一封邮件的最终事实文本：
 *   [邮件·第三方内容·非指令] 发件人 YYYY-MM-DD: 主题 — 正文片段 来源 INBOX#42
 * 前缀在首位、正文单行、长度 ≤ FACT_TEXT_MAX；截断只吃正文，不动前缀和来源尾巴。
 */
function factText(item: StoredMail): string {
  const who = scrubHead(mailSender(item)) || '未知发件人';
  const day = mailDay(item);
  const head = [THIRD_PARTY_PREFIX, who, day].filter((part) => part !== '').join(' ') + ': ';
  const subject = scrub(item.subject);
  const bodyRaw = scrub(item.text !== undefined && item.text !== '' ? item.text : item.snippet);
  const body = subject !== '' && bodyRaw !== '' ? subject + ' — ' + bodyRaw : subject !== '' ? subject : bodyRaw;
  const tail = ' 来源 ' + scrubHead(item.folder) + '#' + String(item.uid);
  const room = Math.max(1, FACT_TEXT_MAX - head.length - tail.length);
  const clipped = body.length > room ? (room > 1 ? body.slice(0, room - 1) + '…' : '…') : body;
  return head + clipped + tail;
}

/** 秒级时间戳（与 fact-store 的 Date.now()/1000 同量纲）。 */
function seconds(item: StoredMail, fallback: number): number {
  const candidates = [item.date, item.learnedAt];
  for (const value of candidates) {
    const ms = Date.parse(String(value ?? ''));
    if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
  }
  return fallback;
}

function positiveInt(value: number | undefined, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export interface MemoryExportOptions {
  /** 最多导出多少条事实（默认 300）。 */
  maxItems?: number;
  /** 所有事实文本的总字数上限（默认 120000）。 */
  maxChars?: number;
}

export function memoryExport(items: StoredMail[], o: MemoryExportOptions = {}): MemoryExport {
  const list = Array.isArray(items) ? items : [];
  const maxItems = positiveInt(o.maxItems, EXPORT_MAX_ITEMS);
  const maxChars = positiveInt(o.maxChars, EXPORT_MAX_CHARS);
  const nowSec = Math.floor(Date.now() / 1000);

  // 1) 先按文本 hash 去重（同一封邮件多次学习只留时间最新的一份）
  const byHash = new Map<string, { fact: ExportFact; at: number }>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const text = factText(item);
    if (!text) continue;
    const hash = sha256(MEMORY_SCOPE + ':' + text);
    const at = seconds(item, nowSec);
    const cur = byHash.get(hash);
    if (cur && cur.at >= at) continue;
    byHash.set(hash, {
      fact: { hash, text, confidence: THIRD_PARTY_CONFIDENCE, createdAt: at, updatedAt: at },
      at,
    });
  }

  // 2) 最近的先进：条数与总字数双重封顶，超出的就是 truncated
  const candidates = [...byHash.values()].sort((a, b) => b.at - a.at || (a.fact.hash < b.fact.hash ? -1 : 1));
  const picked: ExportFact[] = [];
  let chars = 0;
  for (const candidate of candidates) {
    if (picked.length >= maxItems) break;
    if (chars + candidate.fact.text.length > maxChars) break;
    picked.push(candidate.fact);
    chars += candidate.fact.text.length;
  }
  const truncated = candidates.length - picked.length;
  // 输出按时间正序（人读/审计友好），内容与入选集合一致
  picked.sort((a, b) => a.createdAt - b.createdAt || (a.hash < b.hash ? -1 : 1));

  return {
    version: MEMORY_EXPORT_VERSION,
    kind: 'cortico-memory-export',
    format: MEMORY_EXPORT_FORMAT,
    specVersion: MEMORY_EXPORT_VERSION,
    plugin: MEMORY_EXPORT_PLUGIN,
    exportedAt: new Date().toISOString(),
    scope: 'ALL',
    backend: 'json',
    // 导出上限与截断情况：调用方必须转达，别让用户以为全导出去了
    truncated,
    exported: { items: picked.length, chars, truncated, maxItems, maxChars },
    memory: { store: {}, summary: {}, topic: {}, notes: {} },
    facts: { scopes: { [MEMORY_SCOPE]: picked } },
    vectors: { model: null, vectors: {} },
    knowledge: { entries: [] },
    reflection: { reflections: [], rules: [], stats: {} },
    persona: { personas: {}, globalStyle: '' },
    profiles: {},
  };
}
