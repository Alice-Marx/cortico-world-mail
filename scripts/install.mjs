#!/usr/bin/env node
/**
 * cortico-world-mail · 安装脚本（零依赖，普通 node 就能跑）
 *
 * 做什么（顺序固定，每步失败都回滚到装之前）：
 *   1. 找到 Coopanion 部署（--data / CORTICO_COMPANION_DATA / 注册表与常见路径探测）
 *   2. 预检本包形状（manifest / 入口 / describe / 图标），不合格就一个文件都不动
 *   3. 把本包放进 <data>/extensions/node_modules/cortico-world-mail（默认 Windows junction 软链，
 *      改源码只需重启；--copy 改成复制一份）
 *   4. 往 <data>/extensions/package.json 的 dependencies 写一行 file: 指向本包
 *   5. 备份 <data>/home/<bot>/config.json，然后打开 worlds.mail：段不存在就按包里 defaults()
 *      写全（mode 默认 demo，不联网），已存在就只补缺键、把 enabled 设 true，不覆盖用户改过的值
 *   6. 逐项校验（软链、依赖行、config 段、describe、图标、裸 node import 一次入口）
 *
 * 退出码：0 成功 / 1 校验失败已回滚 / 2 用法或前置条件不满足（什么都没动）。
 *
 * 用法：
 *   node scripts/install.mjs [--data <部署根>] [--config <config.json>] [--copy] [--dry-run]
 *                            [--no-enable] [--keep-on-fail] [--restart]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

/** 本包目录（scripts/ 的上一级）。 */
export const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/** 指定部署根的另一个入口（与 --data 等价，--data 优先）。 */
export const DATA_ENV = 'CORTICO_COMPANION_DATA';
/** 部署配置的覆盖入口（config.json 不在 <data>/home/<bot>/ 时用）。 */
export const CONFIG_ENV = 'CORTICO_COMPANION_CONFIG';
/** 备份文件后缀：bak-mail-<时间戳>。 */
export const BACKUP_TAG = 'bak-mail';

const out = (line = '') => process.stdout.write(line + '\n');
const ok = (label, detail = '') => out('  [ok] ' + label + (detail ? '  ' + detail : ''));
const bad = (label, detail = '') => out('  [!!] ' + label + (detail ? '  ' + detail : ''));
const info = (label, detail = '') => out('  [--] ' + label + (detail ? '  ' + detail : ''));

export function die(message, code = 2) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

// ── 文件小工具 ───────────────────────────────────────────────────────────────

export function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 原子写：同目录临时文件 + rename（Windows 上 rename 覆盖已有文件是原子的）。 */
export function writeTextAtomic(file, text) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

export const manifestText = (obj) => JSON.stringify(obj, null, 2) + '\n';

export function timestamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    date.getFullYear() +
    p(date.getMonth() + 1) +
    p(date.getDate()) +
    '-' +
    p(date.getHours()) +
    p(date.getMinutes()) +
    p(date.getSeconds())
  );
}

/** file: 协议里的路径：正斜杠，Windows 盘符不带多余前缀。 */
export function fileSpec(pkgDir) {
  return 'file:' + path.resolve(pkgDir).split(path.sep).join('/');
}

// ── 部署探测 ─────────────────────────────────────────────────────────────────

/** 把用户给的路径认成部署根或 data 目录，返回全部落点。 */
export function resolveLayout(raw, source = '--data') {
  const given = String(raw ?? '').trim();
  if (given === '') throw new Error('resolveLayout 需要一个路径');
  const base = path.resolve(given);
  let root;
  let dataDir;
  let how;
  if (fs.existsSync(path.join(base, 'data', 'extensions'))) {
    root = base;
    dataDir = path.join(base, 'data');
    how = '部署根';
  } else if (fs.existsSync(path.join(base, 'extensions'))) {
    dataDir = base;
    root = path.dirname(base);
    how = 'data 目录';
  } else if (path.basename(base).toLowerCase() === 'data') {
    dataDir = base;
    root = path.dirname(base);
    how = 'data 目录';
  } else {
    root = base;
    dataDir = path.join(base, 'data');
    how = '部署根';
  }
  const extensionsDir = path.join(dataDir, 'extensions');
  return {
    root,
    dataDir,
    extensionsDir,
    packageJson: path.join(extensionsDir, 'package.json'),
    nodeModules: path.join(extensionsDir, 'node_modules'),
    logsDir: path.join(dataDir, 'logs'),
    coreLog: path.join(dataDir, 'logs', 'core.log'),
    restartFlag: path.join(dataDir, '.restart-request'),
    how,
    source,
    given,
    found: true,
    exists: fs.existsSync(extensionsDir),
  };
}

