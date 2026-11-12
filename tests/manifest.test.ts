/**
 * 契约形状的守门测试。跑法：node --test tests/
 *
 * 只读文件、只构造定义；不联网、不连邮箱。断言的是 PLAN 第 4、5、7 节与
 * build/cortico/src/extensions/manifest.ts 里带 file:line 的那些形状。
 *
 * 注意：definition.ts 按契约 `import { MailWorld } from './world.ts'`，而 src/world.ts 由 W3 提供。
 * 文件还没落盘时，依赖定义的用例显式 skip（不把「别人的文件还没写」记成失败）；落盘后自动生效。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
} from '../src/config.ts';
import { PREFLIGHT, TEXT, strings } from '../src/i18n.ts';

const ROOT = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const WORLD_READY = existsSync(join(ROOT, 'src', 'world.ts'));

/**
 * 只在 W3 的 src/world.ts 已落盘、且它依赖的文件也齐了之后才 import definition
 * （definition 按契约 import './world.ts'）。W3 正在写它时缺一个内部模块只是「还没就绪」，
 * 不该把 W2 的测试记成失败；任何别的错误照常抛，真坏了必须红。
 */
let definitionModule: typeof import('../src/definition.ts') | null = null;
let notReadyReason = '';
if (WORLD_READY) {
  try {
    definitionModule = await import('../src/definition.ts');
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') {
      notReadyReason = 'W3 的文件还没齐：' + String((error as Error).message);
    } else {
      throw error;
    }
  }
}

/** 依赖定义的用例在 W3 落盘前跳过；落盘后正常执行。 */
function requireDefinition(t: { skip(message: string): void }): boolean {
  if (definitionModule !== null) return true;
  t.skip(notReadyReason === '' ? 'src/world.ts 尚未就绪（W3 负责）' : notReadyReason);
  return false;
}

const TOOL_TAGS = ['read', 'write', 'speak', 'act', 'flow', 'snapshot'];
const TOOL_NAMES = [
  'mail_list',
  'mail_read',
  'mail_recall',
  'mail_reply',
  'mail_search',
  'mail_send',
  'mail_status',
];
const EVENT_TYPES = ['mail.down', 'mail.new', 'mail.ready', 'mail.scanned'];

test('package.json：入口、关键词、cortico 块', () => {
  assert.equal(pkg.name, 'cortico-world-mail');
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.type, 'module', 'CJS 会让扩展与框架各持一份模块实例（manifest.ts:6）');
  assert.equal(pkg.main, './src/index.ts', '源码直跑');
  assert.equal(pkg.exports['.'], './src/index.ts', '入口解析 exports→module→main（extensions.ts:119-130）');
  assert.ok(existsSync(join(ROOT, pkg.main)), 'main 指向的文件必须真的在');
  assert.ok(String(pkg.description).length > 0);
  assert.ok(pkg.keywords.includes('cortico-world'), '按类发现的关键字（manifest.ts:30-34）');
  assert.deepEqual(pkg.engines, { node: '>=22' });
  assert.equal(pkg.license, 'MIT');
  assert.deepEqual(pkg.scripts, { test: 'node --test' });
});

