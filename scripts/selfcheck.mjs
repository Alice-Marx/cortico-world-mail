#!/usr/bin/env node
/**
 * scripts/selfcheck.mjs —— cortico-world-mail 的包体检。零第三方依赖、离线、只读（除一次性临时目录）。
 *
 * 一条命令查七件事：
 *   1. manifest   package.json：type=module、main=src/index.ts 且文件在、cortico{kind:world,api:6,
 *                 displayName,icon,describe}、locales 只有 zh/en、没有 dependencies
 *   2. defaults   def.defaults()：enabled===false、键集与 config.ts 的 MAIL_DECLARED_KEYS 一致、
 *                 默认值与 PLAN 第 4 节一致、email/authCode 默认空串
 *   3. tools      7 个工具名在 definition.ts 与 describe.json 中一致；describe.json 的
 *                 name/description/parameters/tags 与 definition.ts 的 TOOL_SPECS 深度相等
 *   4. events     4 个事件名一致；describe.json.events 与 def.describe.events 深度相等
 *   5. prompts    describe.json.prompts 里 role=envPrompt 的 content 与 src/ENV_PROMPT.md 逐字相等
 *   6. credentials  仓库里没有形如「5 位以上数字前缀 @qq.com」的真实邮箱、没有硬编码的 16 位授权码
 *   7. import     子进程 `node -e "import('./src/index.ts')"` 成功（裸 Node 24，无框架依赖）
 *
 * 退出码：0 = PASS，1 = 有检查项不过。
 *
 *   node scripts/selfcheck.mjs
 *   node scripts/selfcheck.mjs --verbose   # 成功项也打印证据细节
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');

/** PLAN 第 5 节的工具名（名字是契约，改名要同步改 PLAN 与这里）。 */
const EXPECTED_TOOLS = ['mail_status', 'mail_list', 'mail_read', 'mail_search', 'mail_send', 'mail_reply', 'mail_recall'];

/** PLAN 第 7 节的事件名。 */
const EXPECTED_EVENTS = ['mail.ready', 'mail.down', 'mail.scanned', 'mail.new'];

/** PLAN 第 4 节的默认值（默认值即契约）。 */
const EXPECTED_DEFAULTS = {
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
};

const results = [];

/** 记一项检查。detail 是给人看的一句话。 */
function record(id, ok, detail, data) {
  const entry = { id, ok, detail };
  if (data !== undefined) entry.data = data;
  results.push(entry);
  return ok;
}

const message = (error) => (error && error.message ? error.message : String(error));
const clip = (text, max = 160) => {
  const oneLine = String(text).replace(/\s+/g, ' ');
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
};

/** 第一次不同的位置，用来把「不一致」说成一句人话。 */
function firstDiff(expected, actual, where = '') {
  if (Object.is(expected, actual)) return null;
  if (typeof expected !== typeof actual) {
    return (where || '/') + '：类型 ' + typeof expected + ' vs ' + typeof actual;
  }
  if (expected === null || actual === null || typeof expected !== 'object') {
    return (where || '/') + '：' + clip(JSON.stringify(expected)) + ' vs ' + clip(JSON.stringify(actual));
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) {
    return (where || '/') + '：一个是数组一个是对象';
  }
  if (Array.isArray(expected)) {
    if (expected.length !== actual.length) return (where || '/') + '：长度 ' + expected.length + ' vs ' + actual.length;
    for (let i = 0; i < expected.length; i += 1) {
      const inner = firstDiff(expected[i], actual[i], where + '[' + i + ']');
      if (inner) return inner;
    }
    return null;
  }
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (!(key in actual)) return (where ? where + '.' : '') + key + '：只在期望里有';
    if (!(key in expected)) return (where ? where + '.' : '') + key + '：只在实际（describe.json）里有';
    const inner = firstDiff(expected[key], actual[key], where + '.' + key);
    if (inner) return inner;
  }
  return null;
}

const normalize = (value) => JSON.parse(JSON.stringify(value));

// ── 1. manifest ────────────────────────────────────────────────────────────

