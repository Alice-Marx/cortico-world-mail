/**
 * mail_list（PLAN 第 5 节）：列最新邮件头、不取正文、写进知识库。
 * 关键可用性断言（Lead 要求）：列表行必须以 `#uid` 开头，模型能把这个 uid 直接喂给 mail_read。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createVault } from '../src/vault/vault.ts';
import { join } from 'node:path';
import { callTool, makeFakeMailbox, makeWorld } from './world.support.ts';

function fake() {
  return makeFakeMailbox({
    mode: 'demo',
    folders: ['INBOX', '已发送'],
    mails: [
      {
        folder: 'INBOX',
        uid: 10,
        subject: '会议邀请',
        fromName: '王小明',
        date: '2026-11-08T02:00:00.000Z',
        snippet: '下周二下午三点开会',
        text: '下周二下午三点开会，地点在会议室 A。',
        seen: false,
      },
      {
        folder: 'INBOX',
        uid: 12,
        subject: '账单通知',
        fromName: '支付宝',
        date: '2026-11-09T06:30:00.000Z',
        snippet: '本月账单已出',
        text: '本月账单已出，请查看。',
        seen: true,
      },
      { folder: '已发送', uid: 3, subject: 'Re: 会议邀请', fromName: '我', snippet: '', seen: true },
    ],
    withSelectInfo: true,
  });
}

test('mail_list：列头部、带未读标记、不取正文、写进知识库', async () => {
  const service = fake();
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    const receipt = await callTool(built.world, 'mail_list');
    assert.equal(receipt.failed, false);
    assert.match(receipt.text, /\[列完了\] INBOX · 2 封（未读 1）/);
    assert.match(receipt.text, /· #12 支付宝 2026-11-09 06:30 账单通知/, '列表行：· #uid 发件人 时间 主题');
    assert.match(receipt.text, /· #10 王小明 2026-11-08 02:00 会议邀请 · 未读/);
    assert.ok(!receipt.text.includes('地点在会议室 A'), 'list 不许取正文');
    assert.equal(service.state.read.length, 0, 'list 不调 read');
    assert.match(receipt.text, /新入库 2 封/);

    const stats = await createVault(join(built.dir, 'mail')).stats();
    assert.equal(stats.items, 2, '结果写进知识库');
  } finally {
    await built.cleanup();
  }
});

test('mail_list → mail_read 端到端：从回执里正则取 uid 能直接读正文', async () => {
  const service = fake();
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    const listed = await callTool(built.world, 'mail_list');
    const uids = [...listed.text.matchAll(/· #(\d+) /g)].map((match) => Number(match[1]));
    assert.deepEqual(uids, [12, 10], '回执里每封都有可解析的 uid（新→旧）');

    const receipt = await callTool(built.world, 'mail_read', { uid: uids[1] });
    assert.equal(receipt.failed, false, '用列表里的 uid 读正文必须成功：' + receipt.text);
    assert.match(receipt.text, /\[读到了\] INBOX#10/);
    assert.match(receipt.text, /会议邀请/);
    assert.match(receipt.text, /下周二下午三点开会，地点在会议室 A。/);
  } finally {
    await built.cleanup();
  }
});

test('mail_list：unreadOnly 只列未读，limit 生效，folder 可选', async () => {
  const service = fake();
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX\n已发送', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    const unread = await callTool(built.world, 'mail_list', { unreadOnly: true });
    assert.match(unread.text, /1 封（未读 1）/);
    assert.ok(!unread.text.includes('账单通知'), '已读的不该出现');

    const one = await callTool(built.world, 'mail_list', { limit: 1 });
    assert.match(one.text, /1 封/);
    assert.match(one.text, /#12/);
    assert.ok(!one.text.includes('#10'), 'limit=1 只列最新一封');

    const sent = await callTool(built.world, 'mail_list', { folder: '已发送' });
    assert.match(sent.text, /\[列完了\] 已发送 · 1 封/);
    assert.match(sent.text, /#3/);
  } finally {
    await built.cleanup();
  }
});

test('mail_list：空文件夹给出明确的一句话', async () => {
  const service = makeFakeMailbox({ mode: 'demo', folders: ['INBOX', '垃圾邮件'], mails: [] });
  const built = await makeWorld({ cfg: { mode: 'demo', folders: '垃圾邮件', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    const receipt = await callTool(built.world, 'mail_list', { folder: '垃圾邮件' });
    assert.equal(receipt.failed, false);
    assert.match(receipt.text, /这个文件夹没有邮件/);
  } finally {
    await built.cleanup();
  }
});
