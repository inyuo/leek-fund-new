/**
 * 量化图表面板（量价分层 / 北向资金 / 大盘指数）测试：
 *
 * 模板部分 —— 伪 DOM 执行 quant.html 内联 script（webview-dom）：
 * 1) 初始化 tab=cjl 且未登录 → Tab 高亮正确 + 未登录引导区渲染（按钮发 openLogin）
 * 2) north 数据 → canvas 绘制指令被调用（webview-dom 记录 ctx 调用）
 * 3) cjl 数据为 null（已登录）→ 「数据加载失败，点击重试」占位可重试
 *
 * 宿主部分 —— require out/webview/quantPanel，经 Module._resolveFilename
 * 重定向 'vscode' 与重依赖（同 quantTree.test.js 模式）：
 * 4) init 懒加载：tab=north 只拉 fetchNorthFundTrends，cjl/index 不发请求
 * 5) openLogin 消息 → 面板宿主调用 quantLogin（stub 断言）
 * 6) selectTab cjl 未登录 → 不发请求并下发 cjlUnlogged 引导标记
 * 7) selectTab index + refresh → 重拉当前 tab
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');
const { loadTemplate } = require('./helpers/webview-dom');

const vscodeMockPath = path.join(__dirname, 'helpers', 'vscode-mock.js');
const stubPanelPath = path.join(__dirname, 'helpers', 'stubReusedWebviewPanel.js');
const stubLjgxPath = path.join(__dirname, 'helpers', 'stubLjgxViewData.js');
const stubLoginPath = path.join(__dirname, 'helpers', 'stubQuantLogin.js');
const stubUtilsPath = path.join(__dirname, 'helpers', 'stubUtils.js');

const prevResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  const parent = rest[0];
  if (request === 'vscode') return vscodeMockPath;
  if (parent && parent.filename && parent.filename.endsWith('quantPanel.js')) {
    if (request === './ReusedWebviewPanel') return stubPanelPath;
    if (request === '../shared/utils') return stubUtilsPath;
    if (request === '../shared/ljgxData') return stubLjgxPath;
    if (request === './quantLogin') return stubLoginPath;
  }
  return prevResolveFilename.call(this, request, ...rest);
};

const ljgxStub = require('./helpers/stubLjgxViewData');
const loginStub = require('./helpers/stubQuantLogin');
const panelStub = require('./helpers/stubReusedWebviewPanel');

/** 构造 init / selectTab 推送载荷（其他 tab 字段恒 null —— 懒加载语义） */
function initPayload(tab, fields) {
  return Object.assign(
    {
      tab,
      cjl: null,
      north: null,
      index: null,
      cjlUnlogged: false,
      updatedAt: new Date().toISOString(),
    },
    fields || {}
  );
}

function count(ctx, name) {
  let c = 0;
  for (const call of ctx.calls) {
    if (call.name === name) c++;
  }
  return c;
}

/** 北向资金样例：times 与两条净值序列严格对齐 */
function northData() {
  return {
    times: ['09:30', '10:00', '10:30', '11:00', '11:30', '13:30', '14:00', '15:00'],
    hgtNet: [1.2, 2.5, 3.1, 2.8, 3.3, 3.6, 4.2, 5.1],
    szgtNet: [0.8, 1.4, 1.0, 1.9, 2.2, 1.6, 2.4, 3.0],
  };
}