/**
 * 从 Windows 卸载注册表里找 Coopanion 的 InstallLocation。
 * 探测失败（没有 PowerShell、没有条目、超时）一律返回空串，不抛。
 */
function registryInstallLocations() {
  if (process.platform !== 'win32') return [];
  const script =
    "$ErrorActionPreference='SilentlyContinue';" +
    "$roots=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');" +
    "Get-ItemProperty $roots | Where-Object { $_.DisplayName -like 'Coopanion*' } | " +
    "ForEach-Object { $_.InstallLocation }";
  try {
    const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');
  } catch {
    return [];
  }
}

/** 按顺序探测部署位置；命中第一条即停。纯探测，不写任何东西。 */
export function deploymentCandidates(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pkgDir = options.pkgDir ?? PKG_DIR;
  const list = [];
  const seen = new Set();
  const push = (how, value) => {
    const given = String(value ?? '').trim();
    if (given === '') return;
    const abs = path.resolve(given);
    const key = platform === 'win32' ? abs.toLowerCase() : abs;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ how, path: abs });
  };
  for (const location of registryInstallLocations()) {
    push('注册表 InstallLocation', location);
  }
  const localAppData = String(env.LOCALAPPDATA ?? '').trim();
  if (localAppData !== '') push('%LOCALAPPDATA%\\Programs\\Coopanion', path.join(localAppData, 'Programs', 'Coopanion'));
  const programFiles = String(env.ProgramFiles ?? env.PROGRAMFILES ?? '').trim();
  if (programFiles !== '') push('%ProgramFiles%\\Coopanion', path.join(programFiles, 'Coopanion'));
  const programFilesX86 = String(env['ProgramFiles(x86)'] ?? env['PROGRAMFILES(X86)'] ?? '').trim();
  if (programFilesX86 !== '') push('%ProgramFiles(x86)%\\Coopanion', path.join(programFilesX86, 'Coopanion'));
  const home = String(env.USERPROFILE ?? os.homedir());
  push('用户目录 ~/Programs/Coopanion', path.join(home, 'Programs', 'Coopanion'));
  const drive = /^([A-Za-z]:)[\\/]/.exec(pkgDir);
  if (platform === 'win32' && drive) push('便携版：脚本盘符 ' + drive[1] + '\\Coopanion', drive[1] + '\\Coopanion');
  else push('便携版：家目录 ~/Coopanion', path.join(home, 'Coopanion'));
  return list;
}

export function probeDeployment(options = {}) {
  const candidates = options.candidates ?? deploymentCandidates(options);
  const tried = candidates.map((candidate) => ({
    ...candidate,
    hit:
      fs.existsSync(path.join(candidate.path, 'data', 'extensions')) ||
      fs.existsSync(path.join(candidate.path, 'extensions')),
  }));
  return { hit: tried.find((item) => item.hit) ?? null, tried };
}

/** --data > CORTICO_COMPANION_DATA > 按顺序探测。都找不到返回 { found:false, probe }。 */
export function pickLayout(opts = {}, env = process.env) {
  const fromArg = typeof opts.data === 'string' ? opts.data.trim() : '';
  if (fromArg !== '') {
    const layout = resolveLayout(fromArg, '--data');
    layout.probe = { source: '--data', tried: [{ how: '--data', path: layout.root || path.resolve(fromArg), hit: true }] };
    return layout;
  }
  const fromEnv = String(env[DATA_ENV] ?? '').trim();
  if (fromEnv !== '') {
    const layout = resolveLayout(fromEnv, 'env');
    layout.probe = { source: 'env', tried: [{ how: DATA_ENV, path: layout.root || path.resolve(fromEnv), hit: true }] };
    return layout;
  }
  const { hit, tried } = probeDeployment({ env });
  if (hit) {
    const layout = resolveLayout(hit.path, 'probe');
    const index = tried.indexOf(hit) + 1;
    layout.probe = { source: 'probe', tried, index };
    return layout;
  }
  return {
    root: '',
    dataDir: '',
    extensionsDir: '',
    packageJson: '',
    nodeModules: '',
    logsDir: '',
    coreLog: '',
    restartFlag: '',
    how: '未找到',
    source: 'probe',
    given: '',
    found: false,
    exists: false,
    probe: { source: 'probe', tried },
  };
}

