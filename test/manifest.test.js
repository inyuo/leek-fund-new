/**
 * package.json (contributes) 与 src/ 注册代码的一致性检查。
 * 纯 Node 运行，不依赖 VS Code API：yarn test:unit
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { collectProblems } = require('../scripts/check-manifest');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const SRC_FILES = ['registerCommand.ts', 'extension.ts'].map((f) =>
  path.join(ROOT, 'src', f)
);

function problems() {
  return collectProblems(pkg, SRC_FILES);
}

describe('package.json contributes 与 src 注册一致性', () => {
  it('contributes.commands 声明的每个命令都在 src 中 registerCommand 注册', () => {
    const missing = problems().filter((p) => p.type === 'declared-not-registered');
    assert.deepStrictEqual(
      missing.map((p) => p.command),
      [],
      `以下命令在 package.json 声明但代码未注册，执行会报 command not found：\n  ${missing
        .map((p) => p.command)
        .join('\n  ')}`
    );
  });

  it('menus 引用的命令必须在 contributes.commands 中声明', () => {
    const orphan = problems().filter((p) => p.type === 'menu-not-declared');
    assert.deepStrictEqual(
      orphan.map((p) => p.command),
      [],
      `以下命令被 menus 引用但未在 contributes.commands 声明，菜单项不会显示：\n  ${orphan
        .map((p) => p.command)
        .join('\n  ')}`
    );
  });

  it('activationEvents 的 onCommand 必须已声明', () => {
    const orphan = problems().filter((p) => p.type === 'activation-not-declared');
    assert.deepStrictEqual(orphan.map((p) => p.command), []);
  });

  it('viewsWelcome 同一 view 不得出现重复条目', () => {
    const dup = problems().filter((p) => p.type === 'duplicate-views-welcome');
    assert.deepStrictEqual(
      dup.map((p) => p.view),
      [],
      `以下 view 的 viewsWelcome 条目重复：${dup.map((p) => p.view).join(', ')}`
    );
  });
});