describe('量化面板模板 quant.html', () => {
  it('初始化 tab=cjl 未登录 → Tab 高亮 cjl + 未登录引导区（按钮发 openLogin）', () => {
    const page = loadTemplate('quant.html');
    page.fire('message', {
      data: {
        type: 'init',
        data: initPayload('cjl', { cjl: null, cjlUnlogged: true }),
      },
    });

    assert.strictEqual(page.el('tabCjl').className.indexOf('active') >= 0, true, 'cjl Tab 应高亮');
    assert.strictEqual(
      page.el('tabNorth').className.indexOf('active') >= 0,
      false,
      'north Tab 不应高亮'
    );
    assert.strictEqual(page.el('tabIndex').className.indexOf('active') >= 0, false, 'index Tab 不应高亮');

    const html = page.el('chartEmpty').innerHTML;
    assert.ok(html.includes('登录'), `未登录应渲染登录引导文案，实际：${html}`);
    assert.strictEqual(page.el('chartWrap').style.display, 'none', '引导态不应显示画布');

    page.el('loginBtn').listeners.click[0]();
    assert.ok(
      page.posted.some((m) => m.command === 'openLogin'),
      '引导按钮点击应 postMessage openLogin'
    );
  });

  it('north 数据 → canvas 折线与刻度绘制指令被调用', () => {
    const page = loadTemplate('quant.html');
    page.fire('message', {
      data: {
        type: 'init',
        data: initPayload('north', { north: northData() }),
      },
    });

    const ctx = page.el('chart').getContext('2d');
    assert.ok(ctx.calls.length > 0, '应有 canvas 绘制指令');
    const lineTos = count(ctx, 'lineTo');
    assert.ok(lineTos >= 8, `北向双折线应产生足够 lineTo，实际 ${lineTos}`);
    const texts = count(ctx, 'fillText');
    assert.ok(texts >= 4, `图例与刻度应产生 fillText，实际 ${texts}`);
    assert.strictEqual(page.el('chartWrap').style.display, 'block', '有数据应显示画布');
  });

  it('index 数据 → 大盘多指数折线绘制，图例出现指数名称', () => {
    const page = loadTemplate('quant.html');
    page.fire('message', {
      data: {
        type: 'init',
        data: initPayload('index', {
          index: [
            { code: 'sh000001', name: '上证指数', price: [3600, 3610, 3595, 3620], percent: 0.35 },
            { code: 'sz399001', name: '深证成指', price: [11200, 11250, 11310, 11280], percent: 0.98 },
          ],
        }),
      },
    });

    assert.strictEqual(page.el('tabIndex').className.indexOf('active') >= 0, true, 'index Tab 应高亮');
    const ctx = page.el('chart').getContext('2d');
    const lineTos = count(ctx, 'lineTo');
    assert.ok(lineTos >= 4, `大盘双指数应产生足够 lineTo，实际 ${lineTos}`);
    const texts = ctx.calls
      .filter((c) => c.name === 'fillText')
      .map((c) => String(c.args[0]))
      .join('|');
    assert.ok(texts.indexOf('上证指数') !== -1, `图例应含指数名称，实际：${texts}`);
    assert.ok(texts.indexOf('深证成指') !== -1, `图例应含第二个指数名称，实际：${texts}`);
    assert.strictEqual(page.el('chartWrap').style.display, 'block', '有数据应显示画布');
  });

  it('cjl 数据为 null（已登录）→ 数据加载失败占位，点击重试发 refresh', () => {
    const page = loadTemplate('quant.html');
    page.fire('message', {
      data: {
        type: 'init',
        data: initPayload('cjl'),
      },
    });

    const html = page.el('chartEmpty').innerHTML;
    assert.ok(
      html.includes('数据加载失败，点击重试'),
      `接口失败应显示可重试占位，实际：${html}`
    );

    page.el('chartEmpty').listeners.click[0]();
    assert.ok(
      page.posted.some((m) => m.command === 'refresh'),
      '失败占位点击应 postMessage refresh'
    );
  });

  it('cjl 分层累计数组含 null → 跳过 null 档位并绘制其余档位', () => {
    const page = loadTemplate('quant.html');
    page.fire('message', {
      data: {
        type: 'init',
        data: initPayload('cjl', { cjl: { tm: '2026-11-04', price: [10, 20.5, null, 30] } }),
      },
    });

    const ctx = page.el('chart').getContext('2d');
    const fills = count(ctx, 'fillRect');
    assert.strictEqual(fills, 3, `应绘制 3 根层柱（跳过 null），实际 ${fills}`);
    const texts = ctx.calls
      .filter((c) => c.name === 'fillText')
      .map((c) => String(c.args[0]))
      .join('|');
    assert.ok(texts.indexOf('2026-11-04') !== -1, `应标注数据日期，实际：${texts}`);
  });
});