export function missingDeploymentLines(layout) {
  const lines = [
    '没找到 Coopanion 安装目录：请用 --data <部署根> 指定，或设环境变量 ' + DATA_ENV + '。',
    '部署根 = 里面有 data\\extensions 的那一层（Windows 默认 %LOCALAPPDATA%\\Programs\\Coopanion）。',
    '按这个顺序找过：',
  ];
  for (const [index, item] of (layout.probe?.tried ?? []).entries()) {
    lines.push('  ' + (index + 1) + '. ' + item.how + '  →  ' + item.path + (item.hit ? '   [命中]' : '   [没有]'));
  }
  lines.push('一条都没命中。这只说明探测不到，不代表没装；把 Coopanion.exe 所在目录用 --data 指过来即可。');
  return lines;
}

// ── 包预检 ───────────────────────────────────────────────────────────────────

/** 按框架的层次取入口：exports → module → main → index.js。 */
export function resolveEntry(pkgDir, pkg) {
  const candidates = [];
  const exportsField = pkg.exports;
  if (typeof exportsField === 'string') candidates.push(exportsField);
  else if (exportsField && typeof exportsField === 'object') {
    const root = exportsField['.'] ?? exportsField;
    if (typeof root === 'string') candidates.push(root);
    else if (root && typeof root === 'object') {
      for (const key of ['import', 'default', 'node']) if (typeof root[key] === 'string') candidates.push(root[key]);
    }
  }
  if (typeof pkg.module === 'string') candidates.push(pkg.module);
  if (typeof pkg.main === 'string') candidates.push(pkg.main);
  candidates.push('index.js');
  for (const candidate of candidates) {
    const file = path.join(pkgDir, candidate);
    if (fs.existsSync(file)) return file;
  }
  return path.join(pkgDir, candidates[0] ?? 'index.js');
}

/** 本包预检：形状不对就别动部署。返回 { problems, pkg, entry }。 */
export function preflightPackage(pkgDir = PKG_DIR) {
  const problems = [];
  const pkgFile = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgFile)) return { problems: ['包目录里没有 package.json：' + pkgFile], pkg: null, entry: '' };
  let pkg;
  try {
    pkg = readJsonFile(pkgFile);
  } catch (error) {
    return { problems: ['package.json 不是合法 JSON：' + String(error.message ?? error)], pkg: null, entry: '' };
  }
  if (pkg.type !== 'module') problems.push('package.json 的 type 必须是 "module"');
  const cortico = pkg.cortico;
  if (!cortico || typeof cortico !== 'object') problems.push('package.json 缺 cortico 段');
  else {
    if (cortico.kind !== 'world') problems.push('cortico.kind 必须是 "world"，现在是 ' + String(cortico.kind));
    if (cortico.api !== 6) problems.push('cortico.api 必须是 6（world 契约版本），现在是 ' + String(cortico.api));
    if (typeof cortico.icon === 'string' && cortico.icon !== '' && !fs.existsSync(path.join(pkgDir, cortico.icon))) {
      problems.push('cortico.icon 指向的文件不在：' + cortico.icon);
    }
    const describeRel = typeof cortico.describe === 'string' && cortico.describe !== '' ? cortico.describe : 'describe.json';
    const describeFile = path.join(pkgDir, describeRel);
    if (!fs.existsSync(describeFile)) problems.push('describe 文件不在：' + describeRel);
    else {
      try {
        JSON.parse(fs.readFileSync(describeFile, 'utf8'));
      } catch (error) {
        problems.push('describe 文件不是合法 JSON：' + describeRel);
      }
    }
  }
  const entry = resolveEntry(pkgDir, pkg);
  if (!fs.existsSync(entry)) problems.push('入口文件不在：' + path.relative(pkgDir, entry));
  return { problems, pkg, entry };
}

