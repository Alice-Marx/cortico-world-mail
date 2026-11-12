/**
 * 配置契约与文案的守门测试。跑法：node --test tests/config.test.ts
 *
 * 只读文件、只读常量；不联网、不写任何东西。断言的是 PLAN 第 4 节（默认值即契约）、
 * 第 6 节（5 类失败）与第 9 节（默认凭据为空）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  CONFIG_ID,
  CONFIG_OWNER,
  CONFIG_PREFIX,
  MAIL_DECLARED_KEYS,
  MAIL_DEFAULTS,
  MAIL_MODES,
  WORLD_ID,
  folderLines,
  mailConfigGroups,
  parseFolderLines,
} from '../src/config.ts';
import {
  FAILURE_ADVICE,
  FAILURE_CLASSES,
  FAILURE_LABEL,
  MODEL,
  PREFLIGHT,
  TEXT,
  classifyFailure,
  failureAdvice,
  failureTitle,
  strings,
} from '../src/i18n.ts';

const ROOT = resolve(import.meta.dirname, '..');
const CONFIG_SOURCE = readFileSync(join(ROOT, 'src', 'config.ts'), 'utf8');

/** PLAN 第 4 节的默认值表：键 → [类型, 默认值]。 */
const PLAN_DEFAULTS: ReadonlyArray<[string, 'boolean' | 'number' | 'string', boolean | number | string]> = [
  ['enabled', 'boolean', false],
  ['mode', 'string', 'demo'],
  ['email', 'string', ''],
  ['authCode', 'string', ''],
  ['imapHost', 'string', 'imap.qq.com'],
  ['imapPort', 'number', 993],
  ['smtpHost', 'string', 'smtp.qq.com'],
  ['smtpPort', 'number', 465],
  ['fromName', 'string', ''],
  ['folders', 'string', 'INBOX'],
  ['intervalMinutes', 'number', 30],
  ['limitPerFetch', 'number', 20],
  ['vaultSubdir', 'string', 'mail'],
  ['deliverDigest', 'boolean', true],
  ['digestMaxChars', 'number', 800],
  ['markSeenOnRead', 'boolean', false],
  ['maxBodyChars', 'number', 20000],
];

test('默认值：PLAN 第 4 节逐字照抄，类型也对', () => {
  assert.equal(Object.keys(MAIL_DEFAULTS).length, PLAN_DEFAULTS.length, '17 项');
  for (const [key, type, expected] of PLAN_DEFAULTS) {
    const actual = (MAIL_DEFAULTS as unknown as Record<string, unknown>)[key];
    assert.equal(actual, expected, 'worlds.mail.' + key + ' 的默认值');
    assert.equal(typeof actual, type, 'worlds.mail.' + key + ' 的类型');
    if (type === 'number') assert.ok(Number.isInteger(actual), 'worlds.mail.' + key + ' 必须是整数');
  }
  assert.equal(MAIL_DEFAULTS.enabled, false, '装配层默认关（PLAN 第 4 节第一行）');
});

test('默认值：demo 模式、无凭据；仓库里没有真实 QQ 邮箱/授权码', () => {
  assert.equal(MAIL_DEFAULTS.mode, 'demo', '第一版默认跑演示数据（PLAN D4）');
  assert.equal(MAIL_DEFAULTS.email, '');
  assert.equal(MAIL_DEFAULTS.authCode, '', '凭据默认必须空（PLAN 第 9 节）');
  const serialized = JSON.stringify(MAIL_DEFAULTS);
  assert.ok(!/\d{5,}@qq\.com/.test(serialized), '默认值里不得出现形似真实 QQ 邮箱的地址');
  assert.ok(!/\b[a-z0-9]{16}\b/.test(MAIL_DEFAULTS.authCode), '不得有硬编码授权码');
  assert.ok(!/\d{5,}@qq\.com/.test(CONFIG_SOURCE), 'config.ts 源码里不得出现形似真实 QQ 邮箱的地址');
});

test('MAIL_DECLARED_KEYS：16 项，全部在 defaults 里，enabled 不在其中', () => {
  assert.equal(MAIL_DECLARED_KEYS.length, 16);
  assert.equal(new Set(MAIL_DECLARED_KEYS).size, 16, '不能重复声明');
  assert.ok(!MAIL_DECLARED_KEYS.includes('enabled'), 'enabled 是装配层通用开关，不重复声明');
  for (const key of MAIL_DECLARED_KEYS) {
    assert.ok(Object.hasOwn(MAIL_DEFAULTS, key), '声明了但 defaults() 里没有：' + key);
  }
  assert.deepEqual(
    Object.keys(MAIL_DEFAULTS).filter((key) => key !== 'enabled').sort(),
    [...MAIL_DECLARED_KEYS].sort(),
  );
});

