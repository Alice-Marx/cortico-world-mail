/**
 * mail_reply（PLAN 第 5、9 节）：自动 Re: 主题、In-Reply-To/References，收件人取原邮件 Reply-To/From；
 * 与 mail_send 同一道危险门禁：不带 confirm:true 只返回预览草稿。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { callTool, makeFakeMailbox, makeWorld } from './world.support.ts';

const ORIGINAL_ID = '<orig-1@example.com>';
const REF_ID = '<thread-0@example.com>';

function fake(options: { replyTo?: string } = {}) {
  const headers: Record<string, string> = {
    from: '王小明 <wang@example.com>',
    'message-id': ORIGINAL_ID,
    'in-reply-to': REF_ID,
    references: REF_ID,
    subject: '会议邀请',
  };
  if (options.replyTo !== undefined) headers['reply-to'] = options.replyTo;
  return makeFakeMailbox({
    mode: 'demo',
    folders: ['INBOX'],
    mails: [
      {
        folder: 'INBOX',
        uid: 6,
        subject: '会议邀请',
        fromName: '王小明',
        fromAddress: 'wang@example.com',
        date: '2026-11-08T02:00:00.000Z',
        snippet: '下周二下午三点开会',
        text: '下周二下午三点开会。',
        headers,
      },
    ],
  });
}

test('不带 confirm：回执是 [草案] + [原邮件] INBOX#uid，收件人取 Reply-To，一次 send 都不发', async () => {
  const service = fake({ replyTo: 'reply@example.com' });
  const built = await makeWorld({ cfg: { mode: 'demo' }, service });
  try {
    await built.world.start(built.host.host);
    const receipt = await callTool(built.world, 'mail_reply', { uid: 6, text: '收到，我会准时到。' });
    assert.equal(receipt.failed, false);
    assert.match(receipt.text, /\[草案\] 还没有发送/);
    assert.match(receipt.text, /\[原邮件\] INBOX#6 · 王小明 · 会议邀请/, '预览要写清回的是哪封（Lead 要求）');
    assert.match(receipt.text, /收件人：reply@example\.com/, '收件人取 Reply-To');
    assert.match(receipt.text, /主题：Re: 会议邀请/);
    assert.equal(receipt.text.split('收到，我会准时到。').length - 1, 1);
    assert.equal(service.state.send.length, 0, '预览绝不许发');
  } finally {
    await built.cleanup();
  }
});

test('confirm=true：真的发，In-Reply-To/References 填对，收件人回落 From', async () => {
  const service = fake();
  const built = await makeWorld({ cfg: { mode: 'demo' }, service });
  try {
    await built.world.start(built.host.host);
    const receipt = await callTool(built.world, 'mail_reply', { uid: 6, text: '收到。', confirm: true });
    assert.equal(receipt.failed, false);
    assert.match(receipt.text, /\[发出去了\] demo 模式/);
    assert.match(receipt.text, /\[原邮件\] INBOX#6/);
    assert.equal(service.state.send.length, 1);
    const draft = service.state.send[0];
    assert.equal(draft.subject, 'Re: 会议邀请');
    assert.equal(draft.inReplyTo, REF_ID, 'In-Reply-To 取原邮件的 in-reply-to');
    assert.deepEqual(draft.references, [REF_ID]);
    assert.deepEqual(draft.to, [{ name: '王小明', address: 'wang@example.com' }], '没有 Reply-To 就回落 From');
  } finally {
    await built.cleanup();
  }
});

test('原主题已经是 Re: 时不重复加前缀', async () => {
  const service = makeFakeMailbox({
    mode: 'demo',
    folders: ['INBOX'],
    mails: [
      {
        folder: 'INBOX',
        uid: 2,
        subject: 'Re: 旧话题',
        fromName: '甲',
        fromAddress: 'a@example.com',
        headers: { from: '甲 <a@example.com>', 'message-id': '<x@example.com>' },
      },
    ],
  });
  const built = await makeWorld({ cfg: { mode: 'demo' }, service });
  try {
    await built.world.start(built.host.host);
    await callTool(built.world, 'mail_reply', { uid: 2, text: '继续', confirm: true });
    assert.equal(service.state.send[0].subject, 'Re: 旧话题');
  } finally {
    await built.cleanup();
  }
});

test('mail_reply 参数校验：uid 必填、text 必填；读不到原邮件时按失败分类回报', async () => {
  const service = fake();
  const built = await makeWorld({ cfg: { mode: 'demo' }, service });
  try {
    await built.world.start(built.host.host);
    for (const args of [{ text: 'x' }, { uid: 6 }, { uid: 0, text: 'x' }]) {
      const receipt = await callTool(built.world, 'mail_reply', args);
      assert.equal(receipt.failed, true, JSON.stringify(args));
      assert.match(receipt.text, /\[参数不对\]/);
    }

    const missing = await callTool(built.world, 'mail_reply', { uid: 999, text: 'x' });
    assert.equal(missing.failed, true);
    assert.match(missing.text, /\[失败 · 服务器回了错\]/);
    assert.equal(service.state.send.length, 0, '读不到原邮件绝不许发');
  } finally {
    await built.cleanup();
  }
});