// ── world 身份（id 与默认配置以包里的 defaults() 为唯一真相） ──────────────────

/** 导入包入口拿 id/defaults()；失败时用本包的兜底表（与 src/config.ts 保持一致）。 */
export async function worldIdentity() {
  const fallback = {
    id: 'mail',
    defaults: {
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
    },
  };
  try {
    const mod = await import(pathToFileURL(path.join(PKG_DIR, 'src', 'index.ts')).href);
    const def = mod.default;
    if (def && typeof def.id === 'string' && def.id !== '' && typeof def.defaults === 'function') {
      return { id: def.id, defaults: { ...def.defaults() }, fromCode: true };
    }
    return { ...fallback, fromCode: false, why: '默认导出不是 WorldDefinition' };
  } catch (error) {
    return { ...fallback, fromCode: false, why: String(error && error.message ? error.message : error) };
  }
}

// ── node_modules 落位 ────────────────────────────────────────────────────────

/** 只看不跟：软链/真目录/不存在。 */
export function inspectInstalled(dir) {
  if (!fs.existsSync(dir)) return { kind: 'absent' };
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink()) return { kind: 'link', target: fs.realpathSync(dir) };
  if (stat.isDirectory()) return { kind: 'dir' };
  return { kind: 'other' };
}

function removeMaybeLink(dir) {
  const info = inspectInstalled(dir);
  if (info.kind === 'absent') return;
  if (info.kind === 'link') {
    try {
      fs.unlinkSync(dir);
    } catch {
      fs.rmdirSync(dir);
    }
    return;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 复制模式要带的东西：package.json + 清单 files 里列的每一项。 */
function copyEntries(pkg) {
  const entries = ['package.json'];
  for (const item of Array.isArray(pkg.files) ? pkg.files : []) entries.push(item);
  return entries;
}

function copyTree(src, dest) {
  fs.cpSync(src, dest, { recursive: true, force: true });
}

/** 把包放进 node_modules/<name>；返回 { action, parked, notes }。 */
export function placePackage(pkgDir, dest, mode) {
  const notes = [];
  const existing = inspectInstalled(dest);
  let parked = null;
  const target = path.resolve(pkgDir);
  if (existing.kind === 'link' && path.resolve(existing.target ?? '') === target) {
    return { action: 'reuse', parked: null, notes: ['node_modules 里已经有指向本目录的软链，直接复用'] };
  }
  if (existing.kind !== 'absent') {
    parked = dest + '.parked-' + timestamp();
    fs.renameSync(dest, parked);
    notes.push('已把原有的 node_modules/' + path.basename(dest) + ' 挪到 ' + path.basename(parked) + '（失败会挪回来）');
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (mode === 'copy') {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of copyEntries(readJsonFile(path.join(pkgDir, 'package.json')))) {
      const from = path.join(pkgDir, entry);
      if (!fs.existsSync(from)) continue;
      copyTree(from, path.join(dest, entry));
    }
    return { action: 'copy', parked, notes };
  }
  try {
    fs.symlinkSync(target, dest, 'junction');
    return { action: 'link', parked, notes };
  } catch (error) {
    notes.push('建软链失败（' + String(error.message ?? error) + '），改成复制一份');
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of copyEntries(readJsonFile(path.join(pkgDir, 'package.json')))) {
      const from = path.join(pkgDir, entry);
      if (!fs.existsSync(from)) continue;
      copyTree(from, path.join(dest, entry));
    }
    return { action: 'copy', parked, notes };
  }
}

// ── 部署配置：worlds.<id> ────────────────────────────────────────────────────

/** 找部署配置 config.json：--config > CORTICO_COMPANION_CONFIG > <data>/home/<bot>/config.json。 */
export function resolveBotConfig(layout, explicit, env = process.env) {
  const fromArg = String(explicit ?? '').trim();
  if (fromArg !== '') return { file: path.resolve(fromArg), how: '--config', candidates: [] };
  const fromEnv = String(env[CONFIG_ENV] ?? '').trim();
  if (fromEnv !== '') return { file: path.resolve(fromEnv), how: CONFIG_ENV, candidates: [] };
  const home = path.join(layout.dataDir, 'home');
  if (!fs.existsSync(home)) return null;
  let candidates = [];
  try {
    candidates = fs.readdirSync(home).filter((entry) => fs.existsSync(path.join(home, entry, 'config.json')));
  } catch {
    return null;
  }
  if (candidates.length === 1) return { file: path.join(home, candidates[0], 'config.json'), how: 'home/' + candidates[0], candidates };
  if (candidates.includes('companion')) return { file: path.join(home, 'companion', 'config.json'), how: 'home/companion', candidates };
  return { file: null, how: 'ambiguous', candidates };
}

/**
 * 打开 worlds.<id>：
 * - 段不存在：写 {...defaults, enabled:true}（mode 取包里的默认值，本包是 demo）
 * - 段已存在：只补缺键 + 把 enabled 设 true；用户改过的值一律不覆盖
 * 返回 { added, changed, untouched, replaced }。
 */
export function enableWorldSection(configFile, options) {
  const { worldId, defaults } = options;
  const manifest = readJsonFile(configFile);
  if (!manifest.worlds || typeof manifest.worlds !== 'object' || Array.isArray(manifest.worlds)) manifest.worlds = {};
  const worlds = manifest.worlds;
  const wanted = { ...defaults };
  const added = [];
  const changed = [];
  let replaced = false;
  const current = worlds[worldId];
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    for (const [key, value] of Object.entries(wanted)) {
      if (key === 'enabled' || current[key] !== undefined) continue;
      current[key] = value;
      added.push(key);
    }
    if (current.enabled !== true) {
      const had = current.enabled !== undefined;
      current.enabled = true;
      (had ? changed : added).push('enabled');
    }
  } else {
    if (current !== undefined) replaced = true;
    worlds[worldId] = { ...wanted, enabled: true };
    added.push(...Object.keys(worlds[worldId]));
  }
  if (added.length === 0 && changed.length === 0 && !replaced) return { added, changed, untouched: true, replaced };
  writeTextAtomic(configFile, manifestText(manifest));
  return { added: added.sort(), changed: changed.sort(), untouched: false, replaced };
}

