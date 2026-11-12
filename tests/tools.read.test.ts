/**
 * mail_read（PLAN 第 5 节）：读正文、附件元信息、截断到 maxChars、按配置标已读、写进知识库。
 * 正文只出现一次（回执里不许重复）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createVault } from '../src/vault/vault.ts';
import { join } from 'node:path';
import { callTool, makeFakeMailbox, makeWorld } from './world.support.ts';

const BODY = '下周二下午三点开会，地点在会议室 A。请带上第三季度报表。';

function fake(options: { withMarkSeen?: boolean } = {}) {
  return makeFakeMailbox({
    mode: 'demo',
    folders: ['INBOX'],
    withSelectInfo: true,
    ...(options.withMarkSeen === true ? { withMarkSeen: true } : {}),
    mails: [
      {
        folder: 'INBOX',
        uid: 6,
        subject: '会议邀请',
        fromName: '王小明',
        fromAddress: 'wang@example.com',
        date: '2026-11-08T02:00:00.000Z',
        snippet: '下周二下午三点开会',
        text: BODY,
        attachments: [
          { filename: '会议议程.pdf', contentType: 'application/pdf', size: 12_288, inline: false },
          { filename: 'logo.png', contentType: 'image/png', size: 800, inline: true },
        ],
        headers: {
          from: '王小明 <wang@example.com>',
          'message-id': '<wm-1@example.com>',
          subject: '会议邀请',
        },
      },
    ],
  });
}

test('mail_read：头部一行、附件元信息、正文一次、写进知识库', async () => {
  const service = fake();
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    const receipt = await callTool(built.world, 'mail_read', { uid: 6 });
    assert.equal(receipt.failed, false);
    assert.match(receipt.text, /\[读到了\] INBOX#6 · 王小明 · 2026-11-08 02:00 · 会议邀请/);
    assert.match(receipt.text, /\[附件\] 2 个：会议议程\.pdf（application\/pdf，12\.0 KB）、logo\.png（image\/png，800 B，内联）/);
    assert.equal(receipt.text.split(BODY).length - 1, 1, '正文只许出现一次');
    assert.match(receipt.text, /\[正文\]/);
    assert.match(receipt.text, /已写入知识库/);

    const vault = createVault(join(built.dir, 'mail'));
    const [stored] = await vault.recent();
    assert.equal(stored.id, 'INBOX#6');
    assert.equal(stored.text, BODY, '正文进了知识库，mail_recall 之后能查到');
    assert.equal(stored.from, '王小明');
  } finally {
    await built.cleanup();
  }
});

test('mail_read：正文按 maxChars 截断，并说清是按哪个配置截的', async () => {
  const long = '很长的正文。'.repeat(200);
  const service = makeFakeMailbox({
    mode: 'demo',
    folders: ['INBOX'],
    mails: [{ folder: 'INBOX', uid: 1, subject: '长邮件', fromName: '甲', text: long }],
  });
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX', maxBodyChars: 300 }, service });
  try {
    await built.world.start(built.host.host);
    const receipt = await callTool(built.world, 'mail_read', { uid: 1, maxChars: 200 });
    assert.equal(receipt.failed, false);
    assert.match(receipt.text, /maxBodyChars=200 截断/);
    const bodyPart = receipt.text.slice(receipt.text.indexOf('[正文]'));
    assert.ok(!bodyPart.includes(long), '长正文不该整篇进回执');
    assert.ok(receipt.text.length < 3_000);
  } finally {
    await built.cleanup();
  }
});

test('markSeenOnRead=true：读正文顺手标已读；默认不标', async () => {
  const on = fake({ withMarkSeen: true });
  const marked = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX', markSeenOnRead: true }, service: on });
  try {
    await marked.world.start(marked.host.host);
    const receipt = await callTool(marked.world, 'mail_read', { uid: 6 });
    assert.match(receipt.text, /已把这封标记为已读/);
    assert.deepEqual(on.state.markSeen, [{ folder: 'INBOX', uid: 6 }]);
  } finally {
    await marked.cleanup();
  }

  const off = fake({ withMarkSeen: true });
  const untouched = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX', markSeenOnRead: false }, service: off });
  try {
    await untouched.world.start(untouched.host.host);
    await callTool(untouched.world, 'mail_read', { uid: 6 });
    assert.deepEqual(off.state.markSeen, [], '默认不许改服务器上的已读状态');
  } finally {
    await untouched.cleanup();
  }
});

test('mail_read 参数校验：uid 必填且要是正整数', async () => {
  const service = fake();
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    for (const args of [{}, { uid: 0 }, { uid: -1 }, { uid: 'abc' }, { uid: 1.5 }]) {
      const receipt = await callTool(built.world, 'mail_read', args);
      assert.equal(receipt.failed, true, '参数不对要 failed：' + JSON.stringify(args));
      assert.match(receipt.text, /\[参数不对\]/, JSON.stringify(args));
    }
    assert.equal(service.state.read.length, 0, '参数不对时一次 read 都不许发');
  } finally {
    await built.cleanup();
  }
});
