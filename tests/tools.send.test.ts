/**
 * mail_send（PLAN 第 5、9 节）：**危险门禁**——不带 confirm:true 只返回预览草稿，一个字都不发；
 * confirm:true 才发；demo 模式写进演示发件箱（不联网）。
 *
 * 这里同时守「世界层门禁」和「工具回执」两层：门禁在 world.sendNow（调用 service 前就拦住），
 * 断言用假 Mailbox 的 send 调用记录与真实 demo 的 demo-outbox.jsonl 两种证据。
 */
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { callTool, makeFakeMailbox, makeWorld } from './world.support.ts';

function fake() {
  return makeFakeMailbox({ mode: 'demo', folders: ['INBOX'] });
}

test('不带 confirm：只返回预览草稿，一次 send 都不发', async () => {
  const service = fake();
  const built = await makeWorld({ cfg: { mode: 'demo' }, service });
  try {
    await built.world.start(built.host.host);
    const receipt = await callTool(built.world, 'mail_send', {
      to: 'a@example.com, b@example.com',
      cc: 'c@example.com',
      subject: '测试主题',
      text: '这是正文，不该发出去。',
    });
    assert.equal(receipt.failed, false, '预览不是失败');
    assert.match(receipt.text, /\[草案\] 还没有发送/);
    assert.match(receipt.text, /confirm: true/);
    assert.match(receipt.text, /收件人：a@example\.com、b@example\.com/);
    assert.match(receipt.text, /抄送：c@example\.com/);
    assert.match(receipt.text, /主题：测试主题/);
    assert.equal(receipt.text.split('这是正文，不该发出去。').length - 1, 1, '正文只出现一次');
    assert.equal(service.state.send.length, 0, '门禁必须在调用 service 之前拦住');
  } finally {
    await built.cleanup();
  }
});

test('confirm=false 与不带 confirm 一样只预览', async () => {
  const service = fake();
  const built = await makeWorld({ cfg: { mode: 'demo' }, service });
  try {
    await built.world.start(built.host.host);
    const receipt = await callTool(built.world, 'mail_send', {
      to: 'a@example.com',
      subject: 's',
      text: 't',
      confirm: false,
    });
    assert.match(receipt.text, /\[草案\]/);
    assert.equal(service.state.send.length, 0);
  } finally {
    await built.cleanup();
  }
});

test('confirm=true：真的调用 service.send，回执说清 demo 模式只是写演示发件箱', async () => {
  const service = fake();
  const built = await makeWorld({ cfg: { mode: 'demo' }, service });
  try {
    await built.world.start(built.host.host);
    const receipt = await callTool(built.world, 'mail_send', {
      to: 'a@example.com',
      bcc: 'secret@example.com',
      subject: '确认过的主题',
      text: '确认过的正文',
      confirm: true,
    });
    assert.equal(receipt.failed, false);
    assert.match(receipt.text, /\[发出去了\] demo 模式：已写进演示发件箱/);
    assert.match(receipt.text, /messageId <fake-1@example\.com>/);
    assert.match(receipt.text, /密送：secret@example\.com/);
    assert.equal(service.state.send.length, 1, '这一次真的发了');
    const draft = service.state.send[0];
    assert.deepEqual(draft.to, [{ name: '', address: 'a@example.com' }]);
    assert.equal(draft.subject, '确认过的主题');
    assert.equal(draft.text, '确认过的正文');
  } finally {
    await built.cleanup();
  }
});

test('地址不合法 / 缺参数：参数错误，绝不发；也不冒充 5 类失败', async () => {
  const service = fake();
  const built = await makeWorld({ cfg: { mode: 'demo' }, service });
  try {
    await built.world.start(built.host.host);
    for (const args of [
      { subject: 's', text: 't' },
      { to: 'not-an-address', subject: 's', text: 't' },
      { to: 'a@example.com', text: 't' },
      { to: 'a@example.com', subject: 's' },
    ]) {
      const receipt = await callTool(built.world, 'mail_send', args);
      assert.equal(receipt.failed, true, JSON.stringify(args));
      assert.match(receipt.text, /\[参数不对\]/, JSON.stringify(args));
      for (const label of ['配置没填完', '连不上服务器', '登录被拒', '服务器回了错', '内容解析失败']) {
        assert.ok(!receipt.text.includes(label), '参数错误里混进了「' + label + '」');
      }
    }
    assert.equal(service.state.send.length, 0);
  } finally {
    await built.cleanup();
  }
});

test('端到端（真实 demo 邮箱）：无 confirm 时 demo-outbox.jsonl 不存在；确认后才落盘', async () => {
  const built = await makeWorld({ cfg: { mode: 'demo', intervalMinutes: 0 } });
  const outbox = join(built.dir, 'demo-outbox.jsonl');
  try {
    await built.world.start(built.host.host);
    const preview = await callTool(built.world, 'mail_send', {
      to: 'someone@example.com',
      subject: '先预览',
      text: '不该落盘',
    });
    assert.match(preview.text, /\[草案\]/);
    await assert.rejects(() => stat(outbox), '预览绝不许写演示发件箱');

    const sent = await callTool(built.world, 'mail_send', {
      to: 'someone@example.com',
      subject: '真发一封（演示）',
      text: '这条会写进演示发件箱',
      confirm: true,
    });
    assert.match(sent.text, /\[发出去了\] demo 模式/);
    const raw = await readFile(outbox, 'utf8');
    const lines = raw.trim().split(/\r?\n/).filter((one) => one.trim() !== '');
    assert.equal(lines.length, 1, '确认之后才写一条');
    const record = JSON.parse(lines[0]) as { subject: string; to: Array<{ address: string }>; text: string };
    assert.equal(record.subject, '真发一封（演示）');
    assert.equal(record.to[0].address, 'someone@example.com');
    assert.equal(record.text, '这条会写进演示发件箱');
  } finally {
    await built.cleanup();
  }
});
