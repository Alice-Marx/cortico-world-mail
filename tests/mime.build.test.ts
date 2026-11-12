/**
 * MIME 生成测试（PLAN.md §10，W1）。全部离线。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMime, decodeHeaderValue, encodeHeaderValue, parseAddressList, parseHeaders, parseMail } from '../src/mail/mime.ts';
import type { OutgoingMessage } from '../src/mail/types.ts';

function makeMessage(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    from: { name: '张三', address: 'zhang.san@example.com' },
    to: [{ name: '李四', address: 'li.si@example.net' }],
    cc: [],
    bcc: [],
    subject: '测试主题',
    text: '第一行\n第二行',
    date: new Date('2026-11-12T09:10:07Z'),
    messageId: '<fixed-build-001@example.com>',
    ...overrides,
  };
}

function splitMessage(mime: string): { head: string; body: string } {
  const index = mime.indexOf('\r\n\r\n');
  assert.ok(index > 0, '生成的 MIME 必须含空行');
  return { head: mime.slice(0, index), body: mime.slice(index + 4) };
}

function unfold(headers: Record<string, string>, key: string): string {
  return (headers[key] ?? '').replace(/\r?\n[ \t]+/g, ' ');
}

test('buildMime：单段纯文本结构（CRLF、UTF-8 + base64 正文）', () => {
  const mime = buildMime(makeMessage({ html: undefined }));
  assert.ok(mime.includes('\r\n'));
  assert.ok(!/[^\r]\n/.test(mime), '所有换行必须是 CRLF');
  const { head, body } = splitMessage(mime);
  assert.match(head, /^From: /m);
  assert.match(head, /^To: /m);
  assert.match(head, /^MIME-Version: 1\.0$/m);
  assert.match(head, /^Content-Type: text\/plain; charset=UTF-8$/m);
  assert.match(head, /^Content-Transfer-Encoding: base64$/m);
  assert.match(head, /^Message-ID: <fixed-build-001@example\.com>$/m);
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), '第一行\r\n第二行');
  const parsed = parseMail(mime);
  assert.equal(parsed.body.text, '第一行\n第二行');
  assert.deepEqual(parsed.attachments, []);
});

test('buildMime：中文主题按 RFC2047 B 编码且可解回', () => {
  const mime = buildMime(makeMessage());
  const headers = parseHeaders(splitMessage(mime).head);
  assert.match(headers.subject, /^=\?UTF-8\?B\?/);
  assert.equal(decodeHeaderValue(headers.subject), '测试主题');
});

test('buildMime：中文显示名在 From/To 里按 RFC2047 编码', () => {
  const mime = buildMime(makeMessage());
  const headers = parseHeaders(splitMessage(mime).head);
  assert.match(headers.from, /=\?UTF-8\?B\?/);
  assert.equal(parseAddressList(headers.from)[0].address, 'zhang.san@example.com');
  assert.equal(parseAddressList(headers.from)[0].name, '张三');
  assert.equal(parseAddressList(headers.to)[0].name, '李四');
});

test('buildMime：带 html 时生成 multipart/alternative（text/plain 在前）', () => {
  const mime = buildMime(makeMessage({ html: '<p>HTML <b>正文</b></p>' }));
  const { head, body } = splitMessage(mime);
  assert.match(head, /^Content-Type: multipart\/alternative; boundary="[^"]+"$/m);
  const boundaryMatch = /boundary="([^"]+)"/.exec(head);
  assert.ok(boundaryMatch);
  const boundary = boundaryMatch[1];
  const textIndex = body.indexOf('--' + boundary);
  const htmlIndex = body.indexOf('Content-Type: text/html');
  assert.ok(textIndex >= 0 && htmlIndex > textIndex, 'text/plain part 必须在 html part 之前');
  assert.ok(body.endsWith(`--${boundary}--\r\n`));
  const parsed = parseMail(mime);
  assert.equal(parsed.body.text, '第一行\n第二行');
  assert.equal(parsed.body.html, 'HTML 正文');
  assert.deepEqual(parsed.attachments, []);
});

test('buildMime：In-Reply-To / References 头', () => {
  const mime = buildMime(
    makeMessage({
      inReplyTo: '<parent@example.com>',
      references: ['<root@example.com>', '<parent@example.com>'],
    }),
  );
  const headers = parseHeaders(splitMessage(mime).head);
  assert.equal(headers['in-reply-to'], '<parent@example.com>');
  assert.equal(headers.references, '<root@example.com> <parent@example.com>');
});

test('buildMime：主题里的 CRLF 被清洗，不产生头注入', () => {
  const mime = buildMime(makeMessage({ subject: 'Hello\r\nBcc: evil@example.com' }));
  const { head } = splitMessage(mime);
  assert.ok(!/\r\nBcc:/i.test(head));
  assert.equal(head.match(/^Bcc:/gim), null);
  const headers = parseHeaders(head);
  assert.equal(headers.bcc, undefined);
  assert.equal(headers.subject, 'Hello Bcc: evil@example.com');
});

test('buildMime：地址与显示名里的 CRLF 被清洗', () => {
  const mime = buildMime(
    makeMessage({
      from: { name: 'A\r\nBcc: evil@example.com', address: 'x@example.com' },
      to: [{ name: 'B\r\nCc: evil@example.com', address: 'y@example.com' }],
    }),
  );
  const { head } = splitMessage(mime);
  assert.ok(!/\r\n(?:Bcc|Cc):/i.test(head));
  assert.equal(parseAddressList(parseHeaders(head).to)[0].address, 'y@example.com');
});

test('buildMime：Date 头按 RFC5322 输出（注入日期，UTC）', () => {
  const headers = parseHeaders(splitMessage(buildMime(makeMessage())).head);
  assert.equal(headers.date, 'Thu, 12 Nov 2026 09:10:07 +0000');
});

test('buildMime：Message-ID 透传，Bcc 不写进 MIME 头', () => {
  const mime = buildMime(
    makeMessage({
      bcc: [{ name: '', address: 'secret@example.com' }],
      messageId: '<abc.123@example.com>',
    }),
  );
  const { head } = splitMessage(mime);
  assert.equal(parseHeaders(head)['message-id'], '<abc.123@example.com>');
  assert.ok(!/^Bcc:/im.test(head));
  assert.ok(!mime.includes('secret@example.com'));
});

test('buildMime：长主题折行后仍可无损解码', () => {
  const subject = 'This is a very long subject line that definitely needs folding because it is much longer than the header limit allows for a single line of text';
  const mime = buildMime(makeMessage({ subject }));
  const { head } = splitMessage(mime);
  for (const line of head.split('\r\n')) assert.ok(line.length <= 998, `header line too long: ${line.length}`);
  const headers = parseHeaders(head);
  assert.equal(decodeHeaderValue(unfold(headers, 'subject')), subject);
});

test('buildMime：base64 正文每行不超过 76 字符', () => {
  const text = '内容行。'.repeat(120);
  const mime = buildMime(makeMessage({ text }));
  const { body } = splitMessage(mime);
  for (const line of body.split('\r\n').filter(Boolean)) assert.ok(line.length <= 76, `line length ${line.length}`);
  assert.equal(parseMail(mime).body.text, text);
});

test('encodeHeaderValue：长中文文本切成多个 encoded-word 且可解回', () => {
  const text = '很长的中文主题'.repeat(20);
  const encoded = encodeHeaderValue(text);
  assert.ok(encoded.includes('\r\n '), '长文本应折行成多个 encoded-word');
  for (const line of encoded.split('\r\n')) assert.ok(line.length <= 75);
  assert.equal(decodeHeaderValue(encoded), text);
});

test('buildMime：空主题 / 空正文也能被解析', () => {
  const mime = buildMime(makeMessage({ subject: '', text: '' }));
  const headers = parseHeaders(splitMessage(mime).head);
  assert.equal(headers.subject, '');
  const parsed = parseMail(mime);
  assert.equal(parsed.body.text, '');
});
