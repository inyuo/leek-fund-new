/**
 * 打包编排：版本号走 package.json 的正常 semver（1.x.y，由 `yarn release`
 * 即 standard-version 递增），时间戳**只体现在产物文件名**上。
 *
 * 产物名：<name>-<version>-YYYYMMDDHHmmss.vsix
 * 例：investment-monitor-1.0.1-20261106092513.vsix
 *
 * 为什么不再把时间戳塞进 version：
 *   - 旧方案生成 `1.0.<14 位时间戳>`，一旦之后跑 `yarn release` 得到 1.0.1，
 *     就会比已发布过的 1.0.2026… **更小**，Marketplace / VS Code 都会拒绝安装
 *   - 扩展清单里的 version 保持干净的 1.x.y，版本递增语义才成立
 *
 * 打包过程不修改 package.json，git 工作区天然保持干净。
 *
 * 历史遗留：旧方案可能留下 `1.0.<14 位时间戳>` 的残留版本号（上一次打包被强杀，
 * 来不及还原）。检测到这种残留时按 git HEAD 的值纠正，避免把脏版本打进产物。
 *
 * 打包成功后清理根目录历史 VSIX，只保留本次产物；打包失败则保留旧包可用。
 *
 * 用法：yarn package   （内部即 node ./scripts/package.js）
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');

/** 旧方案残留的版本形态：1.0.20261019154230 */
const LEGACY_VERSION_RE = /^\d+\.\d+\.\d{14}$/;

/** 生成 YYYYMMDDHHmmss 时间戳（本地时间） */
function genTimestamp(now) {
  const d = now || new Date();
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${date}${time}`;
}

/** 产物文件名：时间戳放在版本号之后，便于按版本聚合、按时间排序 */
function buildVsixName(name, version, timestamp) {
  return `${name}-${version}-${timestamp}.vsix`;
}

/**
 * 读取 package.json，顺带兜住旧方案的版本残留。
 * @returns {{name: string, version: string}}
 */
function readPackage() {
  const raw = fs.readFileSync(PKG_PATH, 'utf8');
  const pkg = JSON.parse(raw);
  let version = String(pkg.version || '');

  if (!LEGACY_VERSION_RE.test(version)) {
    return { name: pkg.name, version };
  }

  // 残留版本号：以 git HEAD 为准纠正，纠不了就沿用，至少保证产物可用
  console.warn(`[package] 检测到旧方案残留版本号 ${version}，按 git HEAD 纠正`);
  try {
    const gitVersion = JSON.parse(execSync('git show HEAD:package.json', { cwd: ROOT, encoding: 'utf8' })).version;
    if (gitVersion && gitVersion !== version) {
      pkg.version = gitVersion;
      fs.writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
      version = gitVersion;
      console.log(`[package] 版本号已纠正为 ${version}`);
    }
  } catch (e) {
    console.warn('[package] 无法从 git 读取版本号，沿用当前值');
  }

  return { name: pkg.name, version };
}

/**
 * 校验产物是完整的 zip（读 magic number `PK`）。
 * 打包被中断时可能留下半成品，此时产物不可安装，也不能拿它去覆盖历史包。
 */
function isValidZip(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4);
    const read = fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return read === 4 && buf[0] === 0x50 && buf[1] === 0x4b;
  } catch (e) {
    return false;
  }
}

/**
 * 清理历史 VSIX，只保留 keepName。
 * - 只扫描传入目录，只匹配 `<extensionName>-*.vsix`，避免误删其它文件
 * - 单个文件删除失败只告警：本次产物已经生成，不应让清理失败毁掉一次成功打包
 * @param extensionName 清单里的 name 字段，决定哪些文件算本扩展的历史包
 * @returns {string[]} 实际删除的文件名
 */
function cleanupOldVsix(rootDir, keepName, extensionName) {
  const prefix = `${extensionName}-`;
  const removed = [];
  const names = fs
    .readdirSync(rootDir)
    .filter((name) => name !== keepName && name.startsWith(prefix) && name.endsWith('.vsix'));

  for (const name of names) {
    try {
      fs.unlinkSync(path.join(rootDir, name));
      removed.push(name);
    } catch (e) {
      console.warn(`[package] 历史包删除失败（忽略）：${name} - ${e && e.message ? e.message : e}`);
    }
  }

  return removed;
}

function main() {
  const { name, version } = readPackage();
  const timestamp = genTimestamp();
  const vsix = buildVsixName(name, version, timestamp);

  console.log(`[package] version: ${version}（时间戳 ${timestamp} 只用于文件名）`);
  console.log(`[package] 产物名: ${vsix}`);

  try {
    const run = (cmd) => execSync(cmd, { cwd: ROOT, stdio: 'inherit', shell: true });
    run('node ./scripts/check-deps.js');
    run('node ./scripts/check-manifest-cli.js');
    run(`vsce package --yarn -o ./${vsix}`);
  } catch (e) {
    console.error('[package] 打包失败：', e && e.message ? e.message : e);
    process.exit(1);
  }

  const full = path.join(ROOT, vsix);
  if (!fs.existsSync(full)) {
    // 没找到本次产物时绝不清理，避免删光旧包后无包可用
    console.log(`[package] 未在根目录找到 ${vsix}，保留历史包`);
    return;
  }

  if (!isValidZip(full)) {
    console.error(`[package] 产物 ${vsix} 不是有效的 zip（打包可能被中断），保留历史包，请重新打包`);
    process.exit(1);
  }

  const kb = (fs.statSync(full).size / 1024).toFixed(0);
  console.log(`[package] 产物：${vsix}（${kb} KB）`);

  const removed = cleanupOldVsix(ROOT, vsix, name);
  if (removed.length) {
    console.log(`[package] 已清理 ${removed.length} 个历史包：${removed.join(', ')}`);
  } else {
    console.log('[package] 无历史包需要清理');
  }
}

if (require.main === module) {
  main();
}

module.exports = { genTimestamp, buildVsixName, cleanupOldVsix };
