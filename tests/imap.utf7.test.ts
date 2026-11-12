/**
 * IMAP 修改版 UTF-7 文件夹名编解码测试（PLAN.md §10，W1）。
 * 全部离线：只测纯函数。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeImapUtf7,
  encodeImapUtf7,
  parseImapMailboxToken,
  quoteImapMailbox,
} from '../src/mail/imap-utf7.ts';

test('RFC 3501 示例：编码 台北/日本語', () => {
  assert.equal(encodeImapUtf7('~peter/mail/台北/日本語'), '~peter/mail/&U,BTFw-/&ZeVnLIqe-');
});

test('RFC 3501 示例：解码 &U,BTFw- / &ZeVnLIqe-', () => {
  assert.equal(decodeImapUtf7('~peter/mail/&U,BTFw-/&ZeVnLIqe-'), '~peter/mail/台北/日本語');
});

test('& 必须转义成 &- 并还原', () => {
  assert.equal(encodeImapUtf7('A&B'), 'A&-B');
  assert.equal(decodeImapUtf7('A&-B'), 'A&B');
  assert.equal(encodeImapUtf7('&'), '&-');
  assert.equal(decodeImapUtf7('&-'), '&');
});

test('中文文件夹名 round-trip（已发送 / 垃圾邮件 / 子文件夹）', () => {
  for (const name of ['INBOX', '已发送', '垃圾邮件', 'INBOX/子文件夹', '项目 2026']) {
    const encoded = encodeImapUtf7(name);
    assert.match(encoded, /^[\x20-\x7e]*$/);
    assert.equal(decodeImapUtf7(encoded), name);
  }
});

test('可打印 ASCII 特殊字符原样保留', () => {
  const name = 'a b(c)/d-e_f.g+h~i!';
  const encoded = encodeImapUtf7(name);
  assert.equal(encoded, name.replace(/&/g, '&-'));
  assert.equal(decodeImapUtf7(encoded), name);
});

test('空字符串与空文件夹名', () => {
  assert.equal(encodeImapUtf7(''), '');
  assert.equal(decodeImapUtf7(''), '');
  assert.equal(quoteImapMailbox(''), '""');
});

test('emoji（代理对）round-trip', () => {
  const name = '收件箱/📬';
  assert.equal(decodeImapUtf7(encodeImapUtf7(name)), name);
});

test('非 ASCII 连续段合并成一个 &…- 块', () => {
  assert.equal(encodeImapUtf7('中文'), '&Ti1lhw-');
  assert.equal(decodeImapUtf7('&Ti1lhw-'), '中文');
});

test('坏序列解码不抛、原样保留', () => {
  assert.doesNotThrow(() => decodeImapUtf7('&!!!-'));
  assert.equal(decodeImapUtf7('&!!!-'), '&!!!-');
  assert.equal(decodeImapUtf7('&abc'), '&abc'); // 没有闭合 '-'
  assert.equal(decodeImapUtf7('&'), '&');
  // 奇数长度 payload 不是合法 UTF-16 → 原样保留
  assert.equal(decodeImapUtf7('&U-'), '&U-');
});

test('quoteImapMailbox 生成合法 quoted string 并转义', () => {
  assert.equal(quoteImapMailbox('已发送'), '"&XfJT0ZAB-"');
  assert.equal(quoteImapMailbox('INBOX'), '"INBOX"');
  assert.equal(quoteImapMailbox('a"b\\c'), '"a\\"b\\\\c"');
});

test('parseImapMailboxToken 解析引号串与 atom', () => {
  assert.equal(parseImapMailboxToken('"&XfJT0ZAB-"'), '已发送');
  assert.equal(parseImapMailboxToken('INBOX'), 'INBOX');
  assert.equal(parseImapMailboxToken('"a\\"b"'), 'a"b');
});
