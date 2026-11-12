/**
 * 5 类失败回执（PLAN 第 6 节）：分类锚点只按 MailError.code 判，五类绝不互相冒充；
 * 服务器原文（MailError.detail）绝不进回执；参数错误与意外错误各自单独一类。
 *
 * 另外守两件契约：world.tools() 的声明必须与 definition.ts 的 TOOL_SPECS 逐字一致；
 * 单条回执总长 <= 6000 字符（PLAN 第 5 节）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { TOOL_SPECS } from '../src/definition.ts';
import { MailError, type MailErrorCode } from '../src/mail/types.ts';
import { RECEIPT_LABEL, RECEIPT_MAX_CHARS } from '../src/tools/receipt.ts';
import { callTool, makeFakeMailbox, makeWorld } from './world.support.ts';

const LABELS = Object.values(RECEIPT_LABEL);

/** 回执里只许出现它自己那一类的标签，别的类一个字都不许有。 */
function assertOnlyClass(text: string, expected: string): void {
  assert.ok(text.includes('[失败 · ' + expected + ']'), '回执里要有分类锚点「' + expected + '」，实得：' + text);
  for (const label of LABELS) {
    if (label === expected) continue;
    assert.ok(!text.includes(label), '「' + expected + '」的回执里混进了「' + label + '」：' + text);
  }
}

async function receiptForFailure(error: Error): Promise<{ text: string; failed: boolean }> {
  const service = makeFakeMailbox({ mode: 'demo', folders: ['INBOX'] });
  service.setError('list', error);
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    return await callTool(built.world, 'mail_list');
  } finally {
    await built.cleanup();
  }
}

test('① 配置没填完：no-config', async () => {
  const receipt = await receiptForFailure(
    new MailError('no-config', '实时邮箱模式缺配置：worlds.mail.authCode 里没有授权码。', {
      hint: '按配置项说明去填；只想先看看就把 worlds.mail.mode 改回 demo。',
    }),
  );
  assert.equal(receipt.failed, true);
  assertOnlyClass(receipt.text, '配置没填完');
  assert.match(receipt.text, /worlds\.mail\.authCode/, '要告诉人去填哪个键');
  assert.match(receipt.text, /该做什么：/);
});

test('② 连不上服务器：connect / tls / timeout / dropped 都归这里，别的类不许混', async () => {
  const codes: MailErrorCode[] = ['connect', 'tls', 'timeout', 'dropped'];
  for (const code of codes) {
    const receipt = await receiptForFailure(new MailError(code, '连不上邮件服务器（' + code + '）'));
    assert.equal(receipt.failed, true, code);
    assertOnlyClass(receipt.text, '连不上服务器');
    assert.match(receipt.text, /检查网络|代理/, code + ' 要给网络/代理提示');
  }
});

test('③ 登录被拒：auth', async () => {
  const receipt = await receiptForFailure(
    new MailError('auth', 'IMAP 登录被拒', { hint: '多半是授权码错，或者 IMAP/SMTP 服务没开' }),
  );
  assert.equal(receipt.failed, true);
  assertOnlyClass(receipt.text, '登录被拒');
  assert.match(receipt.text, /授权码/);
  assert.match(receipt.text, /重新生成/);
});

test('④ 服务器回了错：protocol；⑤ 内容解析失败：parse', async () => {
  const protocol = await receiptForFailure(new MailError('protocol', '文件夹不存在：INBOX2'));
  assert.equal(protocol.failed, true);
  assertOnlyClass(protocol.text, '服务器回了错');
  assert.match(protocol.text, /folders/);

  const parse = await receiptForFailure(new MailError('parse', 'MIME 解析失败（第 3 封）'));
  assert.equal(parse.failed, true);
  assertOnlyClass(parse.text, '内容解析失败');
  assert.match(parse.text, /跳过/);
});

test('失败回执不渲染服务器原文：detail 只进日志', async () => {
  const CANARY = 'SERVER_RAW_TEXT_CANARY';
  const receipt = await receiptForFailure(
    new MailError('auth', 'IMAP 登录被拒', { detail: '服务器原文：' + CANARY }),
  );
  assert.equal(receipt.failed, true);
  assertOnlyClass(receipt.text, '登录被拒');
  assert.ok(!receipt.text.includes(CANARY), '回执里不许出现服务器原文：' + receipt.text);
});

