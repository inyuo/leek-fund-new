/**
 * 「股票实时走势」面板（Stock 视图点击个股后打开）顶部工具条：
 * A 股个股显示「资金动态」按钮，点击后跳到「查看该股资金动态」面板；
 * 港股/美股/期货/指数不显示（资金动态的三块表格只支持 A 股个股）。
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

const vscodeMockPath = path.join(__dirname, 'helpers', 'vscode-mock.js');
const stubPanelPath = path.join(__dirname, 'helpers', 'stubReusedWebviewPanel.js');
const stubProxyPath = path.join(__dirname, 'helpers', 'stubProxyConfig.js');
const stubGlobalPath = path.join(__dirname, 'helpers', 'stubGlobalState.js');
const stubPicPath = path.join(__dirname, 'helpers', 'stubStockTrendPic.js');

const prevResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  const parent = rest[0];
  if (request === 'vscode') return vscodeMockPath;
  if (parent && parent.filename && parent.filename.endsWith('stockTrend.js')) {
    if (request === './ReusedWebviewPanel') return stubPanelPath;
    if (request === './proxyService/proxyConfig') return stubProxyPath;
    if (request === '../globalState') return stubGlobalPath;
    if (request === './stockTrendPic') return stubPicPath;
  }
  return prevResolveFilename.call(this, request, ...rest);
};

const vscodeMock = require('./helpers/vscode-mock');
const panelStub = require('./helpers/stubReusedWebviewPanel');
const trendModule = require('../out/webview/stockTrend');
const stockTrend = trendModule.default || trendModule;

/** 打开一次走势面板并返回该面板（面板是复用的，取最后一个） */
function open(code, name, stockCode) {
  stockTrend(code, name, stockCode);
  return panelStub.created[panelStub.created.length - 1];
}

describe('股票实时走势面板 stockTrend', () => {
  beforeEach(() => {
    panelStub.reset();
    vscodeMock.commandCalls.length = 0;
  });

  it('A 股个股：顶部工具条渲染「资金动态」按钮', () => {
    const panel = open('0600519', '贵州茅台', 'sh600519');
    const html = panel.webview.html;
    assert.ok(html.includes('资金动态'), '应渲染资金动态按钮');
    assert.ok(html.includes('openFundFlow'), '应带 openFundFlow 消息');
    assert.ok(html.includes('sh600519'), '按钮应带上当前股票代码');
    assert.ok(html.includes('h5chart-iframe.html'), '应保留东财 K 线 iframe');
  });

  it('点击按钮：转成 leek-fund.stockFundFlowForStock 命令跳转', () => {
    const panel = open('0600519', '贵州茅台', 'sh600519');
    panel.fire({ command: 'openFundFlow', code: 'sh600519' });

    const call = vscodeMock.commandCalls.find(
      (c) => c.name === 'leek-fund.stockFundFlowForStock'
    );
    assert.ok(call, '应执行资金动态命令');
    assert.deepStrictEqual(call.args[0], { id: 'sh600519' });
  });

  it('港股/美股/期货/指数：不显示资金动态按钮', () => {
    const cases = [
      ['000700', '腾讯控股', 'hk00700'],
      ['0aapl', '苹果', 'gb_aapl'],
      ['0RB2401', '螺纹钢', 'nf_rb2401'],
      ['0000001', '上证指数', 'sh000001'],
      ['0399001', '深证成指', 'sz399001'],
    ];
    for (const [code, name, stockCode] of cases) {
      panelStub.reset();
      const panel = open(code, name, stockCode);
      assert.ok(
        !panel.webview.html.includes('资金动态'),
        `不应显示资金动态按钮：${stockCode}`
      );
    }
  });

  it('复用面板重复打开：不重复注册消息监听', () => {
    open('0600519', '贵州茅台', 'sh600519');
    const panel = open('0000001', '浪潮信息', 'sz000977');

    panel.fire({ command: 'openFundFlow', code: 'sz000977' });
    const calls = vscodeMock.commandCalls.filter(
      (c) => c.name === 'leek-fund.stockFundFlowForStock'
    );
    assert.strictEqual(calls.length, 1, '同一面板只应触发一次跳转');
    assert.deepStrictEqual(calls[0].args[0], { id: 'sz000977' });
  });
});