describe('量化面板宿主 quantPanel.ts', () => {
  let panel;

  before(function () {
    ljgxStub.state.north = northData();
    ljgxStub.state.index = [
      { code: 'sh000001', name: '上证指数', price: [3600, 3610, 3595], percent: 0.35 },
      { code: 'sz399001', name: '深证成指', price: [11200, 11250, 11310], percent: 0.98 },
    ];
    ljgxStub.state.cjl = { tm: '2026-11-04', price: [5, 9, 14] };

    const host = require('../out/webview/quantPanel');
    host.initQuantPanel({
      get: () => undefined,
      update: () => Promise.resolve(),
    });
    host.quantPanel('north');
    panel = panelStub.created[0];
    assert.ok(panel, '宿主应创建面板');
    // 模板脚本就绪：宿主此刻才按当前 tab 懒加载推送 init
    panel.fire({ command: 'ready' });
  });

  it('init 懒加载：tab=north → 只发北向请求，cjl/index 字段为 null', function () {
    this.timeout(2000);
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const init = panel.webview.pushed.find((m) => m.type === 'init');
        if (Date.now() - start > 1500) return reject(new Error('等待 init 推送超时'));
        if (init) return resolve();
        setTimeout(tick, 10);
      };
      tick();
    }).then(() => {
      const init = panel.webview.pushed.find((m) => m.type === 'init');
      assert.strictEqual(init.data.tab, 'north');
      assert.ok(init.data.north && init.data.north.times.length, 'north 数据应有值');
      assert.strictEqual(init.data.cjl, null, 'cjl 字段应为 null');
      assert.strictEqual(init.data.index, null, 'index 字段应为 null');

      const names = ljgxStub.calls.map((c) => c.name);
      assert.strictEqual(names[0], 'fetchNorthFundTrends');
      assert.strictEqual(names.indexOf('fetchShareCjl'), -1, '不应拉取 cjl');
      assert.strictEqual(names.indexOf('fetchIndexSpark'), -1, '不应拉取 index');
    });
  });

  it('openLogin 消息 → 面板宿主调用 quantLogin', () => {
    panel.fire({ command: 'openLogin' });
    assert.ok(
      loginStub.calls.indexOf('quantLogin') !== -1,
      `openLogin 应触发 quantLogin()，实际：${loginStub.calls.join(',')}`
    );
  });

  it('selectTab cjl（未登录）→ 不发请求并下发 cjlUnlogged 引导标记', function () {
    this.timeout(2000);
    panel.fire({ command: 'selectTab', tab: 'cjl' });
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const inits = panel.webview.pushed.filter((m) => m.type === 'init' && m.data.tab === 'cjl');
        if (Date.now() - start > 1500) return reject(new Error('等待 cjl 推送超时'));
        if (inits.length) return resolve();
        setTimeout(tick, 10);
      };
      tick();
    }).then(() => {
      const init = panel.webview.pushed.filter(
        (m) => m.type === 'init' && m.data.tab === 'cjl'
      )[0];
      assert.strictEqual(init.data.cjl, null);
      assert.strictEqual(init.data.cjlUnlogged, true, '未登录时应下发引导标记');
      assert.strictEqual(
        ljgxStub.calls.some((c) => c.name === 'fetchShareCjl'),
        false,
        '未登录不应发 get_share_cjl 请求'
      );
    });
  });

  it('selectTab index + refresh → 重拉当前 tab（fetchIndexSpark 共 2 次）', function () {
    this.timeout(2000);
    const before = ljgxStub.calls.length;
    panel.fire({ command: 'selectTab', tab: 'index' });
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const init = panel.webview.pushed.filter(
          (m) => m.type === 'init' && m.data.tab === 'index'
        )[0];
        if (Date.now() - start > 1500) return reject(new Error('等待 index 推送超时'));
        if (init && init.data.index) return resolve();
        setTimeout(tick, 10);
      };
      tick();
    }).then(() => {
      const calls0 = ljgxStub.calls.filter((c) => c.name === 'fetchIndexSpark').length;
      panel.fire({ command: 'refresh' });
      return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
          const total = ljgxStub.calls.filter((c) => c.name === 'fetchIndexSpark').length;
          if (Date.now() - start > 1500) return reject(new Error('等待 refresh 拉取超时'));
          if (total >= calls0 + 1) return resolve();
          setTimeout(tick, 10);
        };
        tick();
      }).then(() => {
        const sparks = ljgxStub.calls.slice(before).filter((c) => c.name === 'fetchIndexSpark');
        assert.strictEqual(sparks.length, 2, 'selectTab + refresh 应共拉两次 index');
        assert.strictEqual(
          ljgxStub.calls.slice(before).some((c) => c.name === 'fetchNorthFundTrends'),
          false,
          'index tab 的推送不应再拉北向'
        );
        const init = panel.webview.pushed.filter(
          (m) => m.type === 'init' && m.data.tab === 'index'
        )[0];
        assert.ok(init.data.index.length >= 2, '大盘数据应带多指数条目');
      });
    });
  });
});
