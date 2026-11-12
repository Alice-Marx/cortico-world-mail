/**
 * cortico-world-mail · MIME 解析 / 编码（PLAN.md §3.4）。
 *
 * 零第三方依赖，只用 node: 内建（node:buffer / node:crypto）。
 * 硬要求（测试逐条钉死）：
 * - 嵌套 multipart；multipart/alternative 优先 text/plain；只有 HTML 时用 htmlToText 补 text；
 * - charset 回退链：声明 charset → utf-8 → gb18030 → big5 → latin1；
 * - **任何坏输入都不抛未捕获异常**；上限 maxBytes 2 MiB / 头 256 KiB / maxParts 100 / maxDepth 10；
 * - 绝不把 HTML 原样交给上层（body.html 也是纯文本化结果）。
 *
 * 注意：本文件只 import 类型与 node: 内建，不 import 任何 cortico/*。
 */

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { MailAddress, MailAttachment, OutgoingMessage } from './types.ts';

// ───────────────────────── 上限常量（契约） ─────────────────────────

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
const MAX_HEADER_BYTES = 256 * 1024; // 256 KiB
const DEFAULT_MAX_PARTS = 100;
const DEFAULT_MAX_DEPTH = 10;

// ───────────────────────── 公共类型 ─────────────────────────

export interface ParsedMail {
  /** 原始头（折行已展开），键小写 */
  headers: Record<string, string>;
  body: { text: string; html: string };
  attachments: MailAttachment[];
  /**
   * 附加字段（不改 PLAN 契约）：触到 maxBytes / 头 256 KiB / maxParts / maxDepth 任一上限时为 true。
   * 上层可据此提示“报文过大/过深已截断”。
   */
  truncated?: boolean;
}

export interface ParseMailOptions {
  maxBytes?: number;
  maxParts?: number;
  maxDepth?: number;
}

// ───────────────────────── 小工具 ─────────────────────────

function toBuffer(bytes: Uint8Array): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

/** 把 bytes 解码成头文本：合法 UTF-8 用 UTF-8（兼容 QQ 的裸 8bit 头），否则按字节 1:1 的 latin1。 */
function decodeHeaderBytes(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return toBuffer(bytes).toString('latin1');
  }
}

function normalizeTextBody(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

// ───────────────────────── 头/体切分 ─────────────────────────

/**
 * 把原始报文切成头文本与体字节。
 * 支持 CRLFCRLF 与 LFLF 两种空行；没有空行时整段视作头。
 */
export function splitHeaderBody(raw: Uint8Array): { header: string; body: Uint8Array } {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(0);
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 0x0a) continue; // '\n'
    const prevIsCr = i > 0 && bytes[i - 1] === 0x0d;
    if (prevIsCr && bytes[i + 1] === 0x0d && bytes[i + 2] === 0x0a) {
      // CRLF CRLF：i-1=CR i=LF i+1=CR i+2=LF，正文从 i+3 开始
      return {
        header: decodeHeaderBytes(bytes.subarray(0, i - 1)),
        body: bytes.subarray(i + 3),
      };
    }
    if (bytes[i + 1] === 0x0a) {
      // LF LF：正文从 i+2 开始
      return {
        header: decodeHeaderBytes(bytes.subarray(0, prevIsCr ? i - 1 : i)),
        body: bytes.subarray(i + 2),
      };
    }
  }
  return { header: decodeHeaderBytes(bytes), body: new Uint8Array(0) };
}

// ───────────────────────── 头解析 ─────────────────────────

const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/**
 * 解析头文本：折行展开、键小写、值原样（仍可能含 RFC2047 encoded-word）。
 * 同名头（Received 等）以 ", " 连接，避免丢信息；坏行直接忽略。
 */
export function parseHeaders(headerText: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof headerText !== 'string' || headerText.length === 0) return out;
  const unfolded = headerText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]+/g, ' ');
  for (const line of unfolded.split('\n')) {
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!HEADER_NAME_RE.test(name)) continue;
    const value = line.slice(colon + 1).trim();
    if (out[name] === undefined) out[name] = value;
    else out[name] = `${out[name]}, ${value}`;
  }
  return out;
}

// ───────────────────────── RFC 2047 解码 ─────────────────────────