test('package.json：零第三方依赖、files 覆盖交付物', () => {
  assert.deepEqual(pkg.dependencies, {}, 'PLAN D5：零第三方依赖');
  for (const key of ['devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.equal(pkg[key], undefined, '不要藏依赖：' + key);
  }
  for (const wanted of ['src/', 'assets/', 'describe.json', 'README.md', 'LICENSE']) {
    assert.ok(pkg.files.includes(wanted), 'files 里少了 ' + wanted);
  }
});

test('cortico 块：kind/api=6/displayName/icon/describe/tags/locales', () => {
  const block = pkg.cortico;
  assert.equal(block.kind, 'world');
  assert.equal(block.api, 6, 'world 契约版本是 6（manifest.ts:23-27）');
  assert.equal(block.displayName, '邮箱');
  assert.equal(block.icon, 'assets/icon.svg');
  assert.equal(block.describe, 'describe.json');
  assert.ok(existsSync(join(ROOT, block.icon)));
  const svg = readFileSync(join(ROOT, block.icon), 'utf8');
  assert.match(svg, /^<svg[\s>]/, '图标必须是 svg（manifest.ts:40）');
  assert.match(svg, /viewBox="0 0 64 64"/);
  // Lead 定稿：internet＝读写互联网内容；sensitive-data＝持续读取私人数据（邮件属于此类）。
  assert.deepEqual(block.tags, ['internet', 'sensitive-data']);
});

test('cortico.locales：只认 zh / en，两份都完整', () => {
  const locales = pkg.cortico.locales;
  assert.deepEqual(Object.keys(locales).sort(), ['en', 'zh']);
  for (const [language, entry] of Object.entries(locales)) {
    assert.deepEqual(Object.keys(entry).sort(), ['description', 'displayName'], language + ' 的键集');
    assert.ok(String(entry.displayName).length > 0, language + ' displayName');
    assert.ok(String(entry.description).length > 0, language + ' description');
  }
  assert.equal(locales.zh.displayName, '邮箱');
});

test('config 常量：WORLD_ID / 前缀 / 配置组 owner', () => {
  assert.equal(WORLD_ID, 'mail');
  assert.equal(CONFIG_PREFIX, 'worlds.mail.');
  assert.equal(CONFIG_ID, 'world:mail');
  assert.equal(CONFIG_OWNER, 'world:mail', 'owner 必须恰好是 world:<id>（dry-mount.ts:216）');
  assert.deepEqual([...MAIL_MODES], ['demo', 'live']);
});

test('MAIL_DEFAULTS：PLAN 第 4 节的 17 项，enabled 默认 false', () => {
  assert.deepEqual(MAIL_DEFAULTS, {
    enabled: false,
    mode: 'demo',
    email: '',
    authCode: '',
    imapHost: 'imap.qq.com',
    imapPort: 993,
    smtpHost: 'smtp.qq.com',
    smtpPort: 465,
    fromName: '',
    folders: 'INBOX',
    intervalMinutes: 30,
    limitPerFetch: 20,
    vaultSubdir: 'mail',
    deliverDigest: true,
    digestMaxChars: 800,
    markSeenOnRead: false,
    maxBodyChars: 20000,
  });
  assert.equal(Object.keys(MAIL_DEFAULTS).length, 17);
  assert.equal(MAIL_DEFAULTS.enabled, false, '默认必须 false（dry-mount.ts:141-143）');
  assert.equal(MAIL_DEFAULTS.authCode, '', '默认凭据为空（PLAN 第 9 节）');
  assert.equal(MAIL_DEFAULTS.email, '');
});

test('MAIL_DECLARED_KEYS：恰好是 defaults 去掉 enabled 的 16 项', () => {
  assert.equal(MAIL_DECLARED_KEYS.length, 16);
  assert.deepEqual(
    [...MAIL_DECLARED_KEYS].sort(),
    Object.keys(MAIL_DEFAULTS)
      .filter((key) => key !== 'enabled')
      .sort(),
  );
  assert.ok(!MAIL_DECLARED_KEYS.includes('enabled'), 'enabled 是装配层的开关，不重复声明');
});

test('mailConfigGroups：16 个 worlds.mail.* 键与 defaults 一一对应', () => {
  for (const language of ['zh', 'en']) {
    const groups = mailConfigGroups(language as never);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].id, CONFIG_ID);
    assert.equal(groups[0].owner, CONFIG_OWNER);
    const properties = groups[0].schema.properties;
    assert.equal(Object.keys(properties).length, 16);
    for (const key of MAIL_DECLARED_KEYS) {
      const path = CONFIG_PREFIX + key;
      assert.ok(Object.hasOwn(properties, path), language + ' 缺配置项 ' + path);
      const property = properties[path];
      assert.ok(String(property.title).length > 0, path + ' 缺 title');
      assert.ok(String(property.description).length > 0, path + ' 缺 description');
      assert.equal(typeof property['x-hot'], 'boolean', path + ' 必须有 x-hot');
    }
  }
});