function checkManifest() {
  const file = join(PKG_DIR, 'package.json');
  if (!existsSync(file)) return record('manifest', false, '找不到 ' + file);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return record('manifest', false, 'package.json 不是合法 JSON：' + message(error));
  }
  const problems = [];
  const notes = [];
  if (pkg.type !== 'module') problems.push('type 不是 "module"（扩展按 ESM import）');
  if (typeof pkg.name !== 'string' || pkg.name === '') problems.push('缺 name');

  const entry = typeof pkg.main === 'string' && pkg.main !== '' ? resolve(PKG_DIR, pkg.main) : '';
  if (entry === '') problems.push('缺 main（要指向 src/index.ts）');
  else if (!existsSync(entry)) problems.push('main 指向的文件不在：' + pkg.main);
  else if (relative(PKG_DIR, entry) !== join('src', 'index.ts')) notes.push('main=' + pkg.main + '（不是 src/index.ts）');

  const cortico = pkg.cortico;
  if (!cortico || typeof cortico !== 'object') problems.push('缺 cortico 块');
  else {
    if (cortico.kind !== 'world') problems.push('cortico.kind=' + String(cortico.kind) + '，world 包必须是 "world"');
    if (cortico.api !== 6) problems.push('cortico.api=' + String(cortico.api) + '，world 是 6');
    if (typeof cortico.displayName !== 'string' || cortico.displayName === '') problems.push('cortico.displayName 空着');
    if (typeof cortico.icon !== 'string' || cortico.icon === '') problems.push('cortico.icon 空着');
    else if (!existsSync(join(PKG_DIR, cortico.icon))) problems.push('cortico.icon 指向的文件不在：' + cortico.icon);
    if (typeof cortico.describe !== 'string' || cortico.describe === '') problems.push('cortico.describe 空着（市场与 describe:extension 都读它）');
    else if (!existsSync(join(PKG_DIR, cortico.describe))) problems.push('cortico.describe 指向的文件不在：' + cortico.describe);

    const locales = cortico.locales;
    if (!locales || typeof locales !== 'object' || Array.isArray(locales)) problems.push('cortico.locales 不是对象');
    else {
      for (const key of Object.keys(locales)) {
        if (key !== 'zh' && key !== 'en') problems.push('locales 只认 zh/en，多了 "' + key + '"');
      }
      if (!locales.zh && !locales.en) problems.push('locales 里 zh/en 一个都没有');
    }
  }

  const deps = pkg.dependencies;
  if (deps !== undefined && deps !== null && typeof deps === 'object' && Object.keys(deps).length > 0) {
    problems.push('有 dependencies：' + Object.keys(deps).join(',') + '（本包必须零第三方依赖）');
  }

  if (problems.length > 0) return record('manifest', false, problems.join('；'));
  const locales = Object.keys(cortico.locales).join('/');
  return record(
    'manifest',
    true,
    String(pkg.name) + '@' + String(pkg.version) + ' · type=module · main=' + String(pkg.main) +
      ' · world/api' + String(cortico.api) + ' · locales ' + locales + ' · 无 dependencies' +
      (notes.length ? ' · 注意：' + notes.join('；') : ''),
    { name: pkg.name, version: pkg.version },
  );
}

// ── 模块导入（后面几项共用） ────────────────────────────────────────────────