const ENCODED_WORD_RE = /=\?([^?\s*]+)(?:\*[^?\s]*)?\?([bBqQ])\?([^?\s]*)\?=/g;

/** 解码 RFC2047 B/Q encoded-word；相邻 encoded-word 之间的折行空白按 RFC2047 §6.2 丢弃。 */
export function decodeHeaderValue(value: string): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (!text || text.indexOf('=?') < 0) return text;
  let out = '';
  let last = 0;
  let lastWasEncoded = false;
  ENCODED_WORD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ENCODED_WORD_RE.exec(text)) !== null) {
    const between = text.slice(last, match.index);
    if (!(lastWasEncoded && /^[ \t\r\n]*$/.test(between))) out += between;
    out += decodeEncodedWord(match[1], match[2], match[3]);
    last = match.index + match[0].length;
    lastWasEncoded = true;
  }
  out += text.slice(last);
  return out;
}

function decodeEncodedWord(charset: string, encoding: string, payload: string): string {
  try {
    let bytes: Uint8Array;
    if (encoding === 'b' || encoding === 'B') {
      const cleaned = payload.replace(/[^A-Za-z0-9+/=]/g, '');
      bytes = new Uint8Array(Buffer.from(cleaned, 'base64'));
    } else {
      // Q 编码：'_' 代表空格，其余与 quoted-printable 相同
      bytes = new Uint8Array(decodeQuotedPrintable(Buffer.from(payload.replace(/_/g, ' '), 'latin1')));
    }
    if (bytes.length === 0) return '';
    return decodeCharset(bytes, charset);
  } catch {
    // 坏 encoded-word 原样保留，绝不抛
    return `=?${charset}?${encoding}?${payload}?=`;
  }
}

function hexValue(byte: number | undefined): number {
  if (byte === undefined) return -1;
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30; // 0-9
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37; // A-F
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57; // a-f
  return -1;
}

/** quoted-printable 解码到字节（软换行 =CRLF / =LF 直接删掉）；坏转义按字面保留。 */
function decodeQuotedPrintable(input: Buffer): Buffer {
  const out = Buffer.allocUnsafe(input.length);
  let w = 0;
  for (let i = 0; i < input.length; i += 1) {
    const byte = input[i];
    if (byte === 0x3d /* '=' */) {
      const next = input[i + 1];
      const next2 = input[i + 2];
      if (next === 0x0d && next2 === 0x0a) {
        i += 2;
        continue;
      }
      if (next === 0x0a) {
        i += 1;
        continue;
      }
      const hi = hexValue(next);
      const lo = hexValue(next2);
      if (hi >= 0 && lo >= 0) {
        out[w++] = hi * 16 + lo;
        i += 2;
        continue;
      }
      out[w++] = byte;
      continue;
    }
    out[w++] = byte;
  }
  return out.subarray(0, w);
}

// ───────────────────────── charset ─────────────────────────

const CHARSET_ALIASES: Record<string, string> = {
  utf8: 'utf-8',
  'utf-8': 'utf-8',
  'unicode-1-1-utf-8': 'utf-8',
  gb2312: 'gb18030',
  'gb-2312': 'gb18030',
  gbk: 'gb18030',
  gb18030: 'gb18030',
  'x-gbk': 'gb18030',
  cp936: 'gb18030',
  big5: 'big5',
  'big-5': 'big5',
  'big5-hkscs': 'big5',
  csbig5: 'big5',
  cn_big5: 'big5',
  latin1: 'latin1',
  'latin-1': 'latin1',
  'iso-8859-1': 'latin1',
  iso8859_1: 'latin1',
  '8859-1': 'latin1',
  'windows-1252': 'windows-1252',
  cp1252: 'windows-1252',
  ascii: 'utf-8',
  'us-ascii': 'utf-8',
  'ansi_x3.4-1968': 'utf-8',
  'utf-16': 'utf-16le',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  'ucs-2': 'utf-16le',
  'koi8-r': 'koi8-r',
  shift_jis: 'shift_jis',
  sjis: 'shift_jis',
  'iso-2022-jp': 'iso-2022-jp',
  'euc-jp': 'euc-jp',
  'euc-kr': 'euc-kr',
};

