/**
 * 演示邮箱的守门测试。跑法：node --test tests/demo.test.ts
 *
 * 全部离线：demo 邮箱不联网、不读真实邮箱；临时目录用 mkdtempSync，测试结束删掉。
 * 时间用注入的 clock，不依赖真实日期（PLAN 第 11 节）。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DEMO_ACCOUNT,
  DEMO_CANARY,
  DEMO_FOLDERS,
  DEMO_MESSAGES,
  DEMO_OUTBOX_FILE,
  createDemoMailbox,
} from '../src/mail/demo.ts';
import { MailError } from '../src/mail/types.ts';

/** 固定时刻：2026-11-12 09:00 UTC，所有「几分钟前」都从它往前推。 */
const T0 = new Date('2026-11-12T09:00:00.000Z');
const MINUTE = 60_000;

interface TestContextLike {
  after(fn: () => void): void;
}

/** 每个用例一个临时 dataDir + 一个注入固定 clock 的演示邮箱，测试后清理。 */
function setup(t: TestContextLike, clock: () => Date = () => T0) {
  const dir = mkdtempSync(join(tmpdir(), 'cortico-mail-demo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, mailbox: createDemoMailbox({ dataDir: dir, clock }) };
}

function outboxLines(dir: string): Array<Record<string, unknown>> {
  return readFileSync(join(dir, DEMO_OUTBOX_FILE), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('演示常量：账号、文件夹、7 封邮件', () => {
  assert.equal(DEMO_ACCOUNT, 'demo@coopanion.local');
  assert.deepEqual([...DEMO_FOLDERS], ['INBOX', '已发送', '垃圾邮件']);
  assert.equal(DEMO_MESSAGES.length, 7, 'PLAN 3.5 要求 6–8 封中文演示邮件');
  assert.equal(DEMO_OUTBOX_FILE, 'demo-outbox.jsonl');
  assert.equal(DEMO_CANARY, 'IGNORE_PREVIOUS_INSTRUCTIONS');
});

test('DEMO_MESSAGES：主题覆盖快递/会议/账单/验证码/朋友/订阅/垃圾邮件', () => {
  const subjects = DEMO_MESSAGES.map((seed) => seed.subject).join('\n');
  for (const keyword of ['快件', '会议', '账单', '验证码', '吃饭', '周刊', '账户']) {
    assert.ok(subjects.includes(keyword), '演示邮件缺主题关键词：' + keyword);
  }
  assert.equal(DEMO_MESSAGES.filter((seed) => seed.folder === 'INBOX').length, 6);
  assert.equal(DEMO_MESSAGES.filter((seed) => seed.folder === '垃圾邮件').length, 1);
  assert.equal(DEMO_MESSAGES.filter((seed) => seed.folder === '已发送').length, 0);
  const keys = DEMO_MESSAGES.map((seed) => seed.folder + '#' + String(seed.uid));
  assert.equal(new Set(keys).size, keys.length, '(folder, uid) 不能重复');
});

test('DEMO_MESSAGES：日期相对 clock 往前推、部分未读、有 HTML、有中文附件名', () => {
  assert.equal(DEMO_MESSAGES.filter((seed) => !seed.seen).length, 3, '至少一部分未读');
  const ago = DEMO_MESSAGES.map((seed) => seed.minutesAgo);
  assert.ok(ago.includes(30), '0.5 小时');
  assert.ok(ago.includes(180), '3 小时');
  assert.ok(ago.includes(1440 + 0) && ago.includes(2 * 1440), '1 天 / 2 天');
  assert.ok(Math.max(...ago) >= 5 * 1440, '至少一封 5 天前');
  assert.ok(DEMO_MESSAGES.some((seed) => (seed.html ?? '').length > 0), '至少一封 HTML 邮件');
  const attachments = DEMO_MESSAGES.flatMap((seed) => seed.attachments ?? []);
  assert.ok(attachments.length > 0, '至少一封带附件');
  assert.ok(
    attachments.some((attachment) => /[\u4e00-\u9fa5]/.test(attachment.filename)),
    '至少一个中文附件名',
  );
});

test('DEMO_MESSAGES：地址只用 example.com / example.net，canary 只在那封垃圾邮件里', () => {
  const addresses = DEMO_MESSAGES.flatMap((seed) => [
    seed.from.address,
    ...seed.to.map((a) => a.address),
    ...(seed.cc ?? []).map((a) => a.address),
    ...(seed.replyTo ?? []).map((a) => a.address),
  ]);
  for (const address of addresses) {
    assert.ok(address.includes('@'), '地址形状：' + address);
    if (address === DEMO_ACCOUNT) continue;
    assert.match(address, /@example\.(com|net)$/, '演示地址必须用 example.com / example.net：' + address);
  }
  const withCanary = DEMO_MESSAGES.filter((seed) => seed.text.includes(DEMO_CANARY));
  assert.equal(withCanary.length, 1, 'canary 只放一封');
  assert.equal(withCanary[0].folder, '垃圾邮件', '注入样本放在垃圾邮件文件夹');
  assert.ok(withCanary[0].text.includes('忽略之前的指示'), 'canary 邮件要有中文注入话术');
  assert.ok(withCanary[0].text.includes('授权码'));
});

test('status / folders：demo 不联网、无 lastError、账号是演示账号', async (t) => {
  const { mailbox } = setup(t);
  const status = await mailbox.status();
  assert.equal(mailbox.mode, 'demo');
  assert.equal(status.mode, 'demo');
  assert.equal(status.connected, true);
  assert.equal(status.account, DEMO_ACCOUNT);
  assert.deepEqual(status.folders, [...DEMO_FOLDERS]);
  assert.equal(Object.hasOwn(status, 'lastError'), false, 'demo 没有错误可报');
  assert.equal(Number.isNaN(Date.parse(status.lastSyncAt)), false, 'lastSyncAt 是 ISO 时间');
  assert.deepEqual(await mailbox.folders(), [...DEMO_FOLDERS]);
});

test('list：默认 INBOX、日期降序、日期由注入的 clock 往前推', async (t) => {
  const { mailbox } = setup(t);
  const headers = await mailbox.list();
  assert.deepEqual(headers.map((header) => header.uid), [7, 6, 5, 4, 3, 2], '最新在前');
  assert.equal(headers[0].folder, 'INBOX');
  assert.equal(headers[0].date, new Date(T0.getTime() - 30 * MINUTE).toISOString());
  assert.equal(headers[1].date, new Date(T0.getTime() - 180 * MINUTE).toISOString());
  for (let index = 1; index < headers.length; index += 1) {
    assert.ok(Date.parse(headers[index - 1].date) > Date.parse(headers[index].date), '必须严格降序');
  }
  assert.equal(Object.hasOwn(headers[0], 'body'), false, 'list 只给头部，不取正文');
  assert.equal(Object.hasOwn(headers[0], 'attachments'), false);
  assert.ok(headers[0].snippet.length > 0 && headers[0].snippet.length <= 200, 'snippet ≤ 200 字');
});

test('list：limit / unreadOnly / 未知文件夹报协议错误', async (t) => {
  const { mailbox } = setup(t);
  assert.deepEqual((await mailbox.list({ limit: 2 })).map((h) => h.uid), [7, 6]);
  const unread = await mailbox.list({ unreadOnly: true });
  assert.deepEqual(unread.map((h) => h.uid), [7, 6], 'INBOX 里两封未读');
  for (const header of unread) assert.equal(header.flags.seen, false);
  await assert.rejects(
    mailbox.list({ folder: '不存在的文件夹' }),
    (error: unknown) => error instanceof MailError && error.code === 'protocol',
  );
});

test('read：正文、附件元信息、HTML 纯文本化结果、Reply-To', async (t) => {
  const { mailbox } = setup(t);
  const meeting = await mailbox.read(6);
  assert.equal(meeting.folder, 'INBOX');
  assert.equal(meeting.uid, 6);
  assert.match(meeting.subject, /项目周会/);
  assert.match(meeting.body.text, /议程/);
  assert.equal(meeting.hasAttachments, true);
  assert.equal(meeting.attachments.length, 1);
  assert.equal(meeting.attachments[0].filename, '会议议程.pdf');
  assert.equal(meeting.attachments[0].contentType, 'application/pdf');
  assert.equal(meeting.attachments[0].inline, false);
  assert.ok(meeting.attachments[0].size > 0);
  assert.match(meeting.headers['reply-to'] ?? '', /meeting@example\.net/);
  assert.ok(meeting.headers.date.length > 0);

  const weekly = await mailbox.read(3);
  assert.ok(weekly.body.text.length > 0);
  assert.ok(weekly.body.html.length > 0, 'HTML 邮件给纯文本化结果');
  assert.ok(!weekly.body.html.includes('<'), 'body.html 不能是原始 HTML（PLAN 3.4）');

  // 读出来的对象是副本：改它不影响下一次读。
  meeting.subject = '被改过';
  assert.match((await mailbox.read(6)).subject, /项目周会/);
});

test('read：maxChars 截断、未知 uid 报协议错误', async (t) => {
  const { mailbox } = setup(t);
  const truncated = await mailbox.read(2, { maxChars: 10 });
  assert.equal(truncated.body.text.length, 10);
  const full = await mailbox.read(2);
  assert.ok(full.body.text.length > 10);
  await assert.rejects(
    mailbox.read(999),
    (error: unknown) => error instanceof MailError && error.code === 'protocol',
  );
});

test('search：没配文件夹的路由、大小写、from/since/subject 过滤', async (t) => {
  const { mailbox } = setup(t);
  assert.deepEqual((await mailbox.search({ query: '账单' })).map((h) => h.uid), [5]);
  assert.deepEqual((await mailbox.search({ query: 'xiaolin' })).map((h) => h.uid), [2]);
  assert.deepEqual((await mailbox.search({ query: 'XIAOLIN' })).map((h) => h.uid), [2], '大小写不敏感');
  assert.deepEqual((await mailbox.search({ query: 'weekly' })).map((h) => h.uid), [3]);
  assert.deepEqual((await mailbox.search({ query: '会议', subject: '周会' })).map((h) => h.uid), [6]);
  assert.deepEqual((await mailbox.search({ query: '周末', from: '小林' })).map((h) => h.uid), [2]);
  assert.deepEqual((await mailbox.search({ query: '邮件', limit: 1 })).map((h) => h.uid), [7]);
  assert.deepEqual(await mailbox.search({ query: '' }), [], '空查询返回空，不发散');
});

test('search：since 过滤与多关键词 AND', async (t) => {
  const { mailbox } = setup(t);
  // T0=2026-11-12 09:00Z：近 30 分钟 / 3 小时 / 1 天 / 2 天的四封都在 11-10T00:00Z 之后。
  const recent = await mailbox.search({ query: '的', since: '2026-11-10' });
  assert.deepEqual(recent.map((h) => h.uid), [7, 6, 5], '更近的三封');
  const older = await mailbox.search({ query: '的', since: '2026-11-01' });
  assert.deepEqual(older.map((h) => h.uid), [7, 6, 5, 3, 2], 'since 放宽后多出更早的两封');
  // 多关键词按 AND：同一封里既要出现「项目」又要出现「周会」。
  assert.deepEqual((await mailbox.search({ query: '项目 周会' })).map((h) => h.uid), [6]);
  assert.deepEqual(await mailbox.search({ query: '项目 不存在的词' }), []);
});

test('search：canary 只在垃圾邮件文件夹里被搜到', async (t) => {
  const { mailbox } = setup(t);
  assert.deepEqual(await mailbox.search({ query: DEMO_CANARY }), [], 'INBOX 里没有 canary');
  const spam = await mailbox.search({ query: DEMO_CANARY, folder: '垃圾邮件' });
  assert.deepEqual(spam.map((h) => h.uid), [1]);
  assert.ok(spam[0].snippet.length <= 200);
});

test('send：不发送，只追加 <dataDir>/demo-outbox.jsonl 并返回 messageId', async (t) => {
  const { dir, mailbox } = setup(t);
  const result = await mailbox.send({
    to: [{ name: '示例收件人', address: 'friend@example.com' }],
    cc: [{ name: '', address: 'cc@example.net' }],
    subject: '周末见',
    text: '正文第一行\n正文第二行',
    inReplyTo: '<demo-friend-0002@example.net>',
    references: ['<demo-friend-0002@example.net>'],
  });
  assert.deepEqual(result.accepted, ['friend@example.com', 'cc@example.net']);
  assert.deepEqual(result.rejected, []);
  assert.match(result.messageId, /^<demo\.\d+\.\d+@demo\.coopanion\.local>$/);
  assert.ok(existsSync(join(dir, DEMO_OUTBOX_FILE)), '发件箱必须落盘');
  const lines = outboxLines(dir);
  assert.equal(lines.length, 1);
  const record = lines[0];
  assert.equal(record.sentAt, T0.toISOString());
  assert.equal(record.mode, 'demo');
  assert.equal(record.from, DEMO_ACCOUNT);
  assert.equal(record.subject, '周末见');
  assert.equal(record.text, '正文第一行\n正文第二行');
  assert.equal(record.inReplyTo, '<demo-friend-0002@example.net>');
  assert.deepEqual(record.references, ['<demo-friend-0002@example.net>']);
  assert.equal(record.messageId, result.messageId);
});

test('send：多封追加、收件人为空报协议错误', async (t) => {
  const { dir, mailbox } = setup(t);
  await mailbox.send({ to: [{ name: '', address: 'a@example.com' }], subject: '一', text: '1' });
  await mailbox.send({ to: [{ name: '', address: 'b@example.net' }], subject: '二', text: '2' });
  const lines = outboxLines(dir);
  assert.equal(lines.length, 2, '每封一行');
  assert.deepEqual(lines.map((line) => line.subject), ['一', '二']);
  await assert.rejects(
    mailbox.send({ to: [], subject: '空收件人', text: 'x' }),
    (error: unknown) => error instanceof MailError && error.code === 'protocol',
  );
});

test('close：幂等；关闭后命令报 dropped', async (t) => {
  const { mailbox } = setup(t);
  await mailbox.close();
  await mailbox.close(); // 第二次不抛
  await assert.rejects(
    mailbox.list(),
    (error: unknown) => error instanceof MailError && error.code === 'dropped',
  );
  await assert.rejects(
    mailbox.send({ to: [{ name: '', address: 'a@example.com' }], subject: 'x', text: 'y' }),
    (error: unknown) => error instanceof MailError && error.code === 'dropped',
  );
});

test('clock 注入：整体时间平移，日期跟着走', async (t) => {
  const later = setup(t, () => T0);
  const earlier = setup(t, () => new Date(T0.getTime() - 24 * 60 * MINUTE));
  const laterFirst = (await later.mailbox.list())[0];
  const earlierFirst = (await earlier.mailbox.list())[0];
  assert.equal(laterFirst.uid, earlierFirst.uid);
  assert.equal(
    Date.parse(laterFirst.date) - Date.parse(earlierFirst.date),
    24 * 60 * MINUTE,
    '两个 clock 差一天，第一封的日期也差一天',
  );
});
