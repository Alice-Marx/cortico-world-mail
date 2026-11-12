/**
 * 摘要（PLAN 第 7、8 节）：每封一行 `· 发件人 时间 主题 — 正文片段`，超预算截断并标注省略条数。
 * 这是 mail.new（external）事件正文的唯一生成器：断言它一行一封、不含完整正文、不回吐控制字符。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DIGEST_MAX_CHARS, DIGEST_LINE_TEXT_MAX, digest, mailDay, mailSender } from '../src/vault/digest.ts';
import type { StoredMail } from '../src/vault/types.ts';

function mail(over: Partial<StoredMail> = {}): StoredMail {
  return {
    id: over.id ?? 'INBOX#' + String(over.uid ?? 1),
    folder: over.folder ?? 'INBOX',
    uid: over.uid ?? 1,
    subject: over.subject ?? '快递到了',
    from: over.from ?? '京东物流',
    date: over.date ?? '2026-11-05T06:30:00.000Z',
    snippet: over.snippet ?? '您的包裹已放至门卫处',
    learnedAt: over.learnedAt ?? '2026-11-05T06:30:05.000Z',
    mode: over.mode ?? 'demo',
    ...(over.text === undefined ? {} : { text: over.text }),
  };
}

test('空输入返回空串：没有内容就不该产生事件文本', () => {
  assert.equal(digest([]), '');
  assert.equal(digest(undefined as unknown as StoredMail[]), '');
});

test('格式：· 发件人 时间 主题 — 正文片段，一封一行', () => {
  const text = digest([mail(), mail({ uid: 2, subject: '会议邀请', from: '王小明', date: '2026-11-04T01:00:00Z', snippet: '' })]);
  const lines = text.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '· 京东物流 2026-11-05 快递到了 — 您的包裹已放至门卫处');
  assert.equal(lines[1], '· 王小明 2026-11-04 会议邀请', '没有片段就只到主题');
});

test('时间取邮件日期（到天），没有日期回落到落库时间', () => {
  assert.equal(mailDay(mail({ date: '2026-11-05T06:30:00.000Z' })), '2026-11-05');
  assert.equal(mailDay(mail({ date: '', learnedAt: '2026-11-06T00:00:00Z' })), '2026-11-06');
  assert.equal(mailDay(mail({ date: '', learnedAt: '' })), '', '两个都是空就是空串');
  assert.equal(mailDay(mail({ date: '不是时间' })), '2026-11-05', '日期读不懂就回落到落库时间');
});

test('发件人为空时用固定词，不给空白', () => {
  assert.equal(mailSender(mail({ from: '' })), '未知发件人');
  const [line] = digest([mail({ from: '   ' })]).split('\n');
  assert.match(line, /未知发件人/);
});

test('maxChars：放不下的条目被截断，末行标注省略条数', () => {
  const items = Array.from({ length: 30 }, (_, index) =>
    mail({ uid: index + 1, subject: '第 ' + String(index + 1) + ' 封稍长一点的主题', snippet: '正文片段'.repeat(6) }),
  );
  const text = digest(items, { maxChars: 300 });
  assert.ok(text.length <= 300, '总长度不得超过上限：' + String(text.length));
  assert.match(text, /另有 \d+ 封未显示/);
});

test('正文片段截到 DIGEST_LINE_TEXT_MAX，不会把整封正文放进摘要', () => {
  const body = '很长的正文'.repeat(200);
  const text = digest([mail({ text: body, snippet: body })]);
  const line = text.split('\n')[0];
  assert.ok(line.length < 200, '单封摘要必须远短于正文：' + String(line.length));
  assert.ok(line.length <= DIGEST_LINE_TEXT_MAX + 60, '片段上限 + 头部字段');
  assert.ok(text.length < body.length / 2);
});

test('控制字符与换行被压平：一封邮件绝对只占一行', () => {
  const text = digest([
    mail({ from: 'A\nB', subject: '主题第一行\r\n第二行', snippet: '片段\u2028又一行' }),
    mail({ uid: 2, subject: '第二封' }),
  ]);
  const lines = text.split('\n');
  assert.equal(lines.length, 2, '两封两行：' + JSON.stringify(text));
  for (const line of lines) {
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u2028\u2029]/.test(line), '每行里不许有控制字符：' + JSON.stringify(line));
  }
});

test('极小上限：放不下一行时返回空串，而不是超长输出', () => {
  const items = [mail({ uid: 1 }), mail({ uid: 2 })];
  assert.equal(digest(items, { maxChars: 5 }), '');
});

test('默认上限用 DIGEST_MAX_CHARS', () => {
  const items = Array.from({ length: 50 }, (_, index) => mail({ uid: index + 1 }));
  const text = digest(items);
  assert.ok(text.length <= DIGEST_MAX_CHARS);
});
