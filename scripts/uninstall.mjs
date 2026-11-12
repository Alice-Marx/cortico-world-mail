#!/usr/bin/env node
/**
 * cortico-world-mail · 卸载脚本（零依赖）
 *
 * 做什么（顺序固定；每步都先备份）：
 *   1. 找到部署与 config.json（与 install.mjs 同一套探测）
 *   2. 从 <data>/extensions/package.json 的 dependencies 里删掉本包那一行
 *   3. 删掉 <data>/extensions/node_modules/cortico-world-mail
 *      （只删「指向本包的软链」或「package.json 里 name 就是本包的目录」，别的东西一律不碰）
 *   4. 从 config.json 里删掉 worlds.mail（备份在 config.json.bak-mail-<时间戳>）
 *   5. 校验：依赖行没了、node_modules 里没了、config 段没了
 *
 * 不删：知识库（<data>/home/<bot>/data/mail/）、日志、本包源码目录。
 *
 * 退出码：0 成功 / 1 校验失败 / 2 用法或前置条件不满足。
 *
 * 用法：
 *   node scripts/uninstall.mjs [--data <部署根>] [--config <config.json>] [--dry-run] [--restart]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKUP_TAG,
  CONFIG_ENV,
  DATA_ENV,
  PKG_DIR,
  backupFile,
  die,
  disableWorldSection,
  inspectInstalled,
  manifestText,
  missingDeploymentLines,
  pickLayout,
  readJsonFile,
  resolveBotConfig,
  timestamp,
  worldIdentity,
  worldEnabled,
  writeTextAtomic,
} from './install.mjs';

const out = (line = '') => process.stdout.write(line + '\n');
const ok = (label, detail = '') => out('  [ok] ' + label + (detail ? '  ' + detail : ''));
const bad = (label, detail = '') => out('  [!!] ' + label + (detail ? '  ' + detail : ''));
const info = (label, detail = '') => out('  [--] ' + label + (detail ? '  ' + detail : ''));

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
  return { found: true, flags, opts };
}

function usage() {
  out('用法：node scripts/uninstall.mjs [选项]');
  out('');
  out('  --data <路径>      部署根（含 data\\extensions 的那一层）或 data 目录本身');
  out('                     ' + DATA_ENV + ' 环境变量同义；--data 优先');
  out('  --config <文件>    部署配置 config.json 的位置（默认 <data>\\home\\<bot>\\config.json）');
  out('  --dry-run          只打印计划，不动任何文件');
  out('  --restart          写完 ' + '<data>\\.restart-request' + '，重启 Coopanion 后生效（默认只打印提示）');
  out('  -h, --help         这一屏');
  out('');
  out('不删知识库与日志；只撤销「扩展注册 + worlds.mail 配置段」。');
}

/** 只删确实是本包的那一份：软链，或 package.json 里 name 匹配的真目录。 */
function removeOurPackage(dest, expectedName) {
  const info = inspectInstalled(dest);
  if (info.kind === 'absent') return { removed: false, kind: 'absent' };
  if (info.kind === 'link') {
    try {
      fs.unlinkSync(dest);
    } catch {
      fs.rmdirSync(dest);
    }
    return { removed: true, kind: 'link', target: info.target };
  }
  if (info.kind === 'dir') {
    let name = '';
    try {
      name = String(readJsonFile(path.join(dest, 'package.json')).name ?? '');
    } catch {
      name = '';
    }
    if (name !== expectedName) {
      return { removed: false, kind: 'dir', reason: '目录里 package.json 的 name 是 "' + name + '"，不是 ' + expectedName + '，没删' };
    }
    fs.rmSync(dest, { recursive: true, force: true });
    return { removed: true, kind: 'dir' };
  }
  return { removed: false, kind: info.kind, reason: '不是目录也不是软链，没删' };
}

