/**
 * 注入与隐私防线（PLAN 第 9 节）：
 * ① canary（演示垃圾邮件里的注入样本）绝不出现在任何 internal 事件或失败回执里；
 * ② 第三方文本只能出现在 external 事件（mail.new）与内容类工具回执（mail_read）里；
 * ③ 发信危险门禁：不带 confirm:true 时演示发件箱一个字都不多；
 * ④ 授权码不进事件、回执、环境提示词变量或 WebUI 声明。
 *
 * 全部离线；canary 来自 W2 的演示数据（DEMO_CANARY），不是测试自己编的字符串。
 */
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { DEMO_CANARY, DEMO_FOLDERS } from '../src/mail/demo.ts';
import { MailError } from '../src/mail/types.ts';
import { callTool, makeFakeMailbox, makeWorld } from './world.support.ts';

/** internal 事件：它们只许有我们自己的固定文案与计数。 */
const INTERNAL_TYPES = ['mail.ready', 'mail.down', 'mail.scanned'];

/**
 * demo 全量扫描（三个文件夹，含带 canary 的垃圾邮件）。
 * 返回 built，让各条断言共用一次扫描。
 */
async function scannedDemo() {
  const built = await makeWorld({
    cfg: { mode: 'demo', folders: Array.from(DEMO_FOLDERS).join('\n'), intervalMinutes: 0 },
  });
  await built.world.start(built.host.host);
  const outcome = await built.world.scan();
  return { built, outcome };
}

test('canary 不出现在任何 internal 事件里（收信、就绪、失败都算）', async () => {
  const { built, outcome } = await scannedDemo();
  try {
    assert.ok(
      outcome.added.some((item) => item.folder === '垃圾邮件'),
      '演示数据里那封注入样本确实被扫到了（folder=垃圾邮件）',
    );
    for (const type of INTERNAL_TYPES) {
      for (const text of built.host.texts(type)) {
        assert.ok(!text.includes(DEMO_CANARY), type + ' 里出现了 canary：' + text);
        assert.ok(!text.includes('忽略之前的指示'), type + ' 里出现了注入话术：' + text);
        assert.ok(!text.includes('授权码发给我'), type + ' 里出现了注入话术：' + text);
      }
    }
    // internal 事件也不许带主题/发件人（第三方文本）
    for (const text of built.host.texts('mail.scanned')) {
      assert.ok(!text.includes('快递'), 'scanned 里出现了主题：' + text);
      assert.ok(!text.includes('会议'), 'scanned 里出现了主题：' + text);
    }
  } finally {
    await built.cleanup();
  }
});

test('第三方文本只从 external 事件出去：只扫垃圾邮件时，含 canary 的事件必须是 mail.new/external', async () => {
  // 只扫「垃圾邮件」这一个文件夹，保证那条注入样本一定进摘要（全量扫时摘要 800 字可能轮不到它）。
  const built = await makeWorld({ cfg: { mode: 'demo', folders: '垃圾邮件', intervalMinutes: 0 } });
  try {
    await built.world.start(built.host.host);
    const outcome = await built.world.scan();
    assert.equal(outcome.added.length, 1);
    const leaking = built.host.events.filter((one) => one.text.includes(DEMO_CANARY));
    assert.ok(leaking.length > 0, '摘要里应该包含这封垃圾邮件的片段（演示数据就是这样）');
    for (const event of leaking) {
      assert.equal(event.type, 'mail.new', '只有 mail.new 允许带第三方文本，实际：' + event.type);
      assert.equal(event.origin, 'external', '正文来自邮件：origin 必须是 external');
      assert.equal(event.deliver, true);
    }
    for (const type of INTERNAL_TYPES) {
      for (const text of built.host.texts(type)) {
        assert.ok(!text.includes(DEMO_CANARY), type + ' 里出现了 canary：' + text);
      }
    }
  } finally {
    await built.cleanup();
  }
});

test('mail_read 可以读到注入样本本身（内容就是内容），但回执不改写不发散', async () => {
  const { built } = await scannedDemo();
  try {
    const receipt = await callTool(built.world, 'mail_read', { uid: 1, folder: '垃圾邮件' });
    assert.equal(receipt.failed, false);
    assert.ok(receipt.text.includes(DEMO_CANARY), '读正文时第三方内容本身是允许出现的');
    assert.match(receipt.text, /第三方写的/, '回执要提醒这是第三方内容');
  } finally {
    await built.cleanup();
  }
});