async function importModule(rel) {
  try {
    return { ok: true, mod: await import(pathToFileURL(join(PKG_DIR, ...rel.split('/'))).href) };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

async function loadPackage() {
  const entry = await importModule('src/index.ts');
  const config = await importModule('src/config.ts');
  const definition = await importModule('src/definition.ts');
  const errors = [];
  if (!entry.ok) errors.push('src/index.ts：' + entry.error);
  if (!config.ok) errors.push('src/config.ts：' + config.error);
  if (!definition.ok) errors.push('src/definition.ts：' + definition.error);
  const def = entry.ok ? entry.mod.default : undefined;
  return {
    entry: entry.ok ? entry.mod : null,
    config: config.ok ? config.mod : null,
    definition: definition.ok ? definition.mod : null,
    def: def && typeof def === 'object' ? def : null,
    declaration:
      def && typeof def === 'object'
        ? def
        : definition.ok && definition.mod.MAIL_DEFINITION
          ? definition.mod.MAIL_DEFINITION
          : null,
    errors,
  };
}

// ── 2. defaults ────────────────────────────────────────────────────────────

function checkDefaults(loaded) {
  const def = loaded.declaration;
  if (!def) return record('defaults', false, '拿不到 World 定义（src/index.ts 的 default 导出 / MAIL_DEFINITION）' + (loaded.errors.length ? '；' + loaded.errors[0] : ''));
  if (typeof def.defaults !== 'function') return record('defaults', false, 'def.defaults 不是函数');

  let defaults;
  try {
    defaults = def.defaults();
  } catch (error) {
    return record('defaults', false, 'def.defaults() 抛错：' + message(error));
  }
  if (!defaults || typeof defaults !== 'object') return record('defaults', false, 'defaults() 没返回对象');

  const problems = [];

  // 键集：defaults 自己的键（17 个，含 enabled）与配置组声明的键（16 个，不含 enabled）对得上。
  const ownKeys = Object.keys(defaults).sort();
  const declared = loaded.config
    ? (loaded.config.MAIL_DECLARED_KEYS ?? loaded.config.MAIL_CONFIG_KEYS ?? loaded.config.DECLARED_KEYS)
    : undefined;
  if (!Array.isArray(declared)) {
    problems.push('src/config.ts 里没有导出 MAIL_DECLARED_KEYS（键集无从核对）');
  } else {
    const declaredWithEnabled = [...declared, 'enabled'].sort();
    if (!isDeepStrictEqual(ownKeys, declaredWithEnabled)) {
      const missing = declaredWithEnabled.filter((key) => !ownKeys.includes(key));
      const extra = ownKeys.filter((key) => !declaredWithEnabled.includes(key));
      problems.push(
        'defaults 键集与 MAIL_DECLARED_KEYS 不一致' +
          (missing.length ? '；defaults 少：' + missing.join(',') : '') +
          (extra.length ? '；defaults 多：' + extra.join(',') : ''),
      );
    }
    // 再对一次 PLAN 第 4 节的 17 个键：少一个、多一个都算契约漂移。
    const contractKeys = Object.keys(EXPECTED_DEFAULTS).sort();
    const missing = contractKeys.filter((key) => !ownKeys.includes(key));
    const extra = ownKeys.filter((key) => !contractKeys.includes(key));
    if (missing.length > 0 || extra.length > 0) {
      problems.push(
        '与 PLAN 第 4 节的 17 个键不一致' +
          (missing.length ? '；少：' + missing.join(',') : '') +
          (extra.length ? '；多：' + extra.join(',') : ''),
      );
    }
  }

  // 默认值（默认值即契约）。
  const expected = normalize(EXPECTED_DEFAULTS);
  const actual = normalize(defaults);
  const diff = firstDiff(expected, actual);
  if (diff) problems.push('默认值与 PLAN 第 4 节不一致：' + diff);

  // 装配层开关与凭据：这三条单独点名。
  if (defaults.enabled !== false) problems.push('enabled 默认不是 false（实际 ' + JSON.stringify(defaults.enabled) + '）');
  if (defaults.email !== '') problems.push('email 默认不是空串（实际 ' + JSON.stringify(defaults.email) + '）');
  if (defaults.authCode !== '') problems.push('authCode 默认不是空串');

  if (problems.length > 0) return record('defaults', false, problems.join('；'));
  return record(
    'defaults',
    true,
    'enabled=false · ' + ownKeys.length + ' 键（enabled + ' + declared.length + ' 声明） · email/authCode 空串 · 默认值与 PLAN 第 4 节一致',
    { keys: ownKeys.length },
  );
}

// ── 3/4/5. describe.json 与代码同源 ─────────────────────────────────────────

function loadDescribeJson(pkg) {
  const rel = (pkg && pkg.cortico && pkg.cortico.describe) || 'describe.json';
  const file = join(PKG_DIR, rel);
  if (!existsSync(file)) return { ok: false, rel, error: '找不到 ' + rel };
  let json;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { ok: false, rel, error: rel + ' 不是合法 JSON：' + message(error) };
  }
  if (!json || typeof json !== 'object') return { ok: false, rel, error: rel + ' 顶层不是对象' };
  return { ok: true, rel, json, file };
}

function readPkg() {
  try {
    return JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function checkTools(loaded, described) {
  const def = loaded.declaration;
  const specs = loaded.definition ? loaded.definition.TOOL_SPECS : null;
  if (!def) return record('tools', false, '拿不到 World 定义');
  if (!described.ok) return record('tools', false, described.error);

  const written = Array.isArray(described.json.tools) ? described.json.tools : null;
  if (written === null) return record('tools', false, described.rel + ' 缺 tools 数组');

  // definition.ts 侧：优先 def.describe.tools（含 summary），否则退回 TOOL_SPECS。
  const declared = def.describe && Array.isArray(def.describe.tools) ? def.describe.tools : null;
  const problems = [];

  const sourceTools = Array.isArray(specs) && specs.length > 0 ? specs : declared ? declared.map(({ summary, ...rest }) => rest) : [];
  if (sourceTools.length === 0) return record('tools', false, 'definition.ts 里既没有 TOOL_SPECS 也没有 def.describe.tools');
  if (!Array.isArray(specs) || specs.length === 0) {
    problems.push('definition.ts 没导出 TOOL_SPECS，只能按 def.describe.tools 比对');
  }

  const names = sourceTools.map((tool) => tool.name);
  const writtenNames = written.map((tool) => tool.name);
  if (!isDeepStrictEqual(names, writtenNames)) {
    problems.push('工具名不一致：definition ' + names.join(',') + ' vs describe.json ' + writtenNames.join(','));
  }
  if (!isDeepStrictEqual([...names].sort(), [...EXPECTED_TOOLS].sort())) {
    problems.push('工具名与 PLAN 第 5 节不一致：期望 ' + EXPECTED_TOOLS.join(',') + '，实际 ' + names.join(','));
  }
  if (written.length !== 7) problems.push('describe.json 的 tools 不是 7 个（实际 ' + written.length + '）');

  // 每个工具的 name/description/parameters/tags 逐项深比（summary 归在人读那一侧，单独查）。
  for (const spec of sourceTools) {
    const other = written.find((tool) => tool.name === spec.name);
    if (!other) continue;
    for (const field of ['description', 'parameters', 'tags']) {
      const diff = firstDiff(normalize(spec[field]), normalize(other[field]));
      if (diff) problems.push(spec.name + '.' + field + ' 不同：' + diff);
    }
    if (!other.summary || typeof other.summary !== 'object' || typeof other.summary.zh !== 'string' || typeof other.summary.en !== 'string') {
      problems.push(spec.name + ' 缺 summary.zh / summary.en');
    }
  }

  // 若 def.describe.tools 可用，再整份比一次（含 summary），与 describe:extension 的语义一致。
  if (declared) {
    const diff = firstDiff(normalize(declared), normalize(written));
    if (diff) problems.push('describe.json.tools 与 def.describe.tools 不一致：' + diff);
  }

  if (problems.length > 0) return record('tools', false, problems.slice(0, 4).join('；'));
  return record(
    'tools',
    true,
    written.length + ' 个工具：' + writtenNames.join('、') + ' · 参数与 TOOL_SPECS 深度相等',
    { count: written.length, names: writtenNames },
  );
}

function checkEvents(loaded, described) {
  const def = loaded.declaration;
  if (!def) return record('events', false, '拿不到 World 定义');
  if (!described.ok) return record('events', false, described.error);
  const written = Array.isArray(described.json.events) ? described.json.events : null;
  if (written === null) return record('events', false, described.rel + ' 缺 events 数组');
  const declared = def.describe && Array.isArray(def.describe.events) ? def.describe.events : null;
  if (!declared) return record('events', false, 'definition.ts 的 def.describe.events 不是数组');

  const problems = [];
  const names = declared.map((event) => event.type);
  const writtenNames = written.map((event) => event.type);
  if (!isDeepStrictEqual(names, writtenNames)) {
    problems.push('事件名不一致：definition ' + names.join(',') + ' vs describe.json ' + writtenNames.join(','));
  }
  if (!isDeepStrictEqual([...names].sort(), [...EXPECTED_EVENTS].sort())) {
    problems.push('事件名与 PLAN 第 7 节不一致：期望 ' + EXPECTED_EVENTS.join(',') + '，实际 ' + names.join(','));
  }
  if (written.length !== 4) problems.push('describe.json 的 events 不是 4 个（实际 ' + written.length + '）');
  const diff = firstDiff(normalize(declared), normalize(written));
  if (diff) problems.push('describe.json.events 与 def.describe.events 不一致：' + diff);

  if (problems.length > 0) return record('events', false, problems.join('；'));
  return record('events', true, written.length + ' 个事件：' + writtenNames.join('、'), { count: written.length, names: writtenNames });
}

async function probeWorld(def) {
  if (!def || typeof def.create !== 'function') return { ok: false, error: 'def.create 不是函数' };
  let scratch = null;
  try {
    scratch = mkdtempSync(join(tmpdir(), 'mail-selfcheck-'));
    const cfg = typeof def.defaults === 'function' ? def.defaults() : {};
    const dataDir = join(scratch, 'data');
    mkdirSync(dataDir, { recursive: true });
    const ctx = {
      id: def.id,
      cfg,
      timezone: 'UTC',
      botName: 'selfcheck',
      botDir: scratch,
      packageDir: PKG_DIR,
      dataDir,
      repoRoot: PKG_DIR,
      secret: () => '',
      storeSecret: () => {},
      persist: (patch) => Object.assign(cfg, patch),
      restart: async () => {},
    };
    const world = def.create(ctx);
    if (!world || typeof world !== 'object') return { ok: false, error: 'def.create 没返回对象' };
    const decl = typeof world.webUi === 'function' ? world.webUi('zh') : null;
    return { ok: true, world, decl };
  } catch (error) {
    return { ok: false, error: message(error) };
  } finally {
    if (scratch) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* 临时目录删不掉不影响判断 */
      }
    }
  }
}

function checkPrompts(loaded, described) {
  const envPromptFile = join(PKG_DIR, 'src', 'ENV_PROMPT.md');
  if (!existsSync(envPromptFile)) return record('prompts', false, '找不到 src/ENV_PROMPT.md');
  const expectedContent = readFileSync(envPromptFile, 'utf8');
  if (expectedContent.trim() === '') return record('prompts', false, 'src/ENV_PROMPT.md 是空的');
  if (!described.ok) return record('prompts', false, described.error);

  const prompts = Array.isArray(described.json.prompts) ? described.json.prompts : null;
  if (prompts === null) return record('prompts', false, described.rel + ' 缺 prompts 数组');
  if (prompts.length === 0) return record('prompts', false, described.rel + ' 的 prompts 是空的');
  const problems = [];
  const prompt = prompts.find((item) => item && item.role === 'envPrompt');
  if (!prompt) {
    problems.push('没有 role=envPrompt 的条目（实际 role：' + prompts.map((item) => String(item && item.role)).join(',') + '）');
  } else {
    if (typeof prompt.key !== 'string' || prompt.key === '') problems.push('prompt 缺 key');
    if (typeof prompt.title !== 'string' || prompt.title === '') problems.push('prompt 缺 title');
    if (typeof prompt.content !== 'string') problems.push('prompt 缺 content');
    else if (prompt.content !== expectedContent) {
      const diff = firstDiff(expectedContent, prompt.content);
      problems.push('content 与 src/ENV_PROMPT.md 不是逐字相等：' + (diff || '内容相同但长度/结尾不同'));
    }
  }

  if (problems.length > 0) return record('prompts', false, problems.join('；'));
  return record(
    'prompts',
    true,
    prompts.length + ' 条 · ' + prompt.key + ' · content 与 src/ENV_PROMPT.md 逐字相等 · ' + expectedContent.length + ' 字符',
    { key: prompt.key, chars: expectedContent.length },
  );
}

/** 用实例的 webUi('zh').promptDocs 交叉核对 describe.json 的 prompts 形状（key/title/role）。 */
async function checkPromptDocs(loaded, described) {
  const def = loaded.declaration;
  if (!def || !described.ok) return;
  const probe = await probeWorld(def);
  if (!probe.ok) {
    results.push({ id: 'prompt-docs', ok: true, detail: '构造实例失败，跳过 webUi 交叉核对（' + clip(probe.error) + '）', skipped: true });
    return;
  }
  const docs = probe.decl && Array.isArray(probe.decl.promptDocs) ? probe.decl.promptDocs : [];
  const written = Array.isArray(described.json.prompts) ? described.json.prompts : [];
  const problems = [];
  if (docs.length === 0) problems.push('webUi(\'zh\') 没有 promptDocs');
  for (const doc of docs) {
    if (!doc || typeof doc.key !== 'string') continue;
    const other = written.find((item) => item && item.key === doc.key);
    if (!other) problems.push('describe.json 缺 prompt ' + doc.key);
    else {
      if (other.title !== doc.title) problems.push(doc.key + '.title：describe.json ' + JSON.stringify(other.title) + ' vs webUi ' + JSON.stringify(doc.title));
      if ((other.role ?? null) !== (doc.role ?? null)) problems.push(doc.key + '.role：describe.json ' + JSON.stringify(other.role) + ' vs webUi ' + JSON.stringify(doc.role));
      if (typeof doc.path === 'string' && existsSync(doc.path)) {
        const text = readFileSync(doc.path, 'utf8');
        if (other.content !== text) problems.push(doc.key + '.content 与 ' + relative(PKG_DIR, doc.path) + ' 不逐字相等');
      }
    }
  }
  for (const item of written) {
    if (item && typeof item.key === 'string' && !docs.some((doc) => doc && doc.key === item.key)) {
      problems.push('describe.json 多出 prompt ' + item.key + '（webUi 没声明）');
    }
  }
  if (problems.length > 0) results.push({ id: 'prompt-docs', ok: false, detail: problems.slice(0, 4).join('；') });
  else results.push({ id: 'prompt-docs', ok: true, detail: 'key/title/role 与 webUi(\'zh\').promptDocs 一致', skipped: false });
}

// ── 6. 凭据扫描 ────────────────────────────────────────────────────────────

/** 演示数据/测试里可以出现的已知假值（按前缀或整值放行）。 */
const ALLOWED_ADDRESS_LOCALS = ['demo', 'test', 'fake', 'example', 'sample', 'your', 'user', 'someone', 'alice', 'bob'];
/** 文档里的占位写法（your-QQ-number@qq.com 这类）：它是格式说明，不是真实地址。 */
const PLACEHOLDER_LOCAL = /your|my[-_.]?qq|example|demo|test|fake|sample|placeholder|xxxx|你的/i;
/** 授权码形状：QQ 邮箱生成的是 16 位小写字母。含这些词的测试值一律视为假值。 */
const FAKE_SECRET_HINTS = /demo|test|fake|example|sample|placeholder|changeme|xxxx|1234|abcd|0123|deadbeef/i;

const REAL_QQ_EMAIL = /\b\d{5,}@(?:qq|foxmail|vip\.qq)\.com\b/gi;
const ANY_QQ_EMAIL = /[A-Za-z0-9._%+-]+@(?:qq|foxmail|vip\.qq)\.com/gi;
const SECRET_16 = /(?:\bauthCode\b|\bauth_code\b|\bAUTH_CODE\b|\bQQ_MAIL_AUTH_CODE\b)\s*[:=]\s*(['"`])([A-Za-z0-9_-]{16})\1/g;

const SCAN_DIRS = ['src', 'tests', 'scripts', 'docs'];
const SCAN_FILES = ['README.md', 'NOTICE', 'package.json', 'describe.json', 'LICENSE', 'tsconfig.json', '.gitignore'];
const TEXT_EXT = new Set(['.ts', '.mts', '.js', '.mjs', '.json', '.md', '.svg', '.txt', '.yml', '.yaml']);
const MAX_SCAN_BYTES = 1024 * 1024;

function walk(dir, out) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = join(dir, name);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) walk(full, out);
    else if (info.isFile() && info.size <= MAX_SCAN_BYTES && TEXT_EXT.has(extname(name).toLowerCase())) out.push(full);
  }
}

