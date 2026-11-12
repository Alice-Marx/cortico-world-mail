/**
 * IMAP 修改版 UTF-7 文件夹名编解码（RFC 3501 §5.1.3，W1 独占文件）。
 *
 * 规则：
 * - 0x20–0x7E 的可打印 ASCII 原样输出，但 `&` 必须写成 `&-`；
 * - 其余字符按 UTF-16BE 字节序列做 base64，去掉 `=` 填充，把 `+` 换成 `,`，首尾加 `&` … `-`；
 * - 解码是反向过程，任何坏输入都原样保留、绝不抛异常（IMAP 文件夹名只用于显示/日志）。
 *
 * 典型例子：`~peter/mail/台北/日本語` ⇄ `~peter/mail/&U,BTFw-/&ZeVnLIqe-`。
 */

import { Buffer } from 'node:buffer';

/** 编码为 IMAP 修改版 UTF-7（纯 ASCII 输出）。 */
export function encodeImapUtf7(text: string): string {
  const source = typeof text === 'string' ? text : String(text ?? '');
  let out = '';
  let pending: number[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    const base64 = Buffer.from(pending)
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\//g, ',');
    out += `&${base64}-`;
    pending = [];
  };
  for (const char of Array.from(source)) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) {
      flush();
      out += char === '&' ? '&-' : char;
      continue;
    }
    // 非 ASCII（含代理对）一律进 UTF-16BE 缓冲
    for (let i = 0; i < char.length; i += 1) {
      const unit = char.charCodeAt(i);
      pending.push((unit >> 8) & 0xff, unit & 0xff);
    }
  }
  flush();
  return out;
}

/** 解码 IMAP 修改版 UTF-7；非法 `&…-` 序列原样保留，永不抛。 */
export function decodeImapUtf7(text: string): string {
  const source = typeof text === 'string' ? text : String(text ?? '');
  if (source.indexOf('&') < 0) return source;
  let out = '';
  let index = 0;
  while (index < source.length) {
    const amp = source.indexOf('&', index);
    if (amp < 0) {
      out += source.slice(index);
      break;
    }
    out += source.slice(index, amp);
    const dash = source.indexOf('-', amp + 1);
    if (dash < 0) {
      // 没有闭合 '-'：坏输入，原样保留剩余部分
      out += source.slice(amp);
      break;
    }
    if (dash === amp + 1) {
      out += '&';
      index = dash + 1;
      continue;
    }
    const payload = source.slice(amp + 1, dash);
    try {
      const base64 = payload.replace(/,/g, '/');
      const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(padded)) throw new Error('invalid modified base64');
      const bytes = Buffer.from(padded, 'base64');
      if (bytes.length === 0 || bytes.length % 2 !== 0) throw new Error('invalid utf-16 payload');
      const swapped = Buffer.allocUnsafe(bytes.length);
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        swapped[i] = bytes[i + 1];
        swapped[i + 1] = bytes[i];
      }
      out += swapped.toString('utf16le');
      index = dash + 1;
    } catch {
      // 坏序列（含 '&' 与 '-'）原样保留
      out += source.slice(amp, dash + 1);
      index = dash + 1;
    }
  }
  return out;
}

/**
 * 生成 IMAP 命令里的 mailbox 参数：先做修改版 UTF-7，再加双引号并转义 `\` / `"`。
 * IMAP quoted string 对 mailbox 永远合法（含空格、括号、UTF-7 中文名都安全）。
 */
export function quoteImapMailbox(name: string): string {
  const encoded = encodeImapUtf7(typeof name === 'string' ? name : String(name ?? ''));
  const escaped = encoded.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** 解析 LIST/STATUS 回来的 mailbox 参数（引号串或 atom），返回解码后的文件夹名。永不抛。 */
export function parseImapMailboxToken(token: string): string {
  const raw = typeof token === 'string' ? token.trim() : '';
  if (!raw) return '';
  let value = raw;
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    value = raw.slice(1, -1).replace(/\\(.)/g, '$1');
  } else if (raw.startsWith('{') && raw.endsWith('}')) {
    // literal 占位符不应传到这里，防御性返回空
    return '';
  }
  return decodeImapUtf7(value);
}
