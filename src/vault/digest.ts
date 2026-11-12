/**
 * 对话摘要（PLAN 第 7、8 节）：紧凑中文行，给 mail.new 事件文本与工具回执用。
 *
 * 每封一行：`· <发件人> <时间> <主题>`（PLAN 第 8 节），后面按需追加正文片段——
 * PLAN 第 7 节要求 mail.new 的摘要含「发件人显示名、主题、时间、正文截断片段」。
 * 超预算即截断并标注省略条数。空数组返回 ''（没有内容就不该产生事件文本）。
 *
 * 这就是第三方内容唯一的对外出口：调用方必须把产物放进 origin='external' 的事件里。
 */
import type { StoredMail } from './types.ts';

/** 与配置项 digestMaxChars 默认值一致（PLAN 第 4 节）。 */
export const DIGEST_MAX_CHARS = 800;
/** 单行正文片段上限，防止一封长邮件占满整段摘要。 */
export const DIGEST_LINE_TEXT_MAX = 120;

/** 控制字符与行分隔符降级成空格：摘要一行必须真的是一行。 */
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]+/g;

function oneLine(raw: unknown, max: number): string {
  const flat = String(raw === null || raw === undefined ? '' : raw).replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (max <= 0 || flat.length <= max) return flat;
  return flat.slice(0, max - 1) + '…';
}

/** 摘要里的时间：优先邮件自己的日期，没有就用落库时间；只到天（摘要一行要短）。 */
export function mailDay(item: StoredMail): string {
  const candidates = [item.date, item.learnedAt];
  for (const value of candidates) {
    const ms = Date.parse(String(value ?? ''));
    if (Number.isFinite(ms)) return new Date(ms).toISOString().slice(0, 10);
  }
  return '';
}

/** 发件人显示名的兜底：没有就写我们自己的固定词，绝不把空串渲染成空白。 */
export function mailSender(item: StoredMail): string {
  const from = oneLine(item.from, 80);
  return from !== '' ? from : '未知发件人';
}

function renderLine(item: StoredMail): string {
  const parts = ['·', mailSender(item), mailDay(item), oneLine(item.subject, 120)];
  const head = parts.filter((part) => part !== '').join(' ');
  const snippet = oneLine(item.snippet, DIGEST_LINE_TEXT_MAX);
  return snippet !== '' ? head + ' — ' + snippet : head;
}

function footer(omitted: number): string {
  return '…（另有 ' + String(omitted) + ' 封未显示）';
}

/**
 * items 顺序原样保留；每封一行 `· 发件人 时间 主题 — 正文片段…`。
 * maxChars 缺省 DIGEST_MAX_CHARS；截断时末行补一条省略计数（放不下就连省略计数也不放）。
 */
export function digest(items: StoredMail[], o: { maxChars?: number } = {}): string {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '';
  const raw = Number(o.maxChars);
  const maxChars = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DIGEST_MAX_CHARS;

  const lines: string[] = [];
  for (const item of list) {
    const line = renderLine(item);
    if (line.trim()) lines.push(line);
  }
  if (!lines.length) return '';

  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const extra = (out.length ? 1 : 0) + lines[i].length;
    const omitted = lines.length - (out.length + 1);
    const reserve = omitted > 0 ? footer(omitted).length + 1 : 0;
    if (used + extra + reserve > maxChars) break;
    out.push(lines[i]);
    used += extra;
  }

  const omitted = lines.length - out.length;
  if (!out.length) {
    const only = footer(omitted);
    return only.length <= maxChars ? only : '';
  }
  let text = out.join('\n');
  if (omitted > 0) {
    const f = '\n' + footer(omitted);
    if (text.length + f.length <= maxChars) text += f;
  }
  return text;
}