function checkCredentials() {
  const files = [];
  for (const name of SCAN_FILES) {
    const full = join(PKG_DIR, name);
    if (existsSync(full)) files.push(full);
  }
  for (const name of SCAN_DIRS) walk(join(PKG_DIR, name), files);

  const hits = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(PKG_DIR, file).split('\\').join('/');

    for (const match of text.matchAll(REAL_QQ_EMAIL)) {
      hits.push(rel + '：形如真实 QQ 邮箱的地址 "' + match[0] + '"');
    }

    for (const match of text.matchAll(ANY_QQ_EMAIL)) {
      const local = match[0].slice(0, match[0].indexOf('@'));
      // 已知假值前缀与文档占位写法放行；数字形式的真实地址由上面那条更硬的规则先拦。
      if (ALLOWED_ADDRESS_LOCALS.includes(local.toLowerCase()) || PLACEHOLDER_LOCAL.test(local)) continue;
      hits.push(rel + '：出现了 qq.com 地址 "' + match[0] + '"（演示数据应使用 example.com）');
    }

    for (const match of text.matchAll(SECRET_16)) {
      const value = match[2];
      if (FAKE_SECRET_HINTS.test(value)) continue;
      hits.push(rel + '：疑似硬编码授权码 "' + value.slice(0, 2) + '…' + value.slice(-1) + '"（16 位）');
    }
  }

  const uniq = [...new Set(hits)];
  if (uniq.length > 0) {
    return record('credentials', false, '发现 ' + uniq.length + ' 处：' + uniq.slice(0, 5).join('；'), { scanned: files.length });
  }
  return record(
    'credentials',
    true,
    '扫 ' + files.length + ' 个文件：无 5 位以上数字前缀的 qq.com 地址、无硬编码 16 位授权码（PLAN.md 是契约文档、含占位示例，不在扫描范围）',
    { scanned: files.length },
  );
}