test('folderLines：按 PLAN 拆行（去空白 / 丢空行 / # 注释）', () => {
  assert.deepEqual(folderLines('INBOX'), ['INBOX']);
  assert.deepEqual(folderLines('  INBOX  \r\n\r\n# 这是注释\r\n已发送\r\n'), ['INBOX', '已发送']);
  assert.deepEqual(folderLines(''), []);
  assert.deepEqual(folderLines(null), []);
  assert.deepEqual(folderLines(undefined), []);
  assert.deepEqual(folderLines('#只有注释'), []);
  assert.deepEqual(folderLines('INBOX\n\n\n垃圾邮件'), ['INBOX', '垃圾邮件']);
});

test('i18n：zh/en 两份都在，label、7 个工具、4 个事件完整', () => {
  const zh = strings('zh');
  const en = strings('en');
  assert.equal(zh.label, '邮箱');
  assert.equal(en.label, 'Mailbox');

  for (const name of TOOL_NAMES) {
    assert.ok(typeof zh.tools[name] === 'string' && zh.tools[name].length > 0, 'zh 工具摘要 ' + name);
    assert.ok(typeof en.tools[name] === 'string' && en.tools[name].length > 0, 'en 工具摘要 ' + name);
  }
  for (const key of ['ready', 'down', 'scanned', 'new']) {
    assert.ok(typeof zh.events[key] === 'string' && zh.events[key].length > 0, 'zh 事件 ' + key);
    assert.ok(typeof en.events[key] === 'string' && en.events[key].length > 0, 'en 事件 ' + key);
  }
  for (const key of [
    'mode', 'email', 'authCode', 'imapHost', 'imapPort', 'smtpHost', 'smtpPort', 'fromName',
    'folders', 'intervalMinutes', 'limitPerFetch', 'vaultSubdir', 'deliverDigest',
    'digestMaxChars', 'markSeenOnRead', 'maxBodyChars',
  ]) {
    assert.ok(zh.config[key].title.length > 0, 'zh 配置标题 ' + key);
    assert.ok(zh.config[key].description.length > 0, 'zh 配置说明 ' + key);
    assert.ok(en.config[key].title.length > 0, 'en 配置标题 ' + key);
    assert.ok(en.config[key].description.length > 0, 'en 配置说明 ' + key);
  }
  for (const key of ['noConfig', 'connect', 'auth', 'protocol', 'parse']) {
    assert.ok(zh.failure[key].title.length > 0, 'zh 失败标题 ' + key);
    assert.ok(zh.failure[key].advice.length > 0, 'zh 失败建议 ' + key);
    assert.ok(en.failure[key].title.length > 0, 'en 失败标题 ' + key);
    assert.ok(en.failure[key].advice.length > 0, 'en 失败建议 ' + key);
  }
  for (const key of ['status', 'folders', 'interval', 'vault']) {
    assert.ok(zh.env.vars[key].length > 0, 'zh 环境变量说明 ' + key);
    assert.ok(en.env.vars[key].length > 0, 'en 环境变量说明 ' + key);
  }
});

test('PREFLIGHT：五类报错都点名缺什么', () => {
  assert.match(PREFLIGHT.modeUnknown('bogus'), /demo \/ live/);
  assert.match(PREFLIGHT.portInvalid('imapPort', '0'), /worlds\.mail\.imapPort/);
  assert.match(PREFLIGHT.emailInvalid('not-mail'), /email/);
  assert.match(PREFLIGHT.authCodeMissing(), /授权码/);
  assert.match(PREFLIGHT.authCodeMissing(), /QQ_MAIL_AUTH_CODE/);
  assert.match(PREFLIGHT.authCodeMissing(), /不是 QQ 登录密码|不是 QQ 密码/);
  assert.match(PREFLIGHT.foldersEmpty(), /folders/);
});