function normalizeCharset(charset: string | undefined | null): string | null {
  if (typeof charset !== 'string') return null;
  const cleaned = charset.trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (!cleaned) return null;
  return CHARSET_ALIASES[cleaned] ?? cleaned;
}

function tryDecodeText(buffer: Buffer, encoding: string): string | null {
  try {
    if (encoding === 'utf-16be') {
      const even = buffer.length - (buffer.length % 2);
      const swapped = Buffer.allocUnsafe(even);
      for (let i = 0; i + 1 < even; i += 2) {
        swapped[i] = buffer[i + 1];
        swapped[i + 1] = buffer[i];
      }
      return new TextDecoder('utf-16le', { fatal: true }).decode(swapped);
    }
    return new TextDecoder(encoding, { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

/**
 * 按声明 charset 解码，失败后按 utf-8 → gb18030 → big5 → latin1 回退；永不抛。
 */
export function decodeCharset(bytes: Uint8Array, charset?: string): string {
  const buffer = toBuffer(bytes instanceof Uint8Array ? bytes : new Uint8Array(0));
  if (buffer.length === 0) return '';
  const declared = normalizeCharset(charset);
  if (declared) {
    const decoded = tryDecodeText(buffer, declared);
    if (decoded !== null) return decoded;
  }
  for (const candidate of ['utf-8', 'gb18030', 'big5']) {
    const decoded = tryDecodeText(buffer, candidate);
    if (decoded !== null) return decoded;
  }
  return buffer.toString('latin1');
}

// ───────────────────────── transfer-encoding ─────────────────────────

/** base64 / quoted-printable / 7bit / 8bit / binary；未知编码按原样返回，永不抛。 */
export function decodeTransfer(bytes: Uint8Array, encoding: string): Uint8Array {
  const buffer = toBuffer(bytes instanceof Uint8Array ? bytes : new Uint8Array(0));
  const normalized = typeof encoding === 'string' ? encoding.trim().toLowerCase() : '';
  if (normalized === 'base64') {
    try {
      const cleaned = buffer.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
      return new Uint8Array(Buffer.from(cleaned, 'base64'));
    } catch {
      return new Uint8Array(buffer);
    }
  }
  if (normalized === 'quoted-printable') {
    return new Uint8Array(decodeQuotedPrintable(buffer));
  }
  return new Uint8Array(buffer);
}

// ───────────────────────── HTML → text ─────────────────────────

const HTML_BLOCK_TAGS =
  'p|div|li|tr|h[1-6]|blockquote|section|article|header|footer|table|thead|tbody|tfoot|ul|ol|dl|dd|dt|pre|form|figure|address|nav|main|aside|hr|title|head|body|html|center|fieldset|legend|figcaption|video|audio|canvas|iframe|noscript';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  zwj: '',
  zwnj: '',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  deg: '°',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  times: '×',
  divide: '÷',
  laquo: '«',
  raquo: '»',
  frac12: '½',
  plusmn: '±',
  micro: 'µ',
  dagger: '†',
  permil: '‰',
};

function decodeHtmlEntities(input: string): string {
  if (input.indexOf('&') < 0) return input;
  return input.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function extractHtmlAttr(attrs: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const match = re.exec(attrs);
  if (!match) return null;
  const raw = match[1] ?? match[2] ?? match[3] ?? '';
  return decodeHtmlEntities(raw);
}

function stripHtmlTags(value: string): string {
  return value.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, '');
}

function collapseInline(value: string): string {
  return decodeHtmlEntities(value).replace(/\s+/g, ' ').trim();
}

/**
 * HTML → 纯文本：去 script/style/注释，块级标签转换行，实体解码，连续空白压缩，
 * 链接保留 "文字 <url>"。永不抛。
 */
export function htmlToText(html: string): string {
  if (typeof html !== 'string' || html.length === 0) return '';
  let text = html;
  const links: Array<{ label: string; href: string }> = [];
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ');
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
  text = text.replace(/<(title|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_match, attrs: string, inner: string) => {
    const href = extractHtmlAttr(attrs, 'href');
    const label = collapseInline(stripHtmlTags(inner));
    if (!href) return label;
    const cleanHref = href.trim();
    if (!cleanHref || /^javascript:/i.test(cleanHref)) return label;
    if (!label) return cleanHref;
    if (label === cleanHref) return cleanHref;
    links.push({ label, href: cleanHref });
    // 用控制字符占位，避免后面的“去标签”把 <url> 当成标签吃掉
    return `\u0000A${links.length - 1}\u0000`;
  });
  text = text.replace(/<br\b[^>]*\/?>/gi, '\n');
  text = text.replace(/<\/?(?:td|th)\b[^>]*>/gi, ' ');
  text = text.replace(new RegExp(`</(?:${HTML_BLOCK_TAGS})\\s*>`, 'gi'), '\n');
  text = text.replace(new RegExp(`<(?:${HTML_BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n');
  text = text.replace(/<[^>]*>/g, '');
  text = decodeHtmlEntities(text);
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/[ \t\f\v]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{2,}/g, '\n');
  text = text.replace(/\u0000A(\d+)\u0000/g, (_match, index: string) => {
    const link = links[Number(index)];
    return link ? `${link.label} <${link.href}>` : '';
  });
  return text.trim();
}

// ───────────────────────── 地址 ─────────────────────────

function removeAddressComments(value: string): string {
  let out = '';
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (inQuote) {
      out += ch;
      if (ch === '\\' && i + 1 < value.length) {
        out += value[i + 1];
        i += 1;
        continue;
      }
      if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      out += ch;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

function sanitizeAddress(value: string): string {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/^[\s<]+/, '')
    .replace(/[\s>]+$/, '')
    .trim();
}

function findTopLevelColon(value: string): number {
  let inQuote = false;
  let angle = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (inQuote) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') inQuote = true;
    else if (ch === '<') angle += 1;
    else if (ch === '>') angle = Math.max(0, angle - 1);
    else if (ch === ':' && angle === 0) return i;
  }
  return -1;
}

function unquotePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return trimmed;
}

function splitAddressItems(value: string): string[] {
  const items: string[] = [];
  let current = '';
  let inQuote = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (inQuote) {
      current += ch;
      if (ch === '\\' && i + 1 < value.length) {
        current += value[i + 1];
        i += 1;
        continue;
      }
      if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      current += ch;
      continue;
    }
    if (ch === '<') {
      angle += 1;
      current += ch;
      continue;
    }
    if (ch === '>') {
      angle = Math.max(0, angle - 1);
      current += ch;
      continue;
    }
    if (ch === '(') {
      paren += 1;
      current += ch;
      continue;
    }
    if (ch === ')') {
      paren = Math.max(0, paren - 1);
      current += ch;
      continue;
    }
    if ((ch === ',' || ch === ';') && angle === 0 && paren === 0) {
      if (current.trim()) items.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) items.push(current);
  return items;
}

function parseSingleAddress(rawItem: string): MailAddress | null {
  let item = removeAddressComments(rawItem).trim();
  if (!item) return null;
  // 组语法 "Friends: a@example.com, b@example.com;" —— 去掉组名前缀
  const colon = findTopLevelColon(item);
  if (colon >= 0 && item.indexOf('<') < 0) {
    const rest = item.slice(colon + 1).trim();
    if (rest.includes('@')) item = rest;
  }
  const angleMatch = /^(.*?)<([^<>]*)>\s*$/s.exec(item);
  if (angleMatch) {
    const name = decodeHeaderValue(unquotePhrase(angleMatch[1])).trim();
    const address = sanitizeAddress(angleMatch[2]);
    if (!address || !address.includes('@')) return null;
    return { name, address };
  }
  const address = sanitizeAddress(item);
  if (!address || !address.includes('@')) return null;
  return { name: '', address };
}

/** 解析地址列表（逗号/分号分隔、引号名、angle-addr、组语法、RFC2047 显示名）。永不抛。 */
export function parseAddressList(value: string): MailAddress[] {
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  const out: MailAddress[] = [];
  for (const item of splitAddressItems(value)) {
    try {
      const address = parseSingleAddress(item);
      if (address) out.push(address);
    } catch {
      // 单个坏地址忽略，不影响其余
    }
  }
  return out;
}

/** 清洗头文本（去 CRLF / 控制字符），防止头注入。 */
function sanitizeHeaderText(value: string): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .trim();
}

function needsEncoding(text: string): boolean {
  return /[^\x20-\x7e]/.test(text);
}

function quoteDisplayName(name: string): string {
  if (/[()<>\[\]:;@\\,."]/.test(name) || /^[\s]|[\s]$/.test(name)) {
    return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return name;
}

/** 地址格式化为头值：显示名按需 RFC2047 编码 / 加引号；地址清洗掉 CRLF。 */
export function formatAddress(address: MailAddress): string {
  const raw = address && typeof address === 'object' ? address : { name: '', address: '' };
  const mailbox = sanitizeAddress(String(raw.address ?? ''));
  const name = sanitizeHeaderText(String(raw.name ?? ''));
  if (!mailbox) return name;
  if (!name) return mailbox;
  const display = needsEncoding(name) ? encodeHeaderValue(name) : quoteDisplayName(name);
  return `${display} <${mailbox}>`;
}

/**
 * RFC2047 B（UTF-8）编码；纯 ASCII 也编码（这是本函数契约），空串返回 ''。
 * 长文本按 UTF-8 字符边界切成多个 encoded-word，用 CRLF + SP 折行，每个 word <= 75 字符。
 */
export function encodeHeaderValue(text: string): string {
  const clean = sanitizeHeaderText(text);
  if (!clean) return '';
  const bytes = Buffer.from(clean, 'utf8');
  const chunkBytes = 45; // base64 后 60 字符 + 12 字符包装 = 72 <= 75
  const words: string[] = [];
  let start = 0;
  let length = 0;
  for (const char of Array.from(clean)) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (length + charBytes > chunkBytes && length > 0) {
      words.push(`=?UTF-8?B?${bytes.subarray(start, start + length).toString('base64')}?=`);
      start += length;
      length = 0;
    }
    length += charBytes;
  }
  if (length > 0) words.push(`=?UTF-8?B?${bytes.subarray(start, start + length).toString('base64')}?=`);
  return words.join('\r\n ');
}

// ───────────────────────── 头参数解析 ─────────────────────────

interface ParsedContentType {
  type: string;
  subtype: string;
  params: Record<string, string>;
}

function splitHeaderParams(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (inQuote) {
      current += ch;
      if (ch === '\\' && i + 1 < value.length) {
        current += value[i + 1];
        i += 1;
        continue;
      }
      if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      current += ch;
      continue;
    }
    if (ch === ';') {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

function parseParamValue(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return value;
}

function parseContentType(value: string | undefined): ParsedContentType {
  const fallback: ParsedContentType = { type: 'text', subtype: 'plain', params: {} };
  if (!value) return fallback;
  const segments = splitHeaderParams(value);
  const match = /^\s*([A-Za-z0-9!#$&^_.+-]+)\s*\/\s*([A-Za-z0-9!#$&^_.+-]+)/.exec(segments[0] ?? '');
  if (!match) return fallback;
  const params: Record<string, string> = {};
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf('=');
    if (eq < 0) continue;
    const key = segment.slice(0, eq).trim().toLowerCase();
    if (!key) continue;
    params[key] = parseParamValue(segment.slice(eq + 1));
  }
  return { type: match[1].toLowerCase(), subtype: match[2].toLowerCase(), params };
}

interface ParsedDisposition {
  type: string;
  params: Record<string, string>;
}

function parseContentDisposition(value: string | undefined): ParsedDisposition {
  const fallback: ParsedDisposition = { type: '', params: {} };
  if (!value) return fallback;
  const segments = splitHeaderParams(value);
  const type = (segments[0] ?? '').trim().toLowerCase();
  const params: Record<string, string> = {};
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf('=');
    if (eq < 0) continue;
    const key = segment.slice(0, eq).trim().toLowerCase();
    if (!key) continue;
    params[key] = parseParamValue(segment.slice(eq + 1));
  }
  return { type, params };
}

function decodeRfc2231(value: string): string | null {
  const first = value.indexOf("'");
  if (first < 0) return null;
  const second = value.indexOf("'", first + 1);
  if (second < 0) return null;
  const charset = value.slice(0, first);
  const encoded = value.slice(second + 1);
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i += 1) {
    const ch = encoded[i];
    if (ch === '%' && i + 2 < encoded.length + 1) {
      const hex = encoded.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    const code = encoded.charCodeAt(i);
    bytes.push(code <= 0xff ? code : 0x3f);
  }
  return decodeCharset(new Uint8Array(bytes), charset || 'utf-8');
}

function decodeFilenameParam(value: string | undefined): string {
  if (!value) return '';
  const rfc2231 = decodeRfc2231(value);
  if (rfc2231 !== null) return rfc2231;
  return decodeHeaderValue(value);
}

// ───────────────────────── multipart 切分 ─────────────────────────

function splitMultipartBody(body: Uint8Array, boundary: string): Uint8Array[] {
  const buffer = toBuffer(body);
  const text = buffer.toString('latin1');
  const delimiter = `--${boundary}`;
  const markers: Array<{ start: number; lineEnd: number; closing: boolean }> = [];
  let from = 0;
  for (;;) {
    const index = text.indexOf(delimiter, from);
    if (index < 0) break;
    const atLineStart = index === 0 || text[index - 1] === '\n';
    if (!atLineStart) {
      from = index + delimiter.length;
      continue;
    }
    const lineEnd = text.indexOf('\n', index);
    if (lineEnd < 0) {
      // boundary 就在报文末尾、没有结尾换行（嵌套 multipart 的父级截掉 CRLF 后常见）
      const tail = text.slice(index + delimiter.length).trim();
      if (tail === '' || tail === '--') {
        markers.push({ start: index, lineEnd: text.length, closing: tail === '--' });
      }
      break;
    }
    let rest = text.slice(index + delimiter.length, lineEnd);
    if (rest.endsWith('\r')) rest = rest.slice(0, -1);
    rest = rest.trim();
    if (rest !== '' && rest !== '--') {
      from = index + delimiter.length;
      continue;
    }
    markers.push({ start: index, lineEnd, closing: rest === '--' });
    from = lineEnd + 1;
    if (rest === '--') break;
  }
  const parts: Uint8Array[] = [];
  for (let i = 0; i < markers.length; i += 1) {
    const marker = markers[i];
    if (marker.closing) break;
    const contentStart = marker.lineEnd + 1;
    const next = markers[i + 1];
    let contentEnd = next ? next.start : text.length;
    // 下一个 boundary 前的 CRLF 属于分隔符，不属于内容
    if (contentEnd > contentStart && text[contentEnd - 1] === '\n') {
      contentEnd -= 1;
      if (contentEnd > contentStart && text[contentEnd - 1] === '\r') contentEnd -= 1;
    }
    if (contentEnd <= contentStart) continue;
    parts.push(new Uint8Array(buffer.subarray(contentStart, contentEnd)));
  }
  return parts;
}

// ───────────────────────── 递归解析 ─────────────────────────

interface Entity {
  headers: Record<string, string>;
  body: Uint8Array;
}

interface ParseContext {
  maxParts: number;
  maxDepth: number;
  parts: number;
  truncated: boolean;
  textParts: string[];
  htmlParts: string[];
  attachments: MailAttachment[];
}

function parseEntity(entity: Entity, depth: number, ctx: ParseContext): void {
  if (depth > ctx.maxDepth) {
    ctx.truncated = true;
    return;
  }
  const contentType = parseContentType(entity.headers['content-type']);
  const encoding = entity.headers['content-transfer-encoding'] ?? '';
  const disposition = parseContentDisposition(entity.headers['content-disposition']);

  if (contentType.type === 'multipart') {
    const boundary = contentType.params['boundary'];
    if (!boundary) return;
    if (depth >= ctx.maxDepth) {
      ctx.truncated = true;
      return;
    }
    const rawParts = splitMultipartBody(entity.body, boundary);
    for (const rawPart of rawParts) {
      if (ctx.parts >= ctx.maxParts) {
        ctx.truncated = true;
        break;
      }
      ctx.parts += 1;
      const split = splitHeaderBody(rawPart);
      let headerText = split.header;
      if (headerText.length > MAX_HEADER_BYTES) {
        headerText = headerText.slice(0, MAX_HEADER_BYTES);
        ctx.truncated = true;
      }
      parseEntity({ headers: parseHeaders(headerText), body: split.body }, depth + 1, ctx);
    }
    return;
  }

  let decoded: Uint8Array;
  try {
    decoded = decodeTransfer(entity.body, encoding);
  } catch {
    decoded = entity.body;
  }

  const isText = contentType.type === 'text';
  const isHtml = contentType.subtype === 'html';
  const filenameRaw =
    disposition.params['filename*'] ??
    contentType.params['name*'] ??
    disposition.params['filename'] ??
    contentType.params['name'] ??
    '';
  const filename = decodeFilenameParam(filenameRaw).trim();
  const inline = disposition.type === 'inline';
  const hasFilename = filename.length > 0;
  const isAttachment = disposition.type === 'attachment' || hasFilename || (!isText && contentType.type !== 'message');

  if (isText && !isAttachment) {
    let text = '';
    try {
      text = decodeCharset(decoded, contentType.params['charset']);
    } catch {
      text = '';
    }
    const bucket = isHtml ? ctx.htmlParts : ctx.textParts;
    if (bucket.length < 50) bucket.push(normalizeTextBody(text));
    return;
  }

  ctx.attachments.push({
    filename,
    contentType: `${contentType.type}/${contentType.subtype}`,
    size: decoded.length,
    inline,
  });
}

/**
 * 解析整封邮件；任何输入都不抛（坏报文返回尽量解析出的部分，最坏返回空结构）。
 * headers 为原始（折行展开、键小写）头；body.text 是纯文本，body.html 是 HTML 纯文本化结果。
 */
export function parseMail(raw: Uint8Array | string, options?: ParseMailOptions): ParsedMail {
  const empty: ParsedMail = { headers: {}, body: { text: '', html: '' }, attachments: [] };
  try {
    let bytes: Uint8Array;
    if (typeof raw === 'string') bytes = Buffer.from(raw, 'utf8');
    else if (raw instanceof Uint8Array) bytes = raw;
    else if (ArrayBuffer.isView(raw)) bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    else return empty;

    const maxBytes = normalizeLimit(options?.maxBytes, DEFAULT_MAX_BYTES);
    const maxParts = normalizeLimit(options?.maxParts, DEFAULT_MAX_PARTS);
    const maxDepth = normalizeLimit(options?.maxDepth, DEFAULT_MAX_DEPTH);

    let truncated = false;
    if (bytes.length > maxBytes) {
      bytes = bytes.subarray(0, maxBytes);
      truncated = true;
    }
    const split = splitHeaderBody(bytes);
    let headerText = split.header;
    if (headerText.length > MAX_HEADER_BYTES) {
      headerText = headerText.slice(0, MAX_HEADER_BYTES);
      truncated = true;
    }
    const headers = parseHeaders(headerText);
    const ctx: ParseContext = {
      maxParts,
      maxDepth,
      parts: 0,
      truncated: false,
      textParts: [],
      htmlParts: [],
      attachments: [],
    };
    parseEntity({ headers, body: split.body }, 0, ctx);

    const textPlain = ctx.textParts.find((part) => part.trim().length > 0) ?? '';
    const htmlRaw = ctx.htmlParts.find((part) => part.trim().length > 0) ?? '';
    const htmlText = htmlRaw ? htmlToText(htmlRaw) : '';
    const text = normalizeTextBody(textPlain || htmlText);
    return {
      headers,
      body: { text, html: htmlText },
      attachments: ctx.attachments,
      truncated: truncated || ctx.truncated,
    };
  } catch {
    return empty;
  }
}

// ───────────────────────── 生成 MIME ─────────────────────────

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** RFC5322 日期（固定 +0000，测试可注入 Date；避免本地时区让测试不稳定）。 */
function formatRfc5322Date(date: Date): string {
  return (
    `${WEEKDAYS[date.getUTCDay()]}, ${pad2(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())} +0000`
  );
}

function normalizeBodyForMime(value: string): string {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n/g, '\r\n');
}

function wrapBase64(value: string): string {
  if (!value) return '';
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += 76) chunks.push(value.slice(i, i + 76));
  return chunks.join('\r\n');
}

function makeBoundary(): string {
  let uuid = '';
  try {
    uuid = randomUUID().replace(/-/g, '');
  } catch {
    uuid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
  return `=_cortico_mail_${uuid}`;
}

function makeMessageId(fromAddress: string): string {
  const at = fromAddress.indexOf('@');
  let domain = at >= 0 ? fromAddress.slice(at + 1) : 'coopanion.local';
  domain = domain.replace(/[^A-Za-z0-9.-]/g, '');
  if (!domain) domain = 'coopanion.local';
  let id = '';
  try {
    id = randomUUID();
  } catch {
    id = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
  }
  return `<${id}@${domain}>`;
}

function sanitizeMessageId(value: string): string {
  const clean = String(value ?? '')
    .replace(/[\r\n\s]+/g, '')
    .replace(/[<>]/g, '')
    .trim();
  return clean ? `<${clean}>` : '';
}

function foldHeader(name: string, value: string): string {
  const prefix = `${name}: `;
  const max = 78;
  if (!value) return prefix;
  const tokens = String(value).split(' ');
  if (prefix.length + value.length <= max) return prefix + value;
  const lines: string[] = [];
  let line = prefix + tokens[0];
  for (const token of tokens.slice(1)) {
    if (line.length + 1 + token.length > max) {
      lines.push(line);
      line = ` ${token}`;
    } else {
      line += ` ${token}`;
    }
  }
  lines.push(line);
  return lines.join('\r\n');
}

function buildBase64Part(contentType: string, bodyText: string): string {
  const base64 = Buffer.from(normalizeBodyForMime(bodyText), 'utf8').toString('base64');
  return [
    `Content-Type: ${contentType}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(base64),
  ].join('\r\n');
}

/**
 * 生成完整 MIME 报文（CRLF、UTF-8 + base64 正文、RFC2047 头、头注入清洗）。
 * - Bcc 只用于 SMTP 信封，不写进 MIME 头（不暴露密送地址）；
 * - html 非空时生成 multipart/alternative（text/plain 在前），否则单段 text/plain；
 * - 所有头值先清洗 CRLF；Message-ID 缺省自动生成（由 send() 保证与 SendResult 一致）。
 */
export function buildMime(message: OutgoingMessage): string {
  const source = message && typeof message === 'object' ? message : ({} as OutgoingMessage);
  const from: MailAddress = {
    name: sanitizeHeaderText(String(source.from?.name ?? '')),
    address: sanitizeAddress(String(source.from?.address ?? '')),
  };
  const to = Array.isArray(source.to) ? source.to : [];
  const cc = Array.isArray(source.cc) ? source.cc : [];
  const subject = sanitizeHeaderText(String(source.subject ?? ''));
  const date = source.date instanceof Date && !Number.isNaN(source.date.getTime()) ? source.date : new Date();
  const messageId = sanitizeMessageId(String(source.messageId ?? '')) || makeMessageId(from.address);
  const html = source.html === undefined || source.html === null ? '' : String(source.html);
  const text = String(source.text ?? '');

  const headers: string[] = [];
  headers.push(`From: ${formatAddress(from)}`);
  if (to.length > 0) headers.push(foldHeader('To', to.map((address) => formatAddress(address)).join(', ')));
  if (cc.length > 0) headers.push(foldHeader('Cc', cc.map((address) => formatAddress(address)).join(', ')));
  headers.push(subject ? (needsEncoding(subject) ? `Subject: ${encodeHeaderValue(subject)}` : foldHeader('Subject', subject)) : 'Subject:');
  headers.push(`Date: ${formatRfc5322Date(date)}`);
  headers.push(`Message-ID: ${messageId}`);
  const inReplyTo = sanitizeMessageId(String(source.inReplyTo ?? ''));
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (Array.isArray(source.references)) {
    const references = source.references.map((item) => sanitizeMessageId(String(item ?? ''))).filter(Boolean);
    if (references.length > 0) headers.push(foldHeader('References', references.join(' ')));
  }
  headers.push('MIME-Version: 1.0');

  let body: string;
  if (html.trim().length > 0) {
    const boundary = makeBoundary();
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const textPart = buildBase64Part('text/plain', text);
    const htmlPart = buildBase64Part('text/html', html);
    body = [
      `--${boundary}`,
      textPart,
      `--${boundary}`,
      htmlPart,
      `--${boundary}--`,
      '',
    ].join('\r\n');
  } else {
    headers.push('Content-Type: text/plain; charset=UTF-8');
    headers.push('Content-Transfer-Encoding: base64');
    body = `${wrapBase64(Buffer.from(normalizeBodyForMime(text), 'utf8').toString('base64'))}\r\n`;
  }

  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}
