/**
 * mail_search（PLAN 第 5 节）：服务器端 IMAP SEARCH 优先；不支持时退化为最近 N 封本地过滤。
 * 回执与 mail_list 同款：`· #uid 发件人 时间 主题`，uid 能直接喂给 mail_read。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { MailError } from '../src/mail/types.ts';
import { callTool, makeFakeMailbox, makeWorld } from './world.support.ts';

function fake() {
  return makeFakeMailbox({
    mode: 'demo',
    folders: ['INBOX'],
    mails: [
      {
        folder: 'INBOX',
        uid: 21,
        subject: '季度报表提醒',
        fromName: '财务部',
        date: '2026-11-09T01:00:00.000Z',
        snippet: '请在本周五前提交季度报表',
        text: '请在本周五前提交季度报表。',
        seen: false,
      },
      {
        folder: 'INBOX',
        uid: 18,
        subject: '午餐约',
        fromName: '朋友',
        date: '2026-11-07T04:00:00.000Z',
        snippet: '中午一起吃饭？',
        text: '中午一起吃饭？',
        seen: true,
      },
    ],
    withSelectInfo: true,
  });
}

test('mail_search：服务器端搜到，回执带可解析的 uid，且不落库（PLAN 只要求 list/read 落库）', async () => {
  const service = fake();
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    const receipt = await callTool(built.world, 'mail_search', { query: '季度报表' });
    assert.equal(receipt.failed, false);
    assert.match(receipt.text, /\[搜到 1 封\]/);
    assert.match(receipt.text, /· #21 财务部 2026-11-09 01:00 季度报表提醒/);
    assert.ok(!receipt.text.includes('中午一起吃饭'), '不命中的邮件不该出现');
    assert.equal(service.state.search.length, 1, '优先走服务器端 SEARCH');
    assert.equal(service.state.list.length, 0, '服务器端成功时不需要退化成本地过滤');
    assert.match(receipt.text, /第三方写的/);

    const uids = [...receipt.text.matchAll(/· #(\d+) /g)].map((match) => Number(match[1]));
    const read = await callTool(built.world, 'mail_read', { uid: uids[0] });
    assert.equal(read.failed, false, '搜索结果里的 uid 要能直接读：' + read.text);
    assert.match(read.text, /请在本周五前提交季度报表。/);
  } finally {
    await built.cleanup();
  }
});

test('mail_search：服务器不支持时退化成本地过滤，并明说结果可能不全', async () => {
  const service = fake();
  service.setError('search', new MailError('protocol', 'UID SEARCH 不被支持'));
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    const receipt = await callTool(built.world, 'mail_search', { query: '季度报表' });
    assert.equal(receipt.failed, false);
    assert.match(receipt.text, /\[搜到 1 封\]/);
    assert.match(receipt.text, /#21/);
    assert.match(receipt.text, /服务器端 SEARCH 不可用/);
    assert.match(receipt.text, /可能不全/);
    assert.ok(service.state.list.length >= 1, '退化路径真的去 list 了');
  } finally {
    await built.cleanup();
  }
});

test('mail_search：from / since 透传；since 格式不对直接参数错误', async () => {
  const service = fake();
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    const byFrom = await callTool(built.world, 'mail_search', { query: '报表', from: '财务' });
    assert.match(byFrom.text, /发件人含「财务」/);
    assert.equal(service.state.search[0].from, '财务');

    const bySince = await callTool(built.world, 'mail_search', { query: '报表', since: '2026-11-01' });
    assert.equal(bySince.failed, false);
    assert.equal(service.state.search[1].since, '2026-11-01');

    for (const since of ['11/01/2026', '2026-13-99', 'yesterday']) {
      const bad = await callTool(built.world, 'mail_search', { query: '报表', since });
      assert.equal(bad.failed, true, since);
      assert.match(bad.text, /\[参数不对\]/);
    }
  } finally {
    await built.cleanup();
  }
});

test('mail_search：query 必填；搜不到时给一句能照做的话', async () => {
  const service = fake();
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    const empty = await callTool(built.world, 'mail_search', {});
    assert.equal(empty.failed, true);
    assert.match(empty.text, /\[参数不对\]/);

    const none = await callTool(built.world, 'mail_search', { query: '完全不存在的词' });
    assert.equal(none.failed, false);
    assert.match(none.text, /\[搜到 0 封\]/);
    assert.match(none.text, /换个关键词/);
  } finally {
    await built.cleanup();
  }
});
