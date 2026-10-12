/**
 * 校验 package.json 的 contributes 与 src 中 registerCommand 是否一致。
 *
 * 背景：commit c34756f 把两个命令改名成 investment-monitor.*，但 src 里仍注册
 * leek-fund.*，导致命令面板条目点击报 command not found。此脚本防止同类漂移。
 */
'use strict';

/**
 * @param {object} pkg package.json 内容
 * @param {string[]} srcFiles 参与扫描的源文件绝对路径
 * @returns {Array<{type: string, command?: string, view?: string}>}
 */
function collectProblems(pkg, srcFiles) {
  const problems = [];
  const contributes = (pkg && pkg.contributes) || {};

  const declared = new Set(
    (contributes.commands || []).map((c) => c.command).filter(Boolean)
  );

  const registered = new Set();
  const fs = require('fs');
  for (const file of srcFiles) {
    let src;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch (e) {
      continue;
    }
    const re = /registerCommand\(\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      registered.add(m[1]);
    }
  }

  for (const command of declared) {
    if (!registered.has(command)) {
      problems.push({ type: 'declared-not-registered', command });
    }
  }

  for (const menu of Object.values(contributes.menus || {})) {
    for (const item of menu || []) {
      if (item && item.command && !declared.has(item.command)) {
        problems.push({ type: 'menu-not-declared', command: item.command });
      }
    }
  }

  for (const event of contributes.activationEvents || []) {
    if (typeof event === 'string' && event.startsWith('onCommand:')) {
      const command = event.slice('onCommand:'.length);
      if (!declared.has(command)) {
        problems.push({ type: 'activation-not-declared', command });
      }
    }
  }

  const seen = new Set();
  for (const entry of contributes.viewsWelcome || []) {
    const view = entry && entry.view;
    if (!view) continue;
    if (seen.has(view)) {
      problems.push({ type: 'duplicate-views-welcome', view });
    }
    seen.add(view);
  }

  return problems;
}

module.exports = { collectProblems };
