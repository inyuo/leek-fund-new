/**
 * 打包编排：给每次产物一个带日期时间的版本号，避免每次都叫
 * investment-monitor-1.0.0.vsix 而无法区分是哪一次打的包。
 *
 * 版本格式：1.0.YYYYMMDDHHmmss   例：1.0.20261019154230
 *   - 保持 1.0 主线前缀，语义仍是同一版本线
 *   - 时间戳天然单调递增，满足 VS Code「新版本必须大于旧版本」的更新要求
 *   - patch 无前导零，semver 合法（VSIX 与扩展市场都要求 semver）
 *
 * 打包前临时改写 package.json 的 version，打包结束（无论成败）用原始字节
 * 还原，使 git 工作区保持干净 —— 版本只体现在产物上，不污染仓库。
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

/** 生成 1.0.YYYYMMDDHHmmss 形式的版本号 */
function genVersion(now) {
  const d = now || new Date();
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `1.0.${date}${time}`;
}

/**
 * 读取打包前的 package.json 基准内容。
 * 上次打包被强杀时 finally 可能来不及还原，version 会残留成 `1.0.<14 位时间戳>`；
 * 这种情况下只把 version 还原成 git 里的值，其余字段保持当前内容不动。
 */
function readOriginalPackageBytes() {
  const raw = fs.readFileSync(PKG_PATH, 'utf8');
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (e) {
    return raw;
  }
  if (!/^\d+\.\d+\.\d{14}$/.test(String(pkg.version || ''))) return raw;

  try {
    const gitRaw = execSync('git show HEAD:package.json', { cwd: ROOT, encoding: 'utf8' });
    const gitVersion = JSON.parse(gitRaw).version;
    if (gitVersion && gitVersion !== pkg.version) {
      console.log(`[package] 检测到上次打包残留的版本号 ${pkg.version}，还原为 ${gitVersion}`);
      pkg.version = gitVersion;
      return `${JSON.stringify(pkg, null, 2)}\n`;
    }
  } catch (e) {
    // 非 git 仓库或无 HEAD，忽略
  }
  return raw;
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
 * - 只扫描传入目录，只匹配 investment-monitor-*.vsix，避免误删其它文件
 * - 单个文件删除失败只告警：本次产物已经生成，不应让清理失败毁掉一次成功打包
 * @returns {string[]} 实际删除的文件名
 */
function cleanupOldVsix(rootDir, keepName) {
  const removed = [];
  const names = fs
    .readdirSync(rootDir)
    .filter((name) => name !== keepName && /^investment-monitor-.*\.vsix$/.test(name));

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
  const originalBytes = readOriginalPackageBytes();
  const pkg = JSON.parse(originalBytes);
  const originalVersion = pkg.version;
  const nextVersion = genVersion();

  pkg.version = nextVersion;
  // 保持与原文件一致的两空格缩进 + 结尾换行
  fs.writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`[package] version: ${originalVersion} → ${nextVersion}`);

  let failed = false;
  try {
    const run = (cmd) => execSync(cmd, { cwd: ROOT, stdio: 'inherit', shell: true });

    run('node ./scripts/check-deps.js');
    run('node ./scripts/check-manifest-cli.js');
    run('vsce package --yarn -o ./');
  } catch (e) {
    failed = true;
    console.error('[package] 打包失败：', e && e.message ? e.message : e);
  } finally {
    // 无论成功失败都还原，避免把一次性版本号提交进仓库
    fs.writeFileSync(PKG_PATH, originalBytes);
    console.log(`[package] package.json 已还原为 ${originalVersion}（git 保持干净）`);
  }

  if (failed) {
    process.exit(1);
  }

  const vsix = `investment-monitor-${nextVersion}.vsix`;
  const full = path.join(ROOT, vsix);
  if (fs.existsSync(full)) {
    if (!isValidZip(full)) {
      console.error(
        `[package] 产物 ${vsix} 不是有效的 zip（打包可能被中断），保留历史包，请重新打包`
      );
      process.exit(1);
    }
    const kb = (fs.statSync(full).size / 1024).toFixed(0);
    console.log(`[package] 产物：${vsix}（${kb} KB）`);

    const removed = cleanupOldVsix(ROOT, vsix);
    if (removed.length) {
      console.log(`[package] 已清理 ${removed.length} 个历史包：${removed.join(', ')}`);
    } else {
      console.log('[package] 无历史包需要清理');
    }
  } else {
    // 没找到本次产物时绝不清理，避免删光旧包后无包可用
    console.log(`[package] 期望产物：${vsix}（未在根目录找到，实际产物名可能不同）`);
    console.log('[package] 未找到本次产物，保留历史包');
  }
}

if (require.main === module) {
  main();
}

module.exports = { genVersion, cleanupOldVsix };
