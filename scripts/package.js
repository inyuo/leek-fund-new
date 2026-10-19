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

function main() {
  const originalBytes = fs.readFileSync(PKG_PATH, 'utf8');
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
    const kb = (fs.statSync(full).size / 1024).toFixed(0);
    console.log(`[package] 产物：${vsix}（${kb} KB）`);
  } else {
    console.log(`[package] 期望产物：${vsix}（未在根目录找到，实际产物名可能不同）`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { genVersion };