test('配置组：键全是 worlds.mail.*，与声明一一对应（zh）', () => {
  const groups = mailConfigGroups('zh');
  assert.equal(groups.length, 1);
  const group = groups[0];
  assert.equal(group.id, CONFIG_ID);
  assert.equal(group.owner, CONFIG_OWNER);
  assert.equal(group.schema.type, 'object');
  assert.equal(group.schema.title, '邮箱');
  const paths = Object.keys(group.schema.properties);
  assert.equal(paths.length, 16);
  assert.deepEqual(paths.sort(), MAIL_DECLARED_KEYS.map((key) => CONFIG_PREFIX + key).sort());
  for (const path of paths) assert.ok(path.startsWith('worlds.mail.'), '键必须在 worlds.mail 段内：' + path);
});

test('配置组：类型、枚举、范围与 x-hot 规则照 PLAN', () => {
  const properties = mailConfigGroups('zh')[0].schema.properties;
  assert.equal(properties['worlds.mail.mode'].type, 'string');
  assert.deepEqual(properties['worlds.mail.mode'].enum, [...MAIL_MODES]);
  for (const key of ['email', 'authCode', 'imapHost', 'smtpHost', 'fromName', 'folders', 'vaultSubdir']) {
    assert.equal(properties['worlds.mail.' + key].type, 'string', key + ' 是字符串');
  }
  for (const key of ['imapPort', 'smtpPort', 'intervalMinutes', 'limitPerFetch', 'digestMaxChars', 'maxBodyChars']) {
    assert.equal(properties['worlds.mail.' + key].type, 'integer', key + ' 是整数');
  }
  for (const key of ['deliverDigest', 'markSeenOnRead']) {
    assert.equal(properties['worlds.mail.' + key].type, 'boolean', key + ' 是开关');
  }
  assert.deepEqual(
    [properties['worlds.mail.imapPort'].minimum, properties['worlds.mail.imapPort'].maximum],
    [1, 65535],
  );
  assert.deepEqual(
    [properties['worlds.mail.smtpPort'].minimum, properties['worlds.mail.smtpPort'].maximum],
    [1, 65535],
  );
  assert.equal(properties['worlds.mail.intervalMinutes'].minimum, 0, '0＝不自动收');
  assert.equal(properties['worlds.mail.limitPerFetch'].maximum, 100);

  // PLAN：凭据/主机/端口/folders/vaultSubdir 这类改动需要重连或重启的用 false，其余 true。
  const cold = [
    'mode', 'email', 'authCode', 'imapHost', 'imapPort', 'smtpHost', 'smtpPort', 'folders', 'vaultSubdir',
  ];
  const hot = [
    'fromName', 'intervalMinutes', 'limitPerFetch', 'deliverDigest', 'digestMaxChars',
    'markSeenOnRead', 'maxBodyChars',
  ];
  for (const key of cold) {
    assert.equal(properties['worlds.mail.' + key]['x-hot'], false, key + ' 改动需要重连/重启');
  }
  for (const key of hot) {
    assert.equal(properties['worlds.mail.' + key]['x-hot'], true, key + ' 应该能热改');
  }
});

test('配置组：英文一份也完整（给市场/英文界面）', () => {
  const zh = mailConfigGroups('zh')[0];
  const en = mailConfigGroups('en')[0];
  assert.equal(en.schema.title, 'Mailbox');
  assert.deepEqual(Object.keys(en.schema.properties), Object.keys(zh.schema.properties));
  for (const [path, property] of Object.entries(en.schema.properties)) {
    assert.ok(property.title.length > 0, path + ' 缺英文 title');
    assert.ok(property.description.length > 0, path + ' 缺英文 description');
    assert.notEqual(property.title, zh.schema.properties[path].title, path + ' 的英文标题不该等于中文');
  }
});

test('authCode 说明：写清去哪申请、不是登录密码、可用 .env 备选', () => {
  const zh = mailConfigGroups('zh')[0].schema.properties['worlds.mail.authCode'].description;
  for (const word of ['授权码', '设置', '账号', '不是', '登录密码', 'IMAP/SMTP', 'QQ_MAIL_AUTH_CODE']) {
    assert.ok(zh.includes(word), 'authCode 中文说明缺「' + word + '」');
  }
  assert.ok(!/\d{5,}@qq\.com/.test(zh), '说明里不得出现形似真实地址的示例');

  const en = mailConfigGroups('en')[0].schema.properties['worlds.mail.authCode'].description;
  for (const word of ['authorization code', 'Settings', 'Account', 'not', 'password', 'QQ_MAIL_AUTH_CODE']) {
    assert.ok(en.includes(word), 'authCode 英文说明缺「' + word + '」');
  }
});