test('ENV_PROMPT.md：变量、注入警告、发信确认、失败 5 类、先 recall 都在', () => {
  const path = join(ROOT, 'src', 'ENV_PROMPT.md');
  assert.ok(existsSync(path), 'src/ENV_PROMPT.md 必须存在');
  const text = readFileSync(path, 'utf8');
  for (const variable of ['status', 'folders', 'interval', 'vault']) {
    assert.ok(text.includes('{{mail.' + variable + '}}'), '环境提示词缺变量 {{mail.' + variable + '}}');
  }
  assert.match(text, /第三方/, '必须写清邮件内容是第三方数据');
  assert.match(text, /不是指令|不是操作员的\s*指令/);
  assert.match(text, /confirm/, '必须写清发信要确认');
  assert.match(text, /mail_recall/, '必须写清先查知识库');
  assert.match(text, /demo/);
  assert.match(text, /live/);
  for (const label of ['配置没填完', '连不上服务器', '登录被拒', '服务器回了错', '内容解析失败']) {
    assert.ok(text.includes(label), '环境提示词缺失败类别：' + label);
  }
});

test('定义形状：id/label/defaults/preflight/create/describe（需 W3 的 world.ts）', (t) => {
  if (!requireDefinition(t)) return;
  const definition = definitionModule!.MAIL_DEFINITION;
  assert.equal(definition.id, 'mail');
  assert.equal(definition.label, '邮箱');
  assert.equal(typeof definition.defaults, 'function');
  assert.equal(typeof definition.preflight, 'function');
  assert.equal(typeof definition.create, 'function');
  assert.equal(typeof definition.describe, 'object');
  assert.equal(definition.defaults().enabled, false);
});

test('defaults()：与 MAIL_DEFAULTS 相等，且每次一个新对象', (t) => {
  if (!requireDefinition(t)) return;
  const definition = definitionModule!.MAIL_DEFINITION;
  const first = definition.defaults();
  assert.deepEqual(first, MAIL_DEFAULTS);
  assert.notEqual(first, MAIL_DEFAULTS, 'defaults() 不能把常量本身交出去');
  const second = definition.defaults();
  assert.notEqual(first, second, '每次一个新对象（world.ts:98-108）');
  first.mode = 'live';
  assert.equal(second.mode, 'demo', '改一份不能影响另一份');
});

test('TOOL_SPECS：7 个工具，名字/参数/required/tags 逐字照 PLAN 第 5 节', (t) => {
  if (!requireDefinition(t)) return;
  const specs = definitionModule!.TOOL_SPECS;
  assert.equal(specs.length, 7, 'PLAN 第 5 节的 7 个工具');
  assert.deepEqual(specs.map((spec) => spec.name).sort(), TOOL_NAMES);

  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const tags = (name: string) => byName.get(name)!.tags;
  const props = (name: string) => Object.keys(byName.get(name)!.parameters.properties ?? {});
  const required = (name: string) => byName.get(name)!.parameters.required ?? [];

  assert.deepEqual(tags('mail_status'), ['read', 'snapshot']);
  assert.deepEqual(props('mail_status'), []);

  assert.deepEqual(tags('mail_list'), ['read', 'snapshot']);
  assert.deepEqual(props('mail_list'), ['folder', 'limit', 'unreadOnly']);
  assert.equal(byName.get('mail_list')!.parameters.properties.limit.maximum, 100);
  assert.equal(byName.get('mail_list')!.parameters.properties.limit.minimum, 1);
  assert.deepEqual(required('mail_list'), []);

  assert.deepEqual(tags('mail_read'), ['read', 'write', 'snapshot']);
  assert.deepEqual(props('mail_read'), ['uid', 'folder', 'maxChars']);
  assert.deepEqual(required('mail_read'), ['uid']);

  assert.deepEqual(tags('mail_search'), ['read', 'snapshot']);
  assert.deepEqual(props('mail_search'), ['query', 'folder', 'limit', 'from', 'since']);
  assert.deepEqual(required('mail_search'), ['query']);

  assert.deepEqual(tags('mail_send'), ['act', 'write']);
  assert.deepEqual(props('mail_send'), ['to', 'subject', 'text', 'cc', 'bcc', 'confirm']);
  assert.deepEqual(required('mail_send'), ['to', 'subject', 'text']);

  assert.deepEqual(tags('mail_reply'), ['act', 'write']);
  assert.deepEqual(props('mail_reply'), ['uid', 'folder', 'text', 'confirm']);
  assert.deepEqual(required('mail_reply'), ['uid', 'text']);

  assert.deepEqual(tags('mail_recall'), ['read']);
  assert.deepEqual(props('mail_recall'), ['query', 'limit']);
  assert.deepEqual(required('mail_recall'), ['query']);

  for (const spec of specs) {
    assert.match(spec.name, /^mail_[a-z]+$/, '工具名约定 mail_<动词>：' + spec.name);
    assert.equal(spec.parameters.type, 'object', spec.name + ' 的参数是 JSON Schema object');
    assert.equal(spec.parameters.additionalProperties, false, spec.name + ' 不允许额外参数');
    assert.ok(spec.tags.length > 0, spec.name + ' 标签为空会被 warn');
    for (const tag of spec.tags) assert.ok(TOOL_TAGS.includes(tag), '词表外的标签：' + tag);
    assert.ok(spec.description.length > 60, spec.name + ' 的 description 太短');
  }
});

