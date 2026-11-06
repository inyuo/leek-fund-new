/**
 * 打包命名测试：版本号回归正常 semver（1.x.y），时间戳只进 VSIX 文件名。
 *
 * 背景：旧方案把时间戳塞进 version（1.0.<14 位>），一旦之后用 standard-version
 * 递增到 1.0.1，会比已发布版本更小，Marketplace / VS Code 都会拒绝安装。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { genTimestamp, buildVsixName, cleanupOldVsix } = require('../scripts/package');

describe('打包时间戳 genTimestamp', () => {
  it('格式为 YYYYMMDDHHmmss（14 位，仅用于文件名）', () => {
    // Date 月份从 0 起：9 = 10 月
    assert.strictEqual(genTimestamp(new Date(2026, 9, 19, 15, 42, 30)), '20261019154230');
  });

  it('月/日/时/分/秒不足两位时补零', () => {
    assert.strictEqual(genTimestamp(new Date(2026, 0, 5, 9, 7, 3)), '20260105090703');
  });

  it('同一秒内相同、跨秒不同，且字符串序与时间序一致', () => {
    const a = genTimestamp(new Date(2026, 9, 19, 10, 0, 0, 10));
    const b = genTimestamp(new Date(2026, 9, 19, 10, 0, 0, 900));
    const c = genTimestamp(new Date(2026, 9, 19, 10, 0, 1));
    assert.strictEqual(a, b, '同一秒内应稳定');
    assert.ok(a < c, `跨秒应递增：${a} → ${c}`);
  });

  it('跨小时位数变化时仍单调（09:59:59 < 10:00:00）', () => {
    const a = genTimestamp(new Date(2026, 9, 19, 9, 59, 59));
    const b = genTimestamp(new Date(2026, 9, 19, 10, 0, 0));
    assert.ok(a < b, `${a} 应 < ${b}`);
  });
});

describe('产物命名 buildVsixName', () => {
  it('形如 <name>-<version>-<timestamp>.vsix，版本号在前', () => {
    assert.strictEqual(
      buildVsixName('investment-monitor', '1.0.1', '20261106092513'),
      'investment-monitor-1.0.1-20261106092513.vsix'
    );
  });

  it('同版本多次打包得到不同文件名，不会互相覆盖', () => {
    const a = buildVsixName('x', '1.2.3', '20261106092513');
    const b = buildVsixName('x', '1.2.3', '20261106092514');
    assert.notStrictEqual(a, b);
  });

  it('清单版本必须是正常 semver，不能是旧方案的时间戳版本', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.ok(
      /^\d+\.\d+\.\d+$/.test(pkg.version),
      `package.json version 应为 1.x.y 形式，实际：${pkg.version}`
    );
  });
});

describe('历史产物清理 cleanupOldVsix', () => {
  function makeTempDir(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leek-package-'));
    files.forEach((f) => fs.writeFileSync(path.join(dir, f), 'PK'));
    return dir;
  }

  it('只删本扩展的历史包，保留本次产物与无关文件', () => {
    const keep = 'investment-monitor-1.0.1-20261106092513.vsix';
    const dir = makeTempDir([
      keep,
      'investment-monitor-1.0.0-20261105194753.vsix',
      'investment-monitor-1.0.0.vsix',
      'other-extension-1.0.0.vsix',
      'notes.txt',
    ]);

    const removed = cleanupOldVsix(dir, keep, 'investment-monitor');

    assert.deepStrictEqual(removed.sort(), [
      'investment-monitor-1.0.0-20261105194753.vsix',
      'investment-monitor-1.0.0.vsix',
    ]);
    const left = fs.readdirSync(dir).sort();
    assert.deepStrictEqual(left, [keep, 'notes.txt', 'other-extension-1.0.0.vsix'].sort());
  });

  it('目录里只有本次产物时不删任何东西', () => {
    const keep = 'investment-monitor-1.0.1-20261106092513.vsix';
    const dir = makeTempDir([keep]);
    assert.deepStrictEqual(cleanupOldVsix(dir, keep, 'investment-monitor'), []);
    assert.deepStrictEqual(fs.readdirSync(dir), [keep]);
  });
});
