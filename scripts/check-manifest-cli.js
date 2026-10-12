/**
 * 打包前的 manifest 一致性校验 CLI。
 *
 * 用法：node scripts/check-manifest-cli.js   （不一致时退出码 1）
 * 断言规则见 test/manifest.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { collectProblems } = require('./check-manifest');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const srcFiles = ['registerCommand.ts', 'extension.ts'].map((f) => path.join(ROOT, 'src', f));

const problems = collectProblems(pkg, srcFiles);
if (problems.length === 0) {
  console.log('[check-manifest] package.json contributes 与 src 注册一致 ✓');
  process.exit(0);
}

console.error('[check-manifest] package.json 与 src 注册不一致：');
for (const p of problems) {
  if (p.type === 'duplicate-views-welcome') {
    console.error(`  [viewsWelcome 重复] ${p.view}`);
  } else if (p.type === 'declared-not-registered') {
    console.error(`  [声明未注册] ${p.command} —— 命令面板执行会报 command not found`);
  } else if (p.type === 'menu-not-declared') {
    console.error(`  [menus 引用未声明] ${p.command} —— 菜单项不会显示`);
  } else {
    console.error(`  [${p.type}] ${p.command}`);
  }
}
process.exit(1);