async function main(argv) {
  const { flags, opts } = parseArgv(argv);
  if (flags.has('help') || flags.has('h')) {
    usage();
    return;
  }
  const dryRun = flags.has('dry-run');
  const layout = pickLayout(opts);
  if (!layout.found) {
    for (const line of missingDeploymentLines(layout)) process.stderr.write(line + '\n');
    process.exit(2);
  }
  const ident = await worldIdentity();
  const configTarget = resolveBotConfig(layout, opts.config);
  const dest = path.join(layout.nodeModules, ...String(ident.id === '' ? 'cortico-world-mail' : 'cortico-world-mail').split('/'));
  const pkgName = 'cortico-world-mail';

  out('cortico-world-mail ← 扩展目录（卸载）');
  out('');
  info('部署根   ' + layout.root);
  info('扩展目录 ' + layout.extensionsDir);
  info('包目录   ' + PKG_DIR);
  info('世界 id  ' + ident.id);
  info('部署配置 ' + (configTarget && configTarget.file ? configTarget.file : '找不到（将只删包与依赖行）') + (dryRun ? '（dry-run：不会写任何文件）' : ''));
  out('');

  if (!fs.existsSync(layout.packageJson)) die('扩展目录里没有 package.json：' + layout.packageJson);
  if (configTarget && configTarget.file && !fs.existsSync(configTarget.file)) die('部署配置不存在：' + configTarget.file);

  if (dryRun) {
    out('dry-run 计划：');
    info('备份    ' + layout.packageJson + ' → package.json.' + BACKUP_TAG + '-<时间戳>');
    info('依赖行  去掉 "' + pkgName + '"');
    info('包      ' + dest + '（只删指向本包的软链或 name 匹配的目录）');
    if (configTarget && configTarget.file) info('配置    从 ' + configTarget.file + ' 删 worlds.' + ident.id);
    if (flags.has('restart')) info('重启    ' + layout.restartFlag);
    out('');
    return;
  }

  const state = { backup: null, configBackup: null, removed: null, depRemoved: false, sectionRemoved: false };

  // 1. 依赖行
  const backup = backupFile(layout.packageJson, 'package.json');
  state.backup = backup;
  try {
    const manifest = readJsonFile(layout.packageJson);
    if (manifest.dependencies && manifest.dependencies[pkgName] !== undefined) {
      delete manifest.dependencies[pkgName];
      writeTextAtomic(layout.packageJson, manifestText(manifest));
      state.depRemoved = true;
      ok('依赖行', '已去掉 "' + pkgName + '"（备份 ' + path.basename(backup) + '）');
    } else {
      info('依赖行', '本来就没有 "' + pkgName + '"');
    }
  } catch (error) {
    die('改 package.json 失败：' + String(error && error.message ? error.message : error), 1);
  }

  // 2. node_modules 里的那一份
  try {
    const removed = removeOurPackage(dest, pkgName);
    if (removed.removed) {
      ok('node_modules/' + pkgName, removed.kind === 'link' ? '已删软链 → ' + (removed.target ?? '?') : '已删目录');
      state.removed = true;
    } else {
      info('node_modules/' + pkgName, removed.reason ?? '没找到，跳过');
    }
  } catch (error) {
    bad('删装好的包失败', String(error && error.message ? error.message : error));
  }

  // 3. config.json 段
  if (configTarget && configTarget.file) {
    state.configBackup = backupFile(configTarget.file, 'config.json');
    try {
      const removed = disableWorldSection(configTarget.file, ident.id);
      state.sectionRemoved = removed;
      if (removed) ok('部署配置', '已删 worlds.' + ident.id + '（备份 ' + path.basename(state.configBackup) + '）');
      else info('部署配置', '本来就没有 worlds.' + ident.id);
    } catch (error) {
      bad('改 config.json 失败', String(error && error.message ? error.message : error));
    }
  }

  // 4. 校验
  out('');
  out('逐项校验：');
  const checks = [];
  const check = (label, pass, detail = '') => {
    checks.push(pass);
    if (pass) ok(label, detail);
    else bad(label, detail);
  };
  let depGone = true;
  try {
    const manifest = readJsonFile(layout.packageJson);
    depGone = !(manifest.dependencies && manifest.dependencies[pkgName] !== undefined);
  } catch {
    depGone = true;
  }
  check('data/extensions/package.json 里没有本包依赖行', depGone);
  check('node_modules/' + pkgName + ' 不在', inspectInstalled(dest).kind === 'absent');
  if (configTarget && configTarget.file) {
    let sectionGone = true;
    try {
      sectionGone = !worldEnabled(configTarget.file, ident.id);
    } catch {
      sectionGone = true;
    }
    check('config.json 里没有 worlds.' + ident.id, sectionGone);
  }
  check('本包源码目录还在', fs.existsSync(PKG_DIR), PKG_DIR);
  const failed = checks.filter((pass) => !pass).length;
  out('');
  if (failed > 0) {
    bad('有 ' + failed + ' 项没通过');
    process.exit(1);
  }
  if (flags.has('restart')) {
    try {
      writeTextAtomic(layout.restartFlag, timestamp() + '\n');
      ok('重启请求', '已写 ' + layout.restartFlag);
    } catch (error) {
      bad('写重启请求失败', String(error && error.message ? error.message : error));
      info('手动重启：控制台 → 重启');
    }
  } else {
    out('下一步：重启 Coopanion 后生效（控制台 → 重启；或再跑一次加 --restart）。');
  }
  out('');
  out('知识库与日志没动：' + path.join(layout.dataDir, 'home'));
  out('如需彻底清掉，手动删上面的知识库目录（先确认里面没有别的东西）。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