test('TOOL_SPECS：第三方数据警告与 confirm 门禁写在模型看得到的描述里', (t) => {
  if (!requireDefinition(t)) return;
  const specs = definitionModule!.TOOL_SPECS;
  const description = (name: string) => specs.find((spec) => spec.name === name)!.description.toLowerCase();
  for (const name of ['mail_list', 'mail_read', 'mail_search', 'mail_reply']) {
    const text = description(name);
    assert.match(text, /third part|third-part/, name + ' 必须写清邮件内容来自第三方');
    assert.match(text, /never[^.]*instruction/, name + ' 必须写清不是指令');
  }
  for (const name of ['mail_send', 'mail_reply']) {
    const text = description(name);
    assert.match(text, /confirm=true/, name + ' 必须写清 confirm 门禁');
    assert.match(text, /sends nothing|draft preview/, name + ' 必须写清不带 confirm 只预览');
  }
  // PLAN §5 只对 mail_list / mail_read 要求写知识库；mail_search 不该宣称落库。
  assert.ok(!description('mail_search').includes('stores them in the local knowledge base'));
});

test('EVENT_SPECS：4 个事件，名字与 trigger 照 PLAN 第 7 节', (t) => {
  if (!requireDefinition(t)) return;
  const events = definitionModule!.EVENT_SPECS;
  assert.equal(events.length, 4);
  assert.deepEqual(events.map((event) => event.type).sort(), EVENT_TYPES);
  const trigger = (type: string) => events.find((event) => event.type === type)!.trigger;
  assert.equal(trigger('mail.ready'), 'flush');
  assert.equal(trigger('mail.down'), 'flush');
  assert.equal(trigger('mail.scanned'), 'flush');
  assert.equal(trigger('mail.new'), 'debounce');
  for (const event of events) {
    assert.equal(event.description.zh.length > 0, true, event.type + ' 缺中文说明');
    assert.equal(event.description.en.length > 0, true, event.type + ' 缺英文说明');
  }
});

test('describe：工具与事件与声明逐字一致（W3 落盘后）', (t) => {
  if (!requireDefinition(t)) return;
  const definition = definitionModule!.MAIL_DEFINITION;
  const describe = definition.describe!;
  const specs = definitionModule!.TOOL_SPECS;
  assert.deepEqual(describe.tools.map((tool) => tool.name), specs.map((spec) => spec.name));
  for (const [index, tool] of describe.tools.entries()) {
    assert.deepEqual(tool.parameters, specs[index].parameters, tool.name + ' 参数不一致');
    assert.deepEqual(tool.tags, specs[index].tags, tool.name + ' 标签不一致');
    assert.equal(typeof tool.summary, 'object');
    assert.ok(tool.summary.zh.length > 0 && tool.summary.en.length > 0, tool.name + ' 的一句话摘要');
  }
  assert.deepEqual(describe.events, definitionModule!.EVENT_SPECS);
});

