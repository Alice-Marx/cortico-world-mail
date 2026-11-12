/**
 * 邮件报文夹具（tests/fixtures/mail/**，W1 独占）。
 *
 * 所有夹具只用 example.com / example.net / example.org 地址，不含任何真实邮箱或凭据。
 * `.eml` 文件为方便人读用 LF 写；`loadFixture()` 读入时统一规范成 CRLF，
 * 与真实 SMTP/IMAP 报文一致（解析器本身两种换行都支持，测试里会分别覆盖）。
 *
 * 用法：
 *   import { loadFixture, loadGbkFixture, FIXTURE_NAMES } from './fixtures/mail/index.ts';
 *   const raw = loadFixture('plain-utf8.eml');        // Uint8Array（CRLF、UTF-8 字节）
 *   const gbk = loadGbkFixture();                      // Uint8Array（GBK 正文，测 charset 回退）
 */

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE_DIR = import.meta.dirname;

/** 已知夹具文件名（eml）。 */
export const FIXTURE_NAMES = [
  'plain-utf8.eml',
  'alternative.eml',
  'mixed-attachment.eml',
  'nested-multipart.eml',
  'rfc2047-subject.eml',
  'quoted-printable.eml',
  'broken.eml',
] as const;

export type FixtureName = (typeof FIXTURE_NAMES)[number];

function normalizeToCrlf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
}

/** 读夹具为 UTF-8 文本（保留原文件 LF）。 */
export function loadFixtureText(name: FixtureName | string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

/** 读夹具为字节（CRLF 规范化后的 UTF-8 字节），可直接喂给 mime.parseMail / 假 IMAP 服务器。 */
export function loadFixture(name: FixtureName | string): Uint8Array {
  const text = loadFixtureText(name);
  return new Uint8Array(Buffer.from(normalizeToCrlf(text), 'utf8'));
}

/** 读夹具为 CRLF 文本（调试/断言用）。 */
export function loadFixtureCrlfText(name: FixtureName | string): string {
  return normalizeToCrlf(loadFixtureText(name));
}

/**
 * GBK 正文夹具（正文不是合法 UTF-8，用字节构造）：
 * `Content-Type: text/plain; charset=GBK`，正文字节 = GBK 的「中文是中中文」。
 */
export function loadGbkFixture(): Uint8Array {
  const header = [
    'From: gbk.sender@example.com',
    'To: zhang.san@example.com',
    'Subject: =?GBK?B?1tDOxA==?=',
    'Date: Fri, 06 Nov 2026 09:00:00 +0800',
    'Message-ID: <gbk-007@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=GBK',
    'Content-Transfer-Encoding: 8bit',
    '',
    '',
  ].join('\r\n');
  // GBK: 中 D6D0 文 CEC4 是 CAC7 中 D6D0 文 CEC4
  const body = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4, 0xca, 0xc7, 0xd6, 0xd0, 0xce, 0xc4]);
  return new Uint8Array(Buffer.concat([Buffer.from(header, 'latin1'), Buffer.from(body)]));
}

/** 声明 charset 是错的（utf-8）但正文是 GBK，用来测回退链。 */
export function loadMislabelledCharsetFixture(): Uint8Array {
  const header = [
    'From: mislabelled@example.com',
    'To: zhang.san@example.com',
    'Subject: charset fallback',
    'Date: Fri, 06 Nov 2026 09:05:00 +0800',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    '',
  ].join('\r\n');
  const body = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]); // GBK 的「中文」，不是合法 UTF-8
  return new Uint8Array(Buffer.concat([Buffer.from(header, 'latin1'), Buffer.from(body)]));
}

/** 一个极小的纯 ASCII 报文，给假 IMAP 服务器默认数据集用。 */
export function makeTinyRawMessage(subject: string, body: string): string {
  return [
    'From: tiny.sender@example.com',
    'To: tiny.receiver@example.net',
    `Subject: ${subject}`,
    'Date: Wed, 05 Nov 2026 08:00:00 +0800',
    `Message-ID: <tiny-${Math.abs(subject.length)}@example.com>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
  ].join('\r\n');
}
