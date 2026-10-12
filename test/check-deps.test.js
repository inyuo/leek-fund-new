/**
 * 打包前的依赖漂移检测。
 *
 * 根因复盘：磁盘 node_modules 与 yarn.lock 不一致（cheerio 1.1.2 vs 1.0.0、
 * htmlparser2 10 vs 9）时，vsce 按 lockfile 树收集依赖目录，却忽略每个目录内的
 * 嵌套 node_modules，产出版本错配的 VSIX，扩展激活必崩。
 * 此检测在打包前把漂移挡下来。
 */
const assert = require('assert');
const { findDrift } = require('../scripts/check-deps');

describe('依赖漂移检测 findDrift', () => {
  it('检测出磁盘版本与 yarn.lock 不一致的直接依赖', () => {
    // 本次事故的真实数据：yarn.lock 说 cheerio 1.0.0，磁盘上装的是 1.1.2
    const drift = findDrift(
      { cheerio: '1.0.0', entities: '4.5.0', axios: '0.19.2' },
      { cheerio: '1.1.2', entities: '4.5.0', axios: '0.19.2' }
    );
    assert.deepStrictEqual(drift, [
      { name: 'cheerio', lockfile: '1.0.0', installed: '1.1.2' }
    ]);
  });

  it('磁盘缺少 lockfile 中声明的依赖时报告 missing', () => {
    const drift = findDrift({ cheerio: '1.0.0' }, {});
    assert.deepStrictEqual(drift, [
      { name: 'cheerio', lockfile: '1.0.0', installed: 'missing' }
    ]);
  });

  it('完全一致时返回空数组', () => {
    const drift = findDrift(
      { cheerio: '1.0.0', entities: '4.5.0' },
      { cheerio: '1.0.0', entities: '4.5.0' }
    );
    assert.deepStrictEqual(drift, []);
  });
});