test('preflight：demo 直接通过；live 缺凭据点名报错（W3 落盘后）', (t) => {
  if (!requireDefinition(t)) return;
  const definition = definitionModule!.MAIL_DEFINITION;
  const base = () => ({ ...MAIL_DEFAULTS });
  const ctx = (overrides: Record<string, unknown>) => {
    const cfg = { ...base(), ...overrides };
    return { cfg, secret: () => '' } as never;
  };

  // demo：不联网、不需要凭据，直接通过；哪怕 email / 端口是乱填的也不拦。
  assert.doesNotThrow(() => definition.preflight!(ctx({ mode: 'demo' })));
  assert.doesNotThrow(() => definition.preflight!(ctx({ mode: 'demo', email: 'nope', imapPort: 0 })));

  // mode 不认识
  assert.throws(() => definition.preflight!(ctx({ mode: 'cloud' })), /demo \/ live/);

  // live：缺 email
  assert.throws(
    () => definition.preflight!(ctx({ mode: 'live', folders: 'INBOX' })),
    /worlds\.mail\.email/,
  );
  // live：email 不像邮箱
  assert.throws(
    () => definition.preflight!(ctx({ mode: 'live', email: 'not-an-address', authCode: 'demo-code' })),
    /worlds\.mail\.email/,
  );
  // live：缺授权码
  assert.throws(
    () => definition.preflight!(ctx({ mode: 'live', email: 'someone@example.com', authCode: '' })),
    /授权码/,
  );
  // live：folders 空
  assert.throws(
    () =>
      definition.preflight!(
        ctx({ mode: 'live', email: 'someone@example.com', authCode: 'demo-code', folders: ' # 只有注释\n\n' }),
      ),
    /worlds\.mail\.folders/,
  );
  // live：端口非法
  assert.throws(
    () =>
      definition.preflight!(
        ctx({ mode: 'live', email: 'someone@example.com', authCode: 'demo-code', imapPort: 70000 }),
      ),
    /worlds\.mail\.imapPort/,
  );
  // live：环境变量里的授权码也算（PLAN 第 4 节：.env 的 QQ_MAIL_AUTH_CODE 是备选来源）
  const previous = process.env.QQ_MAIL_AUTH_CODE;
  process.env.QQ_MAIL_AUTH_CODE = 'demo-auth-code-placeholder';
  try {
    assert.doesNotThrow(() =>
      definition.preflight!(
        ctx({ mode: 'live', email: 'someone@example.com', folders: 'INBOX', authCode: '' }),
      ),
    );
  } finally {
    if (previous === undefined) delete process.env.QQ_MAIL_AUTH_CODE;
    else process.env.QQ_MAIL_AUTH_CODE = previous;
  }
});

test('describe.json：W4 产出与代码一致（未就绪则跳过）', (t) => {
  const path = join(ROOT, pkg.cortico.describe);
  if (!existsSync(path)) {
    t.skip('describe.json 由 W4 写，尚未就绪');
    return;
  }
  if (!requireDefinition(t)) return;
  const definition = definitionModule!.MAIL_DEFINITION;
  const describe = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(describe.tools, definition.describe!.tools);
  assert.deepEqual(describe.events, definition.describe!.events);
  assert.equal(describe.prompts.length, 1);
  assert.equal(describe.prompts[0].key, 'worlds.mail.envPrompt');
  assert.equal(describe.prompts[0].role, 'envPrompt');
  assert.equal(
    describe.prompts[0].content,
    readFileSync(join(ROOT, 'src', 'ENV_PROMPT.md'), 'utf8'),
    'prompts 的 content 是 ENV_PROMPT.md 原文',
  );
  for (const key of Object.keys(describe)) {
    assert.ok(['tools', 'events', 'prompts'].includes(key), 'world 包只有这三类字段：' + key);
  }
  assert.ok(!JSON.stringify(describe).includes('injection-risk'));
});
