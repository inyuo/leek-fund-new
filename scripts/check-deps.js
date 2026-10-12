/**
 * 打包前依赖漂移检测：磁盘 node_modules 必须与 yarn.lock 一致。
 *
 * 为什么需要：vsce 打包时用 `yarn list`（= yarn.lock 的树）决定要打进包里的依赖
 * 目录，同时对每个目录忽略其内部的 `node_modules/**`。一旦磁盘上的实际安装版本与
 * lockfile 不符，产物就会出现"目录 A 的代码 + 目录 B 的依赖"错配，扩展激活时报
 * ERR_PACKAGE_PATH_NOT_EXPORTED。
 *
 * 用法：node scripts/check-deps.js   （不一致时退出码 1）
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * 比对 yarn.lock 解析出的直接依赖与磁盘上实际安装的版本。
 * @param {Record<string,string>} lockTree  { 包名: lockfile 解析版本 }
 * @param {Record<string,string>} installed { 包名: 磁盘上 package.json 的 version }
 * @returns {Array<{name:string, lockfile:string, installed:string}>}
 */
function findDrift(lockTree, installed) {
  const drift = [];
  for (const name of Object.keys(lockTree)) {
    const lockfile = lockTree[name];
    const disk = installed[name];
    if (disk === undefined) {
      drift.push({ name, lockfile, installed: 'missing' });
    } else if (disk !== lockfile) {
      drift.push({ name, lockfile, installed: disk });
    }
  }
  return drift;
}

/** 根 package.json 声明的直接依赖 -> yarn.lock 解析出的版本 */
function readLockTree(cwd) {
  const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  const directDeps = Object.keys(pkg.dependencies || {});

  const raw = execSync('yarn list --prod --json', {
    cwd,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const match = /^{"type":"tree".*$/m.exec(raw);
  if (!match) {
    throw new Error('无法解析 yarn list --prod --json 输出');
  }
  // trees 顶层是展平的全部生产依赖（含嵌套包），不能直接当作 node_modules 顶层，
  // 否则会把正常 hoisting 误报成漂移。这里只按根直接依赖的名字取版本。
  const trees = JSON.parse(match[0]).data.trees;
  const result = {};
  for (const name of directDeps) {
    const node = trees.find((t) => t.name.startsWith(name + '@'));
    if (node) {
      result[name] = node.name.slice(name.length + 1);
    }
  }
  return result;
}

/** 读 node_modules 顶层各包（含 @scope 作用域）的实际版本 */
function readInstalled(cwd) {
  const dir = path.join(cwd, 'node_modules');
  const result = {};
  const readPkg = (pkgDir, name) => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
      if (pkg.name && pkg.version) result[pkg.name] = pkg.version;
    } catch (e) {
      // 软链接或损坏的包：跳过
    }
  };
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      for (const sub of fs.readdirSync(path.join(dir, entry))) {
        readPkg(path.join(dir, entry, sub));
      }
    } else {
      readPkg(path.join(dir, entry));
    }
  }
  return result;
}

/**
 * 运行 yarn 自带的一致性检查。
 * --integrity: node_modules 是否由当前 yarn.lock 安装（本次事故的直接检测）
 * --verify-tree: 已安装版本是否满足各包声明的依赖范围
 * @returns {string[]} 失败时的输出行，成功为空数组
 */
function runYarnChecks(cwd) {
  const failures = [];
  for (const args of ['check --integrity', 'check --verify-tree']) {
    try {
      execSync(`yarn ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      failures.push(`yarn ${args} 失败：\n${(e.stdout || '') + (e.stderr || '')}`.trim());
    }
  }
  return failures;
}

function main() {
  const cwd = path.resolve(__dirname, '..');
  const failures = runYarnChecks(cwd);
  const drift = findDrift(readLockTree(cwd), readInstalled(cwd));

  if (failures.length === 0 && drift.length === 0) {
    console.log('[check-deps] node_modules 与 yarn.lock 一致 ✓');
    return;
  }

  for (const f of failures) {
    console.error(`[check-deps] ${f}`);
  }
  if (drift.length) {
    console.error('[check-deps] 检测到直接依赖版本漂移：');
    for (const d of drift) {
      console.error(`  ${d.name}: lockfile=${d.lockfile} 磁盘=${d.installed}`);
    }
  }
  console.error('');
  console.error('直接打包会导致依赖版本错配，扩展激活时报 ERR_PACKAGE_PATH_NOT_EXPORTED。请先执行：');
  console.error('  yarn install --frozen-lockfile');
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { findDrift, readLockTree, readInstalled, runYarnChecks };
