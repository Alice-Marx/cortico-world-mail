/**
 * MIME 解析测试（PLAN.md §10，W1）。全部离线，只用 tests/fixtures/mail/** 夹具。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  decodeCharset,
  decodeHeaderValue,
  decodeTransfer,
  htmlToText,
  parseAddressList,
  parseHeaders,
  parseMail,
  splitHeaderBody,
  formatAddress,
} from '../src/mail/mime.ts';
import {
  loadFixture,
  loadFixtureCrlfText,
  loadGbkFixture,
  loadMislabelledCharsetFixture,
} from './fixtures/mail/index.ts';

function bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'utf8'));
}

function text(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

// ───────────────────────── splitHeaderBody / parseHeaders ─────────────────────────

test('splitHeaderBody：CRLF 空行切头与正文', () => {
  const split = splitHeaderBody(bytes('A: b\r\n\r\nbody'));
  assert.equal(split.header, 'A: b');
  assert.equal(text(split.body), 'body');
});

test('splitHeaderBody：LF-only 空行也能切', () => {
  const split = splitHeaderBody(bytes('A: b\n\nbody'));
  assert.equal(split.header, 'A: b');
  assert.equal(text(split.body), 'body');
});

test('splitHeaderBody：没有空行时整段当头部、正文为空', () => {
  const split = splitHeaderBody(bytes('A: b\r\nB: c'));
  assert.equal(split.header, 'A: b\r\nB: c');
  assert.equal(split.body.length, 0);
});

test('parseHeaders：折行展开、键小写、重复头合并且忽略坏行', () => {
  const headers = parseHeaders(
    ['Subject: =?UTF-8?B?5L2g5aW9?=', '\tand more', 'Received: a', 'received: b', 'no-colon-line', 'X: y'].join(
      '\r\n',
    ),
  );
  assert.equal(headers.subject, '=?UTF-8?B?5L2g5aW9?= and more');
  assert.equal(headers.received, 'a, b');
  assert.equal(headers.x, 'y');
  assert.equal(headers['no-colon-line'], undefined);
});

// ───────────────────────── 整封报文（夹具） ─────────────────────────

test('纯文本 UTF-8 报文：正文、头原值、无附件', () => {
  const parsed = parseMail(loadFixture('plain-utf8.eml'));
  assert.equal(parsed.body.text, '你好，这是一封纯文本邮件。\n第二行。\n');
  assert.equal(parsed.body.html, '');
  assert.deepEqual(parsed.attachments, []);
  assert.equal(decodeHeaderValue(parsed.headers.subject), '纯文本邮件，你好');
  assert.equal(parsed.headers['message-id'], '<plain-001@example.com>');
  assert.equal(parsed.truncated, false);
});

test('multipart/alternative：text/plain 优先，html 字段是纯文本化结果', () => {
  const parsed = parseMail(loadFixture('alternative.eml'));
  assert.equal(parsed.body.text, '你好，这是纯文本邮件');
  assert.equal(parsed.body.html, '你好，这是 HTML 邮件\n点这里 <https://example.com/link>');
  assert.ok(!parsed.body.html.includes('<b>'), 'html 字段不得保留标签');
  assert.deepEqual(parsed.attachments, []);
});

test('只有 HTML 的 alternative：用 htmlToText 补 text', () => {
  const raw = [
    'Content-Type: multipart/alternative; boundary="only-html"',
    '',
    '--only-html',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    '<html><body><p>只有 HTML</p></body></html>',
    '--only-html--',
    '',
  ].join('\r\n');
  const parsed = parseMail(raw);
  assert.equal(parsed.body.text, '只有 HTML');
  assert.equal(parsed.body.html, '只有 HTML');
});

test('multipart/mixed：附件元信息（中文名 RFC2047、大小、inline=false）', () => {
  const parsed = parseMail(loadFixture('mixed-attachment.eml'));
  assert.equal(parsed.body.text, '你好，这是一封纯文本邮件。\n第二行。');
  assert.equal(parsed.attachments.length, 1);
  const attachment = parsed.attachments[0];
  assert.equal(attachment.filename, '会议记录.txt');
  assert.equal(attachment.contentType, 'application/octet-stream');
  assert.equal(attachment.size, 27);
  assert.equal(attachment.inline, false);
});

test('嵌套 multipart：外层 mixed + 内层 alternative + 附件', () => {
  const parsed = parseMail(loadFixture('nested-multipart.eml'));
  assert.equal(parsed.body.text, '嵌套里的纯文本');
  assert.equal(parsed.body.html, '嵌套里的 HTML');
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].filename, 'notes.txt');
  assert.equal(parsed.attachments[0].contentType, 'text/plain');
  assert.equal(parsed.attachments[0].inline, false);
});

test('quoted-printable 正文（含软换行）', () => {
  const parsed = parseMail(loadFixture('quoted-printable.eml'));
  assert.equal(parsed.body.text, '你好， 这是 quoted-printable 正文，并带软换行。\n');
  assert.equal(decodeHeaderValue(parsed.headers.subject), '报价单 Q2');
});

test('GBK 声明 charset 的正文按 GBK 解码', () => {
  const parsed = parseMail(loadGbkFixture());
  assert.equal(parsed.body.text, '中文是中文');
  assert.equal(decodeHeaderValue(parsed.headers.subject), '中文');
});

test('声明 utf-8 但正文是 GBK：回退到 gb18030', () => {
  const parsed = parseMail(loadMislabelledCharsetFixture());
  assert.equal(parsed.body.text, '中文');
});

test('RFC2047 相邻 encoded-word 合并（fixture）', () => {
  const parsed = parseMail(loadFixture('rfc2047-subject.eml'));
  assert.equal(decodeHeaderValue(parsed.headers.subject), '相邻编码词');
});

// ───────────────────────── decodeHeaderValue ─────────────────────────

test('decodeHeaderValue：B/Q/GBK 与相邻词合并', () => {
  assert.equal(decodeHeaderValue('=?UTF-8?B?5L2g5aW9?='), '你好');
  assert.equal(decodeHeaderValue('=?UTF-8?Q?=E6=8A=A5=E4=BB=B7?='), '报价');
  assert.equal(decodeHeaderValue('=?GBK?B?1tDOxA==?='), '中文');
  assert.equal(decodeHeaderValue('=?UTF-8?B?5L2g?= =?GBK?B?1tDOxA==?='), '你中文');
  assert.equal(decodeHeaderValue('前缀 =?UTF-8?B?5L2g5aW9?= 后缀'), '前缀 你好 后缀');
});

test('decodeHeaderValue：坏 encoded-word 原样保留、不抛', () => {
  assert.equal(decodeHeaderValue('=?utf-8?X?abc?='), '=?utf-8?X?abc?='); // 非法编码字母
  assert.equal(decodeHeaderValue('plain text'), 'plain text');
  assert.doesNotThrow(() => decodeHeaderValue('=?UTF-8?B?!!!?='));
});

// ───────────────────────── charset ─────────────────────────

test('decodeCharset：UTF-8 / GBK / Big5 / latin1', () => {
  assert.equal(decodeCharset(bytes('中文'), 'utf-8'), '中文');
  assert.equal(decodeCharset(Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]), 'gbk'), '中文');
  assert.equal(decodeCharset(Uint8Array.from([0xa4, 0xa4, 0xa4, 0xe5]), 'big5'), '中文');
  assert.equal(decodeCharset(Uint8Array.from([0xe9, 0x74, 0xe9]), 'latin1'), 'été');
});

test('decodeCharset：未知名为空时走回退链，空输入返回空串', () => {
  assert.equal(decodeCharset(bytes('中文'), 'x-no-such-charset'), '中文');
  assert.equal(decodeCharset(bytes('中文'), undefined), '中文');
  assert.equal(decodeCharset(new Uint8Array(0), 'utf-8'), '');
});

// ───────────────────────── transfer-encoding ─────────────────────────

test('decodeTransfer：base64 忽略换行与空白', () => {
  const decoded = decodeTransfer(bytes('5L2g 5aW9\r\n5LiW55WM'), 'base64');
  assert.equal(text(decoded), '你好世界');
});

test('decodeTransfer：quoted-printable 的 =XX 与软换行', () => {
  const decoded = decodeTransfer(bytes('=E4=BD=A0=E5=A5=BD=\r\nworld'), 'quoted-printable');
  assert.equal(text(decoded), '你好world');
});

test('decodeTransfer：7bit/未知编码原样返回', () => {
  const input = Uint8Array.from([0x41, 0x0a, 0x42]);
  assert.deepEqual([...decodeTransfer(input, '7bit')], [...input]);
  assert.deepEqual([...decodeTransfer(input, 'x-unknown')], [...input]);
});

// ───────────────────────── htmlToText ─────────────────────────

test('htmlToText：去 script/style/注释、块转换行、实体解码、链接保留', () => {
  const html = [
    '<html><head><title>t</title><style>p{color:red}</style></head>',
    '<body><script>alert(1)</script><!-- 注释 -->',
    '<p>Hello&nbsp;&amp; <b>world</b></p>',
    '<a href="https://example.com/a">链接</a>',
    '<div>第二行</div><br>第三行</body></html>',
  ].join('');
  assert.equal(
    htmlToText(html),
    'Hello & world\n链接 <https://example.com/a>\n第二行\n第三行',
  );
});

test('htmlToText：无标签文本与空输入', () => {
  assert.equal(htmlToText('纯文本'), '纯文本');
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToText('<p>a</p><p>a</p>'), 'a\na');
});

// ───────────────────────── 地址 ─────────────────────────

test('parseAddressList：显示名/纯地址/RFC2047/引号逗号', () => {
  const addresses = parseAddressList(
    '"张三" <zhang@example.com>, li@example.com, =?UTF-8?B?546L5LqU?= <wang@example.net>, "Doe, Jane" <jane@example.org>',
  );
  assert.equal(addresses.length, 4);
  assert.deepEqual(addresses[0], { name: '张三', address: 'zhang@example.com' });
  assert.deepEqual(addresses[1], { name: '', address: 'li@example.com' });
  assert.deepEqual(addresses[2], { name: '王五', address: 'wang@example.net' });
  assert.deepEqual(addresses[3], { name: 'Doe, Jane', address: 'jane@example.org' });
});

test('parseAddressList：组语法、坏项跳过、空串', () => {
  const addresses = parseAddressList('Friends: a@example.com, b@example.com;');
  assert.deepEqual(
    addresses.map((item) => item.address),
    ['a@example.com', 'b@example.com'],
  );
  assert.deepEqual(parseAddressList('not-an-address, ok@example.com'), [
    { name: '', address: 'ok@example.com' },
  ]);
  assert.deepEqual(parseAddressList(''), []);
});

test('formatAddress：普通名/需要引号/中文编码/头注入清洗', () => {
  assert.equal(formatAddress({ name: 'Alice', address: 'alice@example.com' }), 'Alice <alice@example.com>');
  assert.equal(formatAddress({ name: '', address: 'bob@example.com' }), 'bob@example.com');
  assert.equal(formatAddress({ name: 'Doe, Jane', address: 'jane@example.com' }), '"Doe, Jane" <jane@example.com>');
  assert.equal(formatAddress({ name: '张三', address: 'zhang@example.com' }), '=?UTF-8?B?5byg5LiJ?= <zhang@example.com>');
  const injected = formatAddress({ name: 'A\r\nBcc: evil@example.com', address: 'x@example.com' });
  assert.ok(!injected.includes('\r') && !injected.includes('\n'));
  assert.ok(!/(^|\n)Bcc:/i.test(injected));
});

// ───────────────────────── 坏报文 / 上限 ─────────────────────────

test('parseMail：坏报文不抛，返回空结构', () => {
  assert.doesNotThrow(() => parseMail(loadFixture('broken.eml')));
  const parsed = parseMail(loadFixture('broken.eml'));
  assert.deepEqual(parsed.body, { text: '', html: '' });
  assert.deepEqual(parsed.attachments, []);
  assert.doesNotThrow(() => parseMail(Uint8Array.from([0, 255, 1, 2, 250])));
  assert.doesNotThrow(() => parseMail(''));
  assert.doesNotThrow(() => parseMail(new Uint8Array(0)));
});

test('parseMail：maxBytes 截断并标记，不抛', () => {
  const raw = `Subject: big\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${'A'.repeat(4000)}`;
  const parsed = parseMail(raw, { maxBytes: 200 });
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.body.text.length <= 200);
});

test('parseMail：maxParts 生效且标记截断', () => {
  const parts = Array.from({ length: 6 }, (_value, index) =>
    [
      `--parts-b`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      `第 ${index + 1} 段`,
    ].join('\r\n'),
  ).join('\r\n');
  const raw = [
    'Content-Type: multipart/mixed; boundary="parts-b"',
    '',
    parts,
    '--parts-b--',
    '',
  ].join('\r\n');
  const parsed = parseMail(raw, { maxParts: 2 });
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.body.text, '第 1 段');
});

test('parseMail：maxDepth 生效且标记截断', () => {
  const parsed = parseMail(loadFixture('nested-multipart.eml'), { maxDepth: 1 });
  assert.equal(parsed.truncated, true);
  assert.doesNotThrow(() => parseMail(loadFixture('nested-multipart.eml'), { maxDepth: 0 }));
});

test('parseMail：RFC2231 filename* 扩展参数解码', () => {
  const raw = [
    'Content-Type: multipart/mixed; boundary="rfc2231"',
    '',
    '--rfc2231',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    '正文',
    '--rfc2231',
    'Content-Type: application/pdf',
    "Content-Disposition: attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87.pdf",
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjQ=',
    '--rfc2231--',
    '',
  ].join('\r\n');
  const parsed = parseMail(raw);
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].filename, '中文.pdf');
  assert.equal(parsed.attachments[0].contentType, 'application/pdf');
});

test('parseMail：string 输入与 CRLF/LF 混排', () => {
  const parsed = parseMail('Subject: hi\r\n\r\nhello');
  assert.equal(parsed.headers.subject, 'hi');
  assert.equal(parsed.body.text, 'hello');
  assert.equal(parseMail(loadFixtureCrlfText('plain-utf8.eml')).body.text.includes('纯文本邮件'), true);
});

test('parseMail：头超过 256 KiB 时截断并标记，不抛', () => {
  const longHeader = Array.from({ length: 4000 }, (_value, index) => `X-Pad-${index}: ${'x'.repeat(80)}`).join(
    '\r\n',
  );
  const raw = `Subject: many\r\n${longHeader}\r\n\r\nbody`;
  assert.ok(raw.length > 256 * 1024);
  const parsed = parseMail(raw);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.body.text, 'body');
});
