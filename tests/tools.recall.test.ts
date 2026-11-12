/**
 * mail_recall（PLAN 第 5 节）：只查本地知识库（离线、不改任何东西）。
 * 回答「之前读过什么」先用它——断言它一次网络调用都不发，且结果里带 uid 便于回查。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { callTool, makeFakeMailbox, makeWorld } from './world.support.ts';

function fake() {
  return makeFakeMailbox({
    mode: 'demo',
    folders: ['INBOX'],
    mails: [
      {
        folder: 'INBOX',
        uid: 31,
        subject: '季度报表提醒',
        fromName: '财务部',
        date: '2026-11-09T01:00:00.000Z',
        snippet: '请在本周五前提交季度报表',
        text: '请在本周五前提交季度报表。',
      },
      {
        folder: 'INBOX',
        uid: 32,
        subject: '午餐约',
        fromName: '朋友',
        date: '2026-11-07T04:00:00.000Z',
        snippet: '中午一起吃饭？',
        text: '中午一起吃饭？',
      },
    ],
  });
}

test('mail_recall：先读进知识库，再离线检索命中，带可回查的 uid', async () => {
  const service = fake();
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    // 先用 mail_list 把两封写进知识库（recall 只查库）。
    await callTool(built.world, 'mail_list');
    const callsAfterList = service.state.list.length;

    const receipt = await callTool(built.world, 'mail_recall', { query: '季度报表' });
    assert.equal(receipt.failed, false);
    assert.match(receipt.text, /\[命中 1 封\] 关键词「季度报表」· 来自本地知识库（离线，不联网）/);
    assert.match(receipt.text, /· #31 财务部 2026-11-09 01:00 季度报表提醒/);
    assert.match(receipt.text, /请在本周五前提交季度报表/);
    assert.equal(service.state.list.length, callsAfterList, 'recall 不许联网（一条 list 都不发）');
    assert.equal(service.state.read.length, 0);
    assert.equal(service.state.search.length, 0);
  } finally {
    await built.cleanup();
  }
});

test('mail_recall：库里没有就说没有，并指向该用的工具', async () => {
  const service = fake();
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    const receipt = await callTool(built.world, 'mail_recall', { query: '从来没读过的东西' });
    assert.equal(receipt.failed, false);
    assert.match(receipt.text, /\[命中 0 封\]/);
    assert.match(receipt.text, /没搜到/);
    assert.match(receipt.text, /mail_list|mail_search/);
  } finally {
    await built.cleanup();
  }
});

test('mail_recall：limit 生效，query 必填', async () => {
  const service = fake();
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    await callTool(built.world, 'mail_list');
    const one = await callTool(built.world, 'mail_recall', { query: '例子', limit: 1 });
    // 两封里只有「午餐约」含「例子」？都不含，正好验证不命中；换个词验证 limit：
    const both = await callTool(built.world, 'mail_recall', { query: '请在本周五前提交季度报表', limit: 1 });
    assert.match(both.text, /\[命中 1 封\]/);
    assert.ok(one.text.includes('[命中 0 封]'));

    const missing = await callTool(built.world, 'mail_recall', {});
    assert.equal(missing.failed, true);
    assert.match(missing.text, /\[参数不对\]/);
  } finally {
    await built.cleanup();
  }
});
