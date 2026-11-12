#!/usr/bin/env node
/**
 * 演示数据版端到端验收（Lead 用，零依赖、离线）。
 *
 * 干的事：用真实包入口 create() 一个 MailWorld（fake ctx），挂一个 fake WorldHost，
 * 然后像模型那样经 tools() 的 7 个 handler 走一遍：
 *   mail_status → mail_list →（从回执解出 uid）→ mail_read → mail_search → mail_recall
 *   → mail_send（先预览、后确认）→ mail_reply（先预览、后确认）
 *
 * 同时断言事件契约：
 *   - mail.ready（internal）在启动后出现
 *   - mail.scanned（internal，deliver=false）在演示首轮（3 秒）后出现，且不含主题/正文
 *   - mail.new（external）只带摘要
 *   - 预览发信时演示发件箱文件不出现；确认后才出现，条数 1/2
 *
 * 全程不联网、不读真邮箱、不写部署目录；临时目录用系统临时区，跑完删掉。
 *
 * 用法：node scripts/demo-e2e.mjs [--keep]   （--keep 保留临时目录并打印路径）
 * 退出码：0 全过 / 1 有断言失败
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

const KEEP = process.argv.includes('--keep');
const MAIL_SEND_PREVIEW_NEEDLE = '还没有发送';

const results = [];
function check(label, fn) {
  try {
    fn();
    results.push({ label, ok: true });
    process.stdout.write('  ✔ ' + label + '\n');
  } catch (error) {
    results.push({ label, ok: false, detail: String(error && error.message ? error.message : error) });
    process.stdout.write('  ✘ ' + label + ' — ' + String(error && error.message ? error.message : error) + '\n');
  }
}

function firstLines(text, n = 4) {
  return String(text ?? '')
    .split(/\r?\n/)
    .slice(0, n)
    .join('\n');
}

function findUids(text) {
  const out = [];
  for (const match of String(text ?? '').matchAll(/#(\d+)/g)) out.push(Number(match[1]));
  return [...new Set(out)];
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortico-world-mail-e2e-'));
const outboxFile = path.join(dataDir, 'demo-outbox.jsonl');

const logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  emit() {},
  child() {
    return logger;
  },
};

const events = [];
const host = {
  async pushEvent(event, options) {
    events.push({ event: { ...event }, options: { ...(options ?? {}) } });
    return { ...event, cursor: events.length };
  },
  log: logger,
  store: { latestCursor: () => 0 },
};

const def = (await import('../src/index.ts')).default;
assert.ok(def && typeof def.create === 'function', '包入口默认导出的不是一个 WorldDefinition');

const cfg = def.defaults();
cfg.enabled = true;
cfg.mode = 'demo';
cfg.intervalMinutes = 30;
cfg.deliverDigest = true;

const world = def.create({
  id: def.id,
  cfg,
  timezone: 'Asia/Shanghai',
  botName: 'demo',
  botDir: dataDir,
  packageDir: dataDir,
  dataDir,
  repoRoot: dataDir,
  secret: () => '',
  storeSecret: () => {},
  persist: () => {},
  restart: async () => {},
});

process.stdout.write('cortico-world-mail 演示数据 E2E · dataDir=' + dataDir + '\n');
process.stdout.write('世界 id=' + def.id + ' · 工具声明 ' + def.describe.tools.length + ' 个 · 事件声明 ' + def.describe.events.length + ' 个\n\n');

await world.start(host);

const tools = Object.fromEntries(world.tools().map((tool) => [tool.name, tool]));
const call = async (name, args = {}) => {
  const tool = tools[name];
  assert.ok(tool, '工具不存在：' + name);
  const value = await tool.handler(args, { role: 'assistant', log: logger });
  return typeof value === 'string' ? value : String(value && value.text);
};

// 等演示首轮自动收信（demo=3 秒）跑完
const deadline = Date.now() + 8000;
while (Date.now() < deadline && !events.some((one) => one.event.type === 'mail.scanned')) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

process.stdout.write('— 工具 —\n');
const statusText = await call('mail_status');
check('mail_status 报告 demo 模式与知识库目录', () => {
  assert.match(statusText, /demo/i);
  assert.match(statusText, /知识库/);
});
process.stdout.write('  · status: ' + firstLines(statusText, 2) + '\n');

const listText = await call('mail_list', { limit: 10 });
const uids = findUids(listText);
check('mail_list 回执带 uid（mail_read/mail_reply 才能用）', () => {
  assert.ok(uids.length >= 3, '列表里解析不到 uid：#<数字>，实际回执首行：' + firstLines(listText, 2));
});
check('mail_list 至少列出 3 封演示邮件', () => {
  assert.ok(listText.split(/\r?\n/).filter((line) => line.trimStart().startsWith('·')).length >= 3);
});
process.stdout.write('  · list: ' + firstLines(listText, 3) + '\n');

const someUid = uids[0];
const readText = await call('mail_read', { uid: someUid });
check('mail_read 正文非空且是纯文本', () => {
  assert.match(readText, /\[正文\]/);
  assert.doesNotMatch(readText, /<(html|body|div|script)\b/i, '正文里出现原始 HTML 标签');
  const body = String(readText).split('[正文]')[1] ?? '';
  assert.ok(body.replace(/\[.*?\]|\(.*?\)/g, '').trim().length > 20, '正文为空');
});
process.stdout.write('  · read: ' + firstLines(readText, 3) + '\n');

const searchText = await call('mail_search', { query: '会议', limit: 10 });
check('mail_search 能搜到演示邮件', () => {
  assert.match(searchText, /\[搜到 [1-9]\d* 封\]/);
});
process.stdout.write('  · search: ' + firstLines(searchText, 2) + '\n');

const recallText = await call('mail_recall', { query: '会议' });
check('mail_recall 能从知识库离线检索到读过的邮件', () => {
  assert.match(recallText, /会议|回忆|找到|·/);
});
process.stdout.write('  · recall: ' + firstLines(recallText, 3) + '\n');

process.stdout.write('\n— 发信门禁 —\n');
const sendArgs = {
  to: 'friend@example.com',
  subject: '演示：来自 Coopanion 的一封信',
  text: '这是演示数据版 e2e 发出的一封信，不会真的离开本机。',
};
const previewText = await call('mail_send', sendArgs);
check('mail_send 不带 confirm 只返回草案，不发送', () => {
  assert.match(previewText, new RegExp(MAIL_SEND_PREVIEW_NEEDLE));
  assert.ok(!fs.existsSync(outboxFile), '预览阶段演示发件箱文件就已经出现了');
});
process.stdout.write('  · send 预览: ' + firstLines(previewText, 2) + '\n');

const sentText = await call('mail_send', { ...sendArgs, confirm: true });
check('mail_send 带 confirm 才写入演示发件箱（1 封）', () => {
  assert.ok(fs.existsSync(outboxFile), '确认发送后演示发件箱文件不存在');
  const lines = fs.readFileSync(outboxFile, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
  assert.equal(lines.length, 1, '演示发件箱条数不是 1：' + lines.length);
  assert.match(sentText, /已发|发出|发送/);
});
process.stdout.write('  · send 已发: ' + firstLines(sentText, 2) + '\n');

const replyPreview = await call('mail_reply', { uid: someUid, text: '收到，谢谢！——来自演示 e2e' });
check('mail_reply 不带 confirm 只返回草案', () => {
  assert.match(replyPreview, new RegExp(MAIL_SEND_PREVIEW_NEEDLE));
  assert.match(replyPreview, /#\d+/);
  const lines = fs.readFileSync(outboxFile, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
  assert.equal(lines.length, 1, '回信预览阶段发件箱就变了');
});
const replySent = await call('mail_reply', { uid: someUid, text: '收到，谢谢！——来自演示 e2e', confirm: true });
check('mail_reply 带 confirm 写入演示发件箱（累计 2 封）', () => {
  const lines = fs.readFileSync(outboxFile, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
  assert.equal(lines.length, 2, '演示发件箱条数不是 2：' + lines.length);
  assert.match(replySent, /已发|发出|发送/);
});

process.stdout.write('\n— 事件 —\n');
check('启动后推出 mail.ready（internal）', () => {
  const ready = events.find((one) => one.event.type === 'mail.ready');
  assert.ok(ready, '没有 mail.ready 事件');
  assert.equal(ready.event.origin, 'internal');
});
check('演示首轮推出 mail.scanned 且 deliver=false、不含主题/正文', () => {
  const scanned = events.find((one) => one.event.type === 'mail.scanned');
  assert.ok(scanned, '没有 mail.scanned 事件');
  assert.equal(scanned.event.origin, 'internal');
  assert.equal(scanned.options.deliver, false, 'mail.scanned 不该投递进对话');
  assert.doesNotMatch(String(scanned.event.text), /快件|会议|账单|验证码|周刊|周末|账户/);
});
check('有新邮件时推出 mail.new（external，只带摘要）', () => {
  const created = events.find((one) => one.event.type === 'mail.new');
  assert.ok(created, '没有 mail.new 事件');
  assert.equal(created.event.origin, 'external');
  assert.equal(created.options.deliver, true);
  assert.ok(String(created.event.text).length <= 2000, 'mail.new 文本过长');
});

check('知识库落盘了读过的邮件', () => {
  assert.ok(fs.existsSync(path.join(dataDir, 'mail')), 'dataDir/mail 目录不存在');
});

await world.stop();

const failed = results.filter((one) => !one.ok);
process.stdout.write('\n' + (failed.length === 0 ? 'E2E PASS' : 'E2E FAIL') + ' · ' + (results.length - failed.length) + '/' + results.length + ' 项\n');
if (failed.length > 0) {
  for (const one of failed) process.stdout.write('  ✘ ' + one.label + ' — ' + one.detail + '\n');
}
if (KEEP) process.stdout.write('保留临时目录：' + dataDir + '\n');
else fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