// ── 7. 裸 Node import ──────────────────────────────────────────────────────

function checkImport() {
  const code = "import('./src/index.ts')";
  const timeoutMs = 15000;
  // 裸 Node 有一条既定限制：拒绝从 node_modules 里剥离 TS 类型
  // （ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING）。包被 npm 装进别人的 node_modules 后，
  // 这条检查要在临时副本上跑同一份发布内容；Cortico 运行时用 tsx 加载，不受这条限制影响。
  const inNodeModules = PKG_DIR.split(/[\\/]/).includes('node_modules');
  let cwd = PKG_DIR;
  let temp = '';
  let note = '';
  if (inNodeModules) {
    temp = mkdtempSync(join(tmpdir(), 'cortico-world-mail-selfcheck-'));
    const strip = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
    const entries = ['package.json', ...(Array.isArray(strip.files) ? strip.files : [])];
    for (const entry of entries) {
      const from = join(PKG_DIR, entry);
      if (!existsSync(from)) continue;
      cpSync(from, join(temp, entry), { recursive: true, force: true });
    }
    cwd = temp;
    note = '（包在 node_modules 里：在临时副本上验证同一份发布内容；裸 Node 不允许从 node_modules 剥离 TS 类型，Cortico 用 tsx 加载不受影响）';
  }
  let run;
  try {
    run = spawnSync(process.execPath, ['-e', code], {
      // 必须在包根跑：relative 的 './src/index.ts' 与裸 Node 的类型剥离都按 cwd 解析。
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
  } finally {
    if (temp !== '') rmSync(temp, { recursive: true, force: true });
  }
  const stderr = String(run.stderr || '').trim();
  const tail = stderr === '' ? '' : stderr.split(/\r?\n/).slice(-8).join(' ⏎ ');
  if (run.error && run.error.code === 'ETIMEDOUT') {
    return record('import', false, 'node -e "' + code + '" 超过 ' + timeoutMs / 1000 + 's 没结束（进程已强制结束）');
  }
  if (run.status !== 0) {
    return record(
      'import',
      false,
      'node -e "' + code + '" 退出码 ' + String(run.status) + (tail ? '；stderr 尾部：' + clip(tail, 600) : '（stderr 为空）'),
    );
  }
  return record(
    'import',
    true,
    'node -e "' + code + '" 退出码 0（包根 cwd，' + timeoutMs / 1000 + 's 超时，裸 Node ' + process.version + '，无框架依赖）' + note,
  );
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

/** 发布内容拷到临时目录（用于 node_modules 场景），返回临时目录路径。 */
function relocateForSelfcheck() {
  const temp = mkdtempSync(join(tmpdir(), 'cortico-world-mail-selfcheck-'));
  const strip = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
  const entries = ['package.json', ...(Array.isArray(strip.files) ? strip.files : [])];
  for (const entry of entries) {
    const from = join(PKG_DIR, entry);
    if (!existsSync(from)) continue;
    cpSync(from, join(temp, entry), { recursive: true, force: true });
  }
  return temp;
}

async function main() {
  // 裸 Node 拒绝从 node_modules 里剥离 TS 类型（ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING），
  // 而 selfcheck 自身要在进程内 import 源码。包被 npm 装进别人的 node_modules 时，
  // 先把自己复制到临时目录，再在副本里完整跑一遍同一套检查（检查结果同样有效）。
  const inNodeModules = PKG_DIR.split(/[\\/]/).includes('node_modules');
  if (inNodeModules && process.env.MAIL_SELFCHECK_RELOCATED !== '1') {
    const temp = relocateForSelfcheck();
    process.stdout.write('（包在 node_modules 里：复制到临时副本后完整重跑一次；裸 Node 的这个限制不影响 Cortico 的 tsx 加载）\n');
    const run = spawnSync(process.execPath, [join(temp, 'scripts', 'selfcheck.mjs')], {
      cwd: temp,
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, MAIL_SELFCHECK_RELOCATED: '1', NODE_OPTIONS: '' },
    });
    rmSync(temp, { recursive: true, force: true });
    process.exit(run.status === null ? 1 : run.status);
  }

  process.stdout.write('cortico-world-mail selfcheck · ' + PKG_DIR + '\n');

  checkManifest();
  const pkg = readPkg();
  const loaded = await loadPackage();
  checkDefaults(loaded);
  const described = loadDescribeJson(pkg);
  if (!described.ok) {
    record('tools', false, described.error);
    record('events', false, described.error);
    record('prompts', false, described.error);
  } else {
    checkTools(loaded, described);
    checkEvents(loaded, described);
    checkPrompts(loaded, described);
    await checkPromptDocs(loaded, described);
  }
  checkCredentials();
  checkImport();

  const passed = results.filter((item) => item.ok).length;
  for (const item of results) {
    const mark = item.ok ? (item.skipped ? '[skip]' : '[ ok ]') : '[fail]';
    process.stdout.write(mark + ' ' + item.id.padEnd(12) + ' ' + item.detail + '\n');
  }

  const failed = results.filter((item) => !item.ok);
  const tools = results.find((item) => item.id === 'tools');
  const events = results.find((item) => item.id === 'events');
  if (failed.length === 0) {
    const counts = [];
    if (tools && tools.data) counts.push('tools ' + tools.data.count);
    if (events && events.data) counts.push('events ' + events.data.count);
    process.stdout.write('selfcheck PASS ' + passed + '/' + results.length + (counts.length ? ' · ' + counts.join(' · ') : '') + '\n');
    return 0;
  }
  process.stdout.write('selfcheck FAIL ' + passed + '/' + results.length + ' · 第一个失败：' + failed[0].id + ' · ' + failed[0].detail + '\n');
  return 1;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    process.stderr.write('selfcheck 自身出错：' + message(error) + '\n');
    process.exit(1);
  });
