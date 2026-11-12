/**
 * mail_status 的「别报假警」+「不联网也能答」回归测试（PLAN 第 5、6 节）。
 *
 * 三条底线：
 * ① status 只报当前事实：这一代服务连没连上、配置缺什么，不能翻旧账；
 * ② 不联网：mail_status 不触发 IMAP/SMTP 任何命令；
 * ③ 真的缺配置时要按「配置没填完」如实说，并点名 worlds.mail.*。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEMO_ACCOUNT } from '../src/mail/demo.ts';
import { MailError } from '../src/mail/types.ts';
import { RECEIPT_LABEL } from '../src/tools/receipt.ts';
import { callTool, makeFakeMailbox, makeWorld } from './world.support.ts';

test('demo 状态：模式/账号/文件夹/知识库都报对，回执里没有失败分类', async () => {
  const built = await makeWorld({ cfg: { mode: 'demo' } });
  try {
    await built.world.start(built.host.host);
    const snapshot = await built.world.statusSnapshot();
    assert.equal(snapshot.mode, 'demo');
    assert.equal(snapshot.account, DEMO_ACCOUNT);
    assert.deepEqual(snapshot.configFolders, ['INBOX']);
    assert.ok(snapshot.folders.includes('INBOX'), 'demo 服务端文件夹');
    assert.equal(snapshot.connected, true);
    assert.equal(snapshot.mounted, true);
    assert.equal(snapshot.lastError, undefined);
    assert.equal(snapshot.vault.items, 0);

    const receipt = await callTool(built.world, 'mail_status');
    assert.equal(receipt.failed, false, 'status 本身不失败');
    assert.match(receipt.text, /\[模式\] demo/);
    assert.match(receipt.text, /\[连接\]/);
    assert.match(receipt.text, /\[文件夹\] 配置 1 个：INBOX/);
    assert.match(receipt.text, /\[知识库\] 0 封/);
    for (const label of Object.values(RECEIPT_LABEL)) {
      assert.ok(!receipt.text.includes('[' + label + ']'), '正常状态里不许出现「' + label + '」：' + receipt.text);
    }
  } finally {
    await built.cleanup();
  }
});

test('live 缺配置：status 记 no-config，mail_status 按「配置没填完」说清楚并点名配置项', async () => {
  const built = await makeWorld({ cfg: { mode: 'live', email: '', authCode: '' } });
  try {
    await built.world.start(built.host.host);
    const snapshot = await built.world.statusSnapshot();
    assert.equal(snapshot.lastError?.code, 'no-config');
    assert.equal(snapshot.mode, 'demo', '回退 demo 后照样能用');

    const receipt = await callTool(built.world, 'mail_status');
    assert.equal(receipt.failed, false, '状态查询本身不算失败');
    assert.match(receipt.text, /配置没填完/);
    assert.match(receipt.text, /worlds\.mail\.authCode/, '要告诉人去填哪个键');
    assert.match(receipt.text, /demo/, '要告诉人可以先回 demo');
  } finally {
    await built.cleanup();
  }
});

test('live 连接是惰性的：没连上时如实说「还没连」，mail_status 一条 IMAP 命令都不发', async () => {
  const service = makeFakeMailbox({ mode: 'live', account: 'someone@example.com', connected: false });
  const built = await makeWorld({
    cfg: { mode: 'live', email: 'someone@example.com', authCode: 'DEMO_AUTH_CODE_FOR_TEST' },
    service,
  });
  try {
    await built.world.start(built.host.host);
    const receipt = await callTool(built.world, 'mail_status');
    assert.match(receipt.text, /\[模式\] live/);
    assert.match(receipt.text, /还没连/);
    assert.ok(!receipt.text.includes('没连上（'), '没试过连接不等于连不上');
    assert.equal(service.state.list.length, 0, 'status 不许触发 list');
    assert.equal(service.state.read.length, 0);
    assert.equal(service.state.search.length, 0);
    assert.equal(service.state.folders, 0);

    service.setConnected(true);
    const after = await callTool(built.world, 'mail_status');
    assert.match(after.text, /\[连接\] 已连上/);
  } finally {
    await built.cleanup();
  }
});

test('假报警回归：上一次的 lastError 清掉之后，status 不许再提失败', async () => {
  const service = makeFakeMailbox({
    mode: 'live',
    account: 'someone@example.com',
    connected: false,
    statusError: { code: 'auth', message: 'IMAP 登录被拒', hint: '去 QQ 邮箱重新生成授权码' },
  });
  const built = await makeWorld({
    cfg: { mode: 'live', email: 'someone@example.com', authCode: 'DEMO_AUTH_CODE_FOR_TEST' },
    service,
  });
  try {
    await built.world.start(built.host.host);
    const failed = await built.world.statusSnapshot();
    assert.equal(failed.lastError?.code, 'auth', '真失败时如实报');
    assert.match((await callTool(built.world, 'mail_status')).text, /登录被拒/);

    service.setStatusError(undefined);
    service.setConnected(true);
    const fixed = await built.world.statusSnapshot();
    assert.equal(fixed.lastError, undefined, '恢复了就要把旧账清干净');
    const receipt = await callTool(built.world, 'mail_status');
    assert.match(receipt.text, /\[连接\] 已连上/);
    assert.ok(!receipt.text.includes('登录被拒'), '正常状态里不许留着上一次的失败：' + receipt.text);
  } finally {
    await built.cleanup();
  }
});

test('收过一轮之后：lastScanAt / lastScanAdded / scans 进快照与回执', async () => {
  const service = makeFakeMailbox({
    mode: 'demo',
    folders: ['INBOX'],
    mails: [
      { folder: 'INBOX', uid: 1, subject: '第一封', fromName: '甲', snippet: 'a' },
      { folder: 'INBOX', uid: 2, subject: '第二封', fromName: '乙', snippet: 'b' },
    ],
    withSelectInfo: true,
  });
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    await built.world.scan();
    const snapshot = await built.world.statusSnapshot();
    assert.equal(snapshot.lastScanAdded, 2);
    assert.equal(snapshot.scans, 1);
    assert.ok(snapshot.lastScanAt !== null);
    assert.equal(snapshot.vault.items, 2);

    const receipt = await callTool(built.world, 'mail_status');
    assert.match(receipt.text, /新增 2 封，累计 1 轮/);
    assert.match(receipt.text, /\[知识库\] 2 封/);
  } finally {
    await built.cleanup();
  }
});

test('intervalMinutes=0：回执说清「只能手动触发」', async () => {
  const built = await makeWorld({ cfg: { mode: 'demo', intervalMinutes: 0 } });
  try {
    await built.world.start(built.host.host);
    const receipt = await callTool(built.world, 'mail_status');
    assert.match(receipt.text, /自动收信已关闭/);
    assert.match(receipt.text, /手动/);
  } finally {
    await built.cleanup();
  }
});

test('status 不把「服务查询失败」当致命：安全降级成 disconnected 快照', async () => {
  const service = makeFakeMailbox({ mode: 'live', account: 'someone@example.com' });
  service.mailbox.status = async () => {
    throw new MailError('connect', '连不上（测试注入）');
  };
  const built = await makeWorld({
    cfg: { mode: 'live', email: 'someone@example.com', authCode: 'DEMO_AUTH_CODE_FOR_TEST' },
    service,
  });
  try {
    await built.world.start(built.host.host);
    const snapshot = await built.world.statusSnapshot();
    assert.equal(snapshot.connected, false, '状态查不到时按未连接报，不炸');
    const receipt = await callTool(built.world, 'mail_status');
    assert.equal(receipt.failed, false, 'mail_status 仍然给出快照');
  } finally {
    await built.cleanup();
  }
});

test('webUi：面板「邮箱」、配置组、envPrompt 文档与 invoke 状态接口', async () => {
  const { stat } = await import('node:fs/promises');
  const built = await makeWorld({ cfg: { mode: 'demo' } });
  try {
    await built.world.start(built.host.host);
    const zh = built.world.webUi('zh');
    assert.equal(zh.panels?.length, 1);
    assert.equal(zh.panels?.[0].id, 'state');
    assert.equal(zh.panels?.[0].title, '邮箱');
    assert.deepEqual(zh.panels?.[0].getMethods, ['status']);
    assert.equal(zh.lamps?.length, 1, '状态灯按框架 WorldLamp 声明');
    assert.equal(zh.lamps?.[0].state, 'online');
    assert.equal(zh.label, '邮箱');

    assert.equal(zh.config?.length, 1, '配置组来自 config.ts 的 mailConfigGroups');
    assert.equal(zh.config?.[0].id, 'world:mail');
    assert.ok(Object.hasOwn(zh.config?.[0].schema.properties ?? {}, 'worlds.mail.mode'), '配置键用 worlds.mail.*');

    assert.equal(zh.promptDocs?.length, 1);
    const doc = zh.promptDocs?.[0];
    assert.equal(doc?.key, 'worlds.mail.envPrompt');
    assert.equal(doc?.role, 'envPrompt');
    assert.ok(doc?.path && (await stat(doc.path)).isFile(), 'ENV_PROMPT.md 必须真的存在：' + String(doc?.path));
    const names = (doc?.vars ?? []).map((one) => one.name).sort();
    assert.deepEqual(names, ['mail.account', 'mail.folders', 'mail.interval', 'mail.mode', 'mail.status', 'mail.vault']);

    const snapshot = (await zh.invoke?.('state', 'status')) as { mode?: string };
    assert.equal(snapshot.mode, 'demo', 'invoke 的状态接口给 WebUI 用');
    await assert.rejects(async () => {
      await zh.invoke?.('state', 'nope');
    }, /没有这个方法/);

    const en = built.world.webUi('en');
    assert.equal(en.panels?.[0].title, 'Mailbox', '英文界面用英文标题');
  } finally {
    await built.cleanup();
  }
});

test('envPromptVars：六个变量齐全，值是我们自己的固定文案/配置，不含邮箱密码类凭据', async () => {
  const built = await makeWorld({ cfg: { mode: 'demo' } });
  try {
    await built.world.start(built.host.host);
    const vars = built.world.envPromptVars();
    assert.deepEqual(Object.keys(vars).sort(), [
      'mail.account', 'mail.folders', 'mail.interval', 'mail.mode', 'mail.status', 'mail.vault',
    ]);
    for (const [name, value] of Object.entries(vars)) {
      assert.equal(typeof value, 'string', name + ' 必须是字符串');
      assert.ok((value as string).length > 0, name + ' 不许为空');
    }
    assert.match(String(vars['mail.mode']), /demo/);
    assert.match(String(vars['mail.account']), /demo@coopanion\.local/);
    assert.match(String(vars['mail.folders']), /INBOX/);
    assert.match(String(vars['mail.interval']), /30 分钟/);
    assert.match(String(vars['mail.vault']), /mail/);
  } finally {
    await built.cleanup();
  }
});