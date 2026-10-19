/**
 * 打包版本号生成器测试：格式 / 补零 / 单调递增 / semver 合法。
 * 版本号必须随时间变化且恒增，否则 VS Code 会拒绝安装更高版本的产物。
 */
const assert = require('assert');
const { genVersion } = require('../scripts/package');

describe('打包版本号 genVersion', () => {
  it('格式为 1.0.YYYYMMDDHHmmss（含日期与时间，每次打包都会不同）', () => {
    // Date 月份从 0 起：9 = 10 月
    const v = genVersion(new Date(2026, 9, 19, 15, 42, 30));
    assert.strictEqual(v, '1.0.20261019154230');
  });

  it('月/日/时/分/秒不足两位时补零', () => {
    const v = genVersion(new Date(2026, 0, 5, 9, 7, 3));
    assert.strictEqual(v, '1.0.20260105090703');
  });

  it('同一秒内不同毫秒给出相同版本（避免无意义差异），不同秒必不同', () => {
    const a = genVersion(new Date(2026, 9, 19, 10, 0, 0, 10));
    const b = genVersion(new Date(2026, 9, 19, 10, 0, 0, 900));
    const c = genVersion(new Date(2026, 9, 19, 10, 0, 1));
    assert.strictEqual(a, b, '同一秒内版本应稳定');
    assert.notStrictEqual(a, c, '跨秒必须产生新版本');
  });

  it('时间递增则版本递增（VS Code 要求新版本必须大于旧版本）', () => {
    const seq = [
      genVersion(new Date(2026, 9, 19, 10, 0, 0)),
      genVersion(new Date(2026, 9, 19, 10, 0, 1)),
      genVersion(new Date(2026, 9, 19, 23, 59, 59)),
      genVersion(new Date(2026, 9, 20, 0, 0, 0)),
      genVersion(new Date(2026, 11, 31, 23, 59, 59)),
      genVersion(new Date(2027, 0, 1, 0, 0, 0)),
    ];
    for (let i = 1; i < seq.length; i++) {
      assert.ok(seq[i - 1] < seq[i], `版本未递增：${seq[i - 1]} → ${seq[i]}`);
    }
  });

  it('跨小时位数变化时仍单调（09:59:59 < 10:00:00）', () => {
    const a = genVersion(new Date(2026, 9, 19, 9, 59, 59));
    const b = genVersion(new Date(2026, 9, 19, 10, 0, 0));
    assert.ok(a < b, `${a} 应 < ${b}`);
  });

  it('semver 合法：恰好三段，且 patch 无前导零', () => {
    const v = genVersion(new Date(2026, 0, 1, 0, 0, 0));
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    assert.ok(m, `不是合法 semver：${v}`);
    assert.strictEqual(m[3], String(Number(m[3])), `patch 有前导零：${v}`);
  });

  it('默认取当前时间，格式仍为 14 位时间戳', () => {
    const v = genVersion();
    assert.ok(/^1\.0\.\d{14}$/.test(v), `格式不符：${v}`);
    assert.ok(
      v >= `1.0.${new Date().getFullYear()}0101000000`,
      `版本未落在当前年份：${v}`
    );
  });
});