/** 从 config.json 里删掉 worlds.<id>；别的段不动。 */
export function disableWorldSection(configFile, worldId) {
  const manifest = readJsonFile(configFile);
  const worlds = manifest.worlds;
  if (!worlds || typeof worlds !== 'object' || Array.isArray(worlds) || worlds[worldId] === undefined) return false;
  delete worlds[worldId];
  writeTextAtomic(configFile, manifestText(manifest));
  return true;
}

export function worldEnabled(configFile, worldId) {
  const manifest = readJsonFile(configFile);
  const section = manifest.worlds && manifest.worlds[worldId];
  return Boolean(section && typeof section === 'object' && section.enabled === true);
}

export function backupFile(file, label = path.basename(file)) {
  const backup = file + '.' + BACKUP_TAG + '-' + timestamp();
  fs.copyFileSync(file, backup);
  return backup;
}

/** 在装好的目录里用裸 node import 一次入口，证明「装上去能被加载」。 */
function smokeImport(entry, cwd) {
  const result = spawnSync(process.execPath, ['-e', "import(" + JSON.stringify(pathToFileURL(entry).href) + ").then(()=>process.exit(0),()=>process.exit(1))"], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
  return { ok: result.status === 0, status: result.status, stderr: String(result.stderr ?? '').slice(-800) };
}

// ── 参数与主流程 ─────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const flags = new Set();
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] ?? '');
    if (!arg.startsWith('--')) continue;
    const equal = arg.indexOf('=');
    if (equal !== -1) {
      opts[arg.slice(2, equal)] = arg.slice(equal + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !String(next).startsWith('--')) {
      opts[key] = String(next);
      i++;
    } else {
      flags.add(key);
    }
  }
  return { flags, opts };
}