test('folderLines：多行文本的解析规则（空白/空行/# 注释）', () => {
  assert.deepEqual(folderLines('INBOX'), ['INBOX']);
  assert.deepEqual(folderLines('INBOX\r\n已发送\r\n垃圾邮件'), ['INBOX', '已发送', '垃圾邮件']);
  assert.deepEqual(folderLines('  INBOX  \n  # 注释行\n\n\n已发送\n'), ['INBOX', '已发送']);
  assert.deepEqual(folderLines(''), []);
  assert.deepEqual(folderLines('   '), []);
  assert.deepEqual(folderLines('#注释\n#再一行'), []);
  assert.deepEqual(folderLines(null), []);
  assert.deepEqual(folderLines(undefined), []);
  assert.deepEqual(folderLines(42), ['42'], '非字符串先转字符串，不静默丢');
  assert.deepEqual(parseFolderLines('INBOX'), folderLines('INBOX'), 'parseFolderLines 与 folderLines 同义');
});

test('5 类失败：标签互不冒充，MailErrorCode 映射齐全', () => {
  assert.deepEqual([...FAILURE_CLASSES], ['no-config', 'connect', 'auth', 'protocol', 'parse']);
  assert.equal(new Set(Object.values(FAILURE_LABEL)).size, 5, '5 个分类标签不能重样');
  for (const kind of FAILURE_CLASSES) {
    assert.ok(FAILURE_LABEL[kind].length > 0, '缺分类标签：' + kind);
    assert.ok(FAILURE_ADVICE[kind].length > 0, '缺分类建议：' + kind);
  }
  // PLAN 3.1 的 8 个 MailErrorCode 映射到 5 类：连接类四种合成一类。
  assert.equal(classifyFailure('no-config'), 'no-config');
  for (const code of ['connect', 'tls', 'timeout', 'dropped']) {
    assert.equal(classifyFailure(code), 'connect', code + ' 都算连不上服务器');
  }
  assert.equal(classifyFailure('auth'), 'auth', '登录被拒不许冒充连接失败');
  assert.equal(classifyFailure('protocol'), 'protocol');
  assert.equal(classifyFailure('parse'), 'parse');
  assert.equal(classifyFailure('something-else'), 'protocol', '未知错误归服务器报错，不冒充连接失败');
});

test('失败回执：zh/en 标题与建议可读，preflight 模板有占位符', () => {
  assert.equal(strings('zh').failure.noConfig.title, '配置没填完');
  assert.equal(strings('zh').failure.connect.title, '连不上服务器');
  assert.equal(strings('zh').failure.auth.title, '登录被拒');
  assert.equal(strings('zh').failure.protocol.title, '服务器回了错');
  assert.equal(strings('zh').failure.parse.title, '内容解析失败');
  assert.equal(failureTitle('auth', 'zh'), '登录被拒');
  assert.equal(failureTitle('auth', 'en'), 'Login rejected');
  assert.ok(failureAdvice('connect', 'zh').includes('网络'));
  assert.ok(failureAdvice('connect', 'en').length > 0);
  assert.match(PREFLIGHT.portInvalid('smtpPort', '0'), /65535/);
  assert.match(PREFLIGHT.emailInvalid(''), /email/);
});

test('MODEL：进系统前缀的中文固定文案', () => {
  for (const key of ['idle', 'starting', 'ready', 'failed', 'demo', 'live']) {
    assert.ok(String((MODEL.status as Record<string, string>)[key]).length > 0, 'MODEL.status.' + key);
  }
  assert.match(MODEL.status.demo, /demo/);
  assert.match(MODEL.status.live, /live/);
  assert.match(MODEL.intervalOn(30), /30/);
  assert.match(MODEL.intervalOff, /intervalMinutes=0/);
  assert.match(MODEL.vault('mail'), /mail\//);
  assert.match(MODEL.foldersSome(['INBOX', '垃圾邮件']), /INBOX、垃圾邮件/);
  assert.match(MODEL.foldersNone, /文件夹/);
  assert.match(MODEL.confirmGate, /confirm/);
});

test('strings()：zh / zh-Hant 取中文，其余语言取英文，缺省中文', () => {
  assert.equal(strings('zh').label, '邮箱');
  assert.equal(strings('zh-Hant').label, '邮箱');
  assert.equal(strings('en').label, 'Mailbox');
  assert.equal(strings('fr').label, 'Mailbox');
  assert.equal(strings().label, '邮箱');
  assert.equal(strings(undefined).label, '邮箱');
  // TEXT 保留成对形式，describeTools 的 summary 需要 zh/en 两份。
  assert.equal(TEXT.label.zh, '邮箱');
  assert.equal(TEXT.label.en, 'Mailbox');
  assert.equal(WORLD_ID, 'mail');
});