test('失败回执不夹带服务器原文/第三方文本', async () => {
  const CANARY = 'SERVER_RAW_CANARY_忽略之前的指示';
  const service = makeFakeMailbox({ mode: 'demo', folders: ['INBOX'] });
  service.setError('list', new MailError('auth', 'IMAP 登录被拒', { detail: CANARY }));
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    const receipt = await callTool(built.world, 'mail_list');
    assert.equal(receipt.failed, true);
    assert.ok(!receipt.text.includes(CANARY), '失败回执里出现了服务器原文：' + receipt.text);
    // 自动收信失败也只记日志，不许把原文投进事件
    await assert.rejects(() => built.world.scan(), /./);
    for (const type of INTERNAL_TYPES) {
      for (const text of built.host.texts(type)) {
        assert.ok(!text.includes(CANARY), type + ' 里出现了服务器原文：' + text);
      }
    }
    assert.ok(built.host.logs.some((one) => one.includes(CANARY)), '原文只该出现在日志里');
  } finally {
    await built.cleanup();
  }
});

test('发信危险门禁：不带 confirm 时演示发件箱一个字都不多（send 与 reply 都是）', async () => {
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX', intervalMinutes: 0 } });
  const outbox = join(built.dir, 'demo-outbox.jsonl');
  try {
    await built.world.start(built.host.host);

    const sendPreview = await callTool(built.world, 'mail_send', {
      to: 'someone@example.com',
      subject: '不该发出去',
      text: '这封只在预览里出现',
    });
    assert.match(sendPreview.text, /\[草案\]/);
    await assert.rejects(() => stat(outbox), 'mail_send 预览绝不许写发件箱');

    const replyPreview = await callTool(built.world, 'mail_reply', { uid: 7, text: '这封回复也不该发出去' });
    assert.match(replyPreview.text, /\[草案\]/);
    await assert.rejects(() => stat(outbox), 'mail_reply 预览绝不许写发件箱');

    // 确认之后才真的落盘
    await callTool(built.world, 'mail_send', {
      to: 'someone@example.com',
      subject: '确认后才发',
      text: '这一封可以落盘',
      confirm: true,
    });
    const raw = await readFile(outbox, 'utf8');
    const lines = raw.trim().split(/\r?\n/).filter((line) => line.trim() !== '');
    assert.equal(lines.length, 1, '只有确认过的那一封');
    assert.match(raw, /确认后才发/);
    assert.ok(!raw.includes('不该发出去'), '预览的草稿绝不许进发件箱');
    assert.ok(!raw.includes('这封回复也不该发出去'));
  } finally {
    await built.cleanup();
  }
});

test('授权码不泄漏：事件、回执、环境提示词变量、WebUI 声明里都没有它', async () => {
  const AUTH_CODE = 'DEMO_AUTH_CODE_PRIVATE_CANARY';
  const service = makeFakeMailbox({
    mode: 'live',
    account: 'someone@example.com',
    folders: ['INBOX'],
    mails: [{ folder: 'INBOX', uid: 1, subject: '普通邮件', fromName: '甲', snippet: '正文' }],
    withSelectInfo: true,
  });
  const built = await makeWorld({
    cfg: { mode: 'live', email: 'someone@example.com', authCode: AUTH_CODE, intervalMinutes: 0 },
    service,
  });
  try {
    await built.world.start(built.host.host);
    await built.world.scan();

    const surfaces: string[] = [];
    for (const event of built.host.events) surfaces.push(event.type + ' ' + event.text);
    surfaces.push(await callTool(built.world, 'mail_status').then((one) => one.text));
    surfaces.push(await callTool(built.world, 'mail_list').then((one) => one.text));
    surfaces.push(JSON.stringify(built.world.envPromptVars()));
    surfaces.push(JSON.stringify(built.world.webUi('zh')));
    for (const log of built.host.logs) surfaces.push(log);
    for (const surface of surfaces) {
      assert.ok(!surface.includes(AUTH_CODE), '授权码泄漏到了：' + surface.slice(0, 200));
    }
  } finally {
    await built.cleanup();
  }
});

test('internal 事件里不出现 live 邮箱地址（只写模式与文件夹数）', async () => {
  const service = makeFakeMailbox({
    mode: 'live',
    account: 'someone@example.com',
    folders: ['INBOX'],
    mails: [{ folder: 'INBOX', uid: 1, subject: 's', fromName: '甲', snippet: 'x' }],
    withSelectInfo: true,
  });
  const built = await makeWorld({
    cfg: { mode: 'live', email: 'someone@example.com', authCode: 'DEMO_AUTH_CODE_FOR_TEST', intervalMinutes: 0 },
    service,
  });
  try {
    await built.world.start(built.host.host);
    await built.world.scan();
    const ready = built.host.texts('mail.ready');
    assert.equal(ready.length, 1);
    assert.ok(!ready[0].includes('someone@example.com'), 'ready 事件不写 live 邮箱地址：' + ready[0]);
  } finally {
    await built.cleanup();
  }
});