function usage() {
  out('用法：node scripts/install.mjs [选项]');
  out('');
  out('  --data <路径>      部署根（含 data\\extensions 的那一层）或 data 目录本身');
  out('                     ' + DATA_ENV + ' 环境变量同义；--data 优先');
  out('  --copy             复制一份进 node_modules（默认 Windows junction 软链，改源码重启即可）');
  out('  --dry-run          只打印计划，不动任何文件');
  out('  --no-enable        只装包，不开 config.json 里的 worlds.mail（重启后不会挂载）');
  out('  --config <文件>    部署配置 config.json 的位置（默认 <data>\\home\\<bot>\\config.json）');
  out('  --keep-on-fail     校验失败时不自动回滚（默认回滚）');
  out('  --restart          装完写 ' + '<data>\\.restart-request' + '，重启 Coopanion 后生效（默认只打印提示）');
  out('  -h, --help         这一屏');
  out('');
  out('装完必须重启 Coopanion（控制台 → 重启，或写 data\\.restart-request）才会挂载新 World。');
}

async function main(argv) {
  const { flags, opts } = parseArgv(argv);
  if (flags.has('help') || flags.has('h')) {
    usage();
    return;
  }
  const dryRun = flags.has('dry-run');
  const mode = flags.has('copy') ? 'copy' : 'link';
  const layout = pickLayout(opts);
  if (!layout.found) {
    for (const line of missingDeploymentLines(layout)) process.stderr.write(line + '\n');
    process.exit(2);
  }
  const ident = await worldIdentity();
  const enable = !flags.has('no-enable');
  const configTarget = enable ? resolveBotConfig(layout, opts.config) : null;

  out('cortico-world-mail → 扩展目录');
  out('');
  info('部署根   ' + layout.root + (layout.probe.source === 'probe' ? '（探测命中）' : '（来自 ' + layout.probe.source + '）'));
  info('扩展目录 ' + layout.extensionsDir);
  info('包目录   ' + PKG_DIR);
  info('装法     ' + (mode === 'copy' ? '复制' : '软链') + (dryRun ? '（dry-run：不会写任何文件）' : ''));
  info('世界 id  ' + ident.id + (ident.fromCode ? '（取自包的 defaults()）' : '（包导入不了，用兜底默认值）' + (ident.why ? '：' + ident.why : '')));
  info('部署配置 ' + (enable ? (configTarget && configTarget.file ? configTarget.file : '找不到') : '按 --no-enable 跳过'));
  out('');

  if (!fs.existsSync(layout.extensionsDir)) die('找不到扩展目录 ' + layout.extensionsDir + '（--data 指的路径里没有 data\\extensions）。');
  if (!fs.existsSync(layout.packageJson) && !dryRun) die('扩展目录里没有 package.json：' + layout.packageJson + '。这个目录不是 Coopanion 的 data\\extensions？');
  if (enable && (!configTarget || !configTarget.file)) {
    const seen = configTarget && configTarget.candidates.length > 0 ? '看到这些：' + configTarget.candidates.join(', ') : '没看到任何 <data>\\home\\*\\config.json';
    die('找不到部署配置 config.json（' + seen + '）。用 --config 指过去，或者加 --no-enable 只装包。');
  }
  if (enable && !fs.existsSync(configTarget.file)) die('部署配置不存在：' + configTarget.file);

  const pre = preflightPackage(PKG_DIR);
  if (pre.problems.length > 0) {
    out('预检：包形状不对，一个文件都没动');
    for (const problem of pre.problems) bad(problem);
    process.exit(1);
  }
  const pkg = pre.pkg;
  const name = pkg.name;
  const localVersion = pkg.version;
  const entryRel = path.relative(PKG_DIR, pre.entry).split(path.sep).join('/');
  const dest = path.join(layout.nodeModules, ...String(name).split('/'));
  const spec = fileSpec(PKG_DIR);
  ok('包形状', name + '@' + localVersion + ' · 入口 ' + entryRel + ' · cortico.kind=world api=6');

  if (dryRun) {
    out('');
    out('dry-run 计划：');
    info('备份    ' + layout.packageJson + ' → package.json.' + BACKUP_TAG + '-<时间戳>');
    info('装法    ' + dest + ' → ' + (mode === 'copy' ? '复制 ' + PKG_DIR : '软链 ' + PKG_DIR));
    info('依赖行  "dependencies"."' + name + '" = "' + spec + '"');
    if (enable) info('部署配置 ' + configTarget.file + ' → 备份后写 worlds.' + ident.id + '（enabled=true，mode=' + String(ident.defaults.mode ?? 'demo') + '，缺失的键按默认值补）');
    if (flags.has('restart')) info('重启    ' + layout.restartFlag);
    out('');
    return;
  }

  const state = { backup: null, action: null, parked: null, configFile: null, configBackup: null, depWritten: false };
  const rollback = () => {
    try {
      if (state.parked) {
        removeMaybeLink(dest);
        fs.renameSync(state.parked, dest);
        state.parked = null;
      } else if (state.action) {
        removeMaybeLink(dest);
      }
      if (state.backup) fs.copyFileSync(state.backup, layout.packageJson);
      if (state.configBackup && state.configFile) fs.copyFileSync(state.configBackup, state.configFile);
    } catch (error) {
      bad('回滚时又出错', String(error && error.message ? error.message : error));
      info('手动还原：copy "' + state.backup + '" "' + layout.packageJson + '"');
      if (state.configBackup) info('手动还原：copy "' + state.configBackup + '" "' + state.configFile + '"');
    }
  };

  // 1. 备份 package.json
  let backup;
  try {
    backup = backupFile(layout.packageJson, 'package.json');
  } catch (error) {
    die('备份 package.json 失败（没继续装）：' + String(error && error.message ? error.message : error));
  }
  state.backup = backup;
  ok('备份 package.json', path.basename(backup) + '（' + fs.statSync(backup).size + ' B）');

  // 2. 放进 node_modules
  try {
    fs.mkdirSync(layout.nodeModules, { recursive: true });
    const placed = placePackage(PKG_DIR, dest, mode);
    state.action = placed.action;
    state.parked = placed.parked ?? null;
    for (const note of placed.notes) info(note);
    ok('node_modules/' + name, placed.action === 'reuse' ? '复用已有软链 → ' + PKG_DIR : placed.action === 'copy' ? '复制 → ' + dest : '软链（junction）→ ' + PKG_DIR);
  } catch (error) {
    bad('装进 node_modules 失败', String(error && error.message ? error.message : error));
    rollback();
    die('已回滚：package.json 还原自 ' + path.basename(state.backup), 1);
  }

  // 3. 依赖行
  try {
    const original = fs.readFileSync(layout.packageJson, 'utf8');
    const manifest = JSON.parse(original);
    const canonical = manifestText(manifest);
    if (canonical !== original) info('原 package.json 格式不标准（重写后会规范化）；原文在 ' + path.basename(backup));
    manifest.dependencies = { ...(manifest.dependencies ?? {}), [name]: spec };
    writeTextAtomic(layout.packageJson, manifestText(manifest));
    state.depWritten = true;
    ok('依赖行', '"' + name + '": "' + spec + '"');
  } catch (error) {
    bad('写依赖行失败', String(error && error.message ? error.message : error));
    rollback();
    die('已回滚：package.json 还原自 ' + path.basename(state.backup), 1);
  }

  // 4. 部署配置
  if (enable) {
    state.configFile = configTarget.file;
    try {
      state.configBackup = backupFile(state.configFile, 'config.json');
      const result = enableWorldSection(state.configFile, { worldId: ident.id, defaults: ident.defaults });
      if (result.untouched) {
        ok('部署配置', path.basename(state.configFile) + ' 里 worlds.' + ident.id + ' 已是 enabled=true 且不缺键，没改它');
      } else {
        const parts = [];
        if (result.added.length > 0) parts.push('新增 ' + result.added.join(','));
        if (result.changed.length > 0) parts.push('改 ' + result.changed.join(','));
        if (result.replaced) parts.push('原段不是对象，按默认段重写');
        ok('部署配置', '备份 ' + path.basename(state.configBackup) + ' · worlds.' + ident.id + '：' + parts.join('；'));
        info('模式', 'mode=' + String(ident.defaults.mode ?? 'demo') + '（demo 不联网、不需要凭据；要接真邮箱改成 live 并填 email/authCode）');
      }
    } catch (error) {
      bad('写部署配置失败', String(error && error.message ? error.message : error));
      rollback();
      die('已回滚：package.json 与 config.json 都还原了，node_modules/' + name + ' 已清掉。', 1);
    }
  } else {
    info('部署配置', '按 --no-enable 跳过：重启后框架不会挂载 worlds.' + ident.id);
  }

  // 5. 逐项校验
  out('');
  out('逐项校验：');
  const checks = [];
  const check = (label, pass, detail = '') => {
    checks.push(pass);
    if (pass) ok(label, detail);
    else bad(label, detail);
  };
  const installed = inspectInstalled(dest);
  check('node_modules/' + name + ' 在位', installed.kind !== 'absent', installed.kind === 'link' ? '软链 → ' + (installed.target ?? '?') : installed.kind);
  let installedPkg = null;
  try {
    installedPkg = readJsonFile(path.join(dest, 'package.json'));
    check('装好的 package.json 可解析', true, installedPkg.name + '@' + installedPkg.version);
  } catch (error) {
    check('装好的 package.json 可解析', false, String(error && error.message ? error.message : error));
  }
  check('版本与本目录一致', Boolean(installedPkg) && installedPkg.version === localVersion, localVersion);
  const installedEntry = installedPkg ? resolveEntry(dest, installedPkg) : path.join(dest, entryRel);
  check('入口文件在装好的副本里', fs.existsSync(installedEntry), entryRel);
  const describeRel = String((pkg.cortico && pkg.cortico.describe) || 'describe.json');
  let describeOk = false;
  try {
    JSON.parse(fs.readFileSync(path.join(dest, describeRel), 'utf8'));
    describeOk = true;
  } catch {
    describeOk = false;
  }
  check('describe.json 在装好的副本里且能解析', describeOk, describeRel);
  const iconRel = pkg.cortico && pkg.cortico.icon ? String(pkg.cortico.icon) : '';
  check('图标在装好的副本里', iconRel === '' || fs.existsSync(path.join(dest, iconRel)), iconRel || '(未声明)');
  let depOk = false;
  let depDetail = '';
  try {
    const manifest = readJsonFile(layout.packageJson);
    const got = manifest.dependencies && manifest.dependencies[name];
    depOk = got === spec;
    depDetail = got === undefined ? '依赖表里没有这一行' : '"' + got + '"';
  } catch (error) {
    depDetail = 'package.json 读不回来：' + String(error && error.message ? error.message : error);
  }
  check('data/extensions/package.json 里有这一行且指向本目录', depOk, depDetail);
  let enabledOk = true;
  let enabledDetail = '按 --no-enable 跳过';
  if (enable && state.configFile) {
    try {
      enabledOk = worldEnabled(state.configFile, ident.id);
      enabledDetail = enabledOk ? 'worlds.' + ident.id + '.enabled = true' : 'worlds.' + ident.id + '.enabled 不是 true';
    } catch (error) {
      enabledOk = false;
      enabledDetail = 'config.json 读不回来：' + String(error && error.message ? error.message : error);
    }
  }
  check('config.json 里 worlds.' + ident.id + '.enabled 是 true', enabledOk, enabledDetail);
  const smoke = smokeImport(installedEntry, layout.extensionsDir);
  check('裸 node 能 import 装好的入口', smoke.ok, smoke.ok ? path.relative(layout.root, installedEntry) : smoke.stderr.split(/\r?\n/).slice(-3).join(' / '));

  const failed = checks.filter((pass) => !pass).length;
  out('');
  if (failed > 0 && !flags.has('keep-on-fail')) {
    bad('有 ' + failed + ' 项没通过，回滚');
    rollback();
    die('已回滚到装之前的状态。', 1);
  }
  if (failed > 0) {
    bad('有 ' + failed + ' 项没通过（--keep-on-fail：保留现场）');
    process.exit(1);
  }

  // 6. 重启提示
  out('');
  if (flags.has('restart')) {
    try {
      writeTextAtomic(layout.restartFlag, timestamp() + '\n');
      ok('重启请求', '已写 ' + layout.restartFlag + '（Coopanion 会自己重启 Core）');
    } catch (error) {
      bad('写重启请求失败', String(error && error.message ? error.message : error));
      info('手动重启：控制台 → 重启');
    }
  } else {
    out('下一步：重启 Coopanion 后生效（控制台 → 重启；或再跑一次加 --restart 写 ' + layout.restartFlag + '）。');
  }
  out('');
  out('装好了：' + name + '@' + localVersion + ' → worlds.' + ident.id + '（mode=' + String(ident.defaults.mode ?? 'demo') + '）');
  out('日志：' + layout.coreLog);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