test('意外异常单独一类：不许冒充 5 类里的任何一类', async () => {
  const receipt = await receiptForFailure(new Error('boom：未知故障'));
  assert.equal(receipt.failed, true);
  assertOnlyClass(receipt.text, '出了意外');
  assert.match(receipt.text, /core\.log/, '意料之外的错要指向日志');
});

test('参数错误单独一类：不许冒充 5 类里的任何一类', async () => {
  const service = makeFakeMailbox({ mode: 'demo', folders: ['INBOX'] });
  const built = await makeWorld({ cfg: { mode: 'demo' }, service });
  try {
    await built.world.start(built.host.host);
    const receipt = await callTool(built.world, 'mail_send', { to: '不是地址', subject: 's', text: 't' });
    assert.equal(receipt.failed, true);
    assert.match(receipt.text, /\[参数不对\]/);
    for (const label of LABELS) assert.ok(!receipt.text.includes(label), '参数错误里混进了「' + label + '」');
  } finally {
    await built.cleanup();
  }
});

test('发信失败也按 5 类：SMTP 登录被拒 != 连不上', async () => {
  const service = makeFakeMailbox({ mode: 'live', account: 'someone@example.com', folders: ['INBOX'] });
  service.setError('send', new MailError('auth', 'SMTP 登录被拒'));
  const built = await makeWorld({
    cfg: { mode: 'live', email: 'someone@example.com', authCode: 'DEMO_AUTH_CODE_FOR_TEST' },
    service,
  });
  try {
    await built.world.start(built.host.host);
    const receipt = await callTool(built.world, 'mail_send', {
      to: 'a@example.com',
      subject: 's',
      text: 't',
      confirm: true,
    });
    assert.equal(receipt.failed, true);
    assertOnlyClass(receipt.text, '登录被拒');
  } finally {
    await built.cleanup();
  }
});

test('对齐 TOOL_SPECS：名字、description、parameters、tags 逐字一致，且 7 个都有 handler', async () => {
  const service = makeFakeMailbox({ mode: 'demo', folders: ['INBOX'] });
  const built = await makeWorld({ cfg: { mode: 'demo' }, service });
  try {
    const decls = built.world.tools();
    assert.equal(decls.length, TOOL_SPECS.length, 'PLAN 第 5 节的 7 个工具');
    assert.deepEqual(decls.map((one) => one.name), TOOL_SPECS.map((one) => one.name), '名字与顺序都要一致');
    for (const spec of TOOL_SPECS) {
      const decl = decls.find((one) => one.name === spec.name);
      assert.ok(decl, '缺工具：' + spec.name);
      assert.equal(decl.description, spec.description, spec.name + ' 的 description 必须逐字相同');
      assert.deepEqual(decl.parameters, spec.parameters, spec.name + ' 的 parameters 必须逐字相同');
      assert.deepEqual([...decl.tags], [...spec.tags], spec.name + ' 的 tags 必须逐字相同');
      assert.equal(typeof decl.handler, 'function', spec.name + ' 要挂 handler');
    }
    // 面向模型的 description：读内容的工具要写明「第三方数据」，发信工具要写明 DANGEROUS。
    for (const name of ['mail_list', 'mail_read', 'mail_search', 'mail_send', 'mail_reply']) {
      const spec = TOOL_SPECS.find((one) => one.name === name);
      assert.ok(spec, '缺工具：' + name);
      assert.match(spec.description, /third part|DANGEROUS/i, name + ' 的 description 要写明第三方数据/危险动作');
    }
  } finally {
    await built.cleanup();
  }
});

test('回执总长上限 6000 字符：超了截断并说明', async () => {
  const mails = Array.from({ length: 100 }, (_, index) => ({
    folder: 'INBOX',
    uid: index + 1,
    subject: '第 ' + String(index + 1) + ' 封邮件：'.repeat(6),
    fromName: '发件人' + String(index),
    snippet: '片段'.repeat(20),
  }));
  const service = makeFakeMailbox({ mode: 'demo', folders: ['INBOX'], mails });
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    const receipt = await callTool(built.world, 'mail_list', { limit: 100 });
    assert.ok(receipt.text.length <= RECEIPT_MAX_CHARS, '回执长度：' + String(receipt.text.length));
    assert.match(receipt.text, /回执过长已截断/);
  } finally {
    await built.cleanup();
  }
});

test('失败回执同样受 6000 字符上限约束', async () => {
  const long = '错误信息'.repeat(2000);
  const receipt = await receiptForFailure(new MailError('protocol', long));
  assert.ok(receipt.text.length <= RECEIPT_MAX_CHARS, '失败回执长度：' + String(receipt.text.length));
});
