/**
 * 资金动态宿主回归：三块表格走需登录态的 analy.get_sp，
 * 必须确认 initStockFundFlow 注入的 store 真的传到了 loadStockDetail，
 * 否则线上永远拿不到数据、右栏被当成「未登录」整块隐藏。
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

const vscodeMockPath = path.join(__dirname, 'helpers', 'vscode-mock.js');
const stubPanelPath = path.join(__dirname, 'helpers', 'stubReusedWebviewPanel.js');
const stubUtilsPath = path.join(__dirname, 'helpers', 'stubUtils.js');
const stubFundPath = path.join(__dirname, 'helpers', 'stubFundFlowData.js');

const prevResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  const parent = rest[0];
  if (request === 'vscode') return vscodeMockPath;
  if (parent && parent.filename && parent.filename.endsWith('stockFundFlow.js')) {
    if (request === './ReusedWebviewPanel') return stubPanelPath;
    if (request === '../shared/utils') return stubUtilsPath;
    if (request === '../shared/fundFlowData') return stubFundPath;
  }
  return prevResolveFilename.call(this, request, ...rest);
};

const vscodeMock = require('./helpers/vscode-mock');
vscodeMock.workspace = {
  getConfiguration: () => ({ get: () => ['sh600519', 'sz000977'] }),
};
const panelStub = require('./helpers/stubReusedWebviewPanel');
const fundStub = require('./helpers/stubFundFlowData');
const host = require('../out/webview/stockFundFlow');

/** 等 pushDetail 的 Promise 链落地 */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('资金动态宿主 stockFundFlow', () => {
  let panel;

  before(() => {
    panelStub.reset();
    host.stockFundFlow('sh600519');
    panel = panelStub.created[0];
  });

  beforeEach(() => fundStub.reset());

  it('未注入 store 时详情取数的 deps.store 为 undefined', async () => {
    panel.fire({ command: 'select', code: 'sh600519' });
    await tick();

    const call = fundStub.calls.find((c) => c.code === 'sh600519');
    assert.ok(call, '应触发详情取数');
    assert.ok(call.deps, '应传 deps');
    assert.strictEqual(call.deps.store, undefined);
  });

  it('initStockFundFlow 注入的 store 透传到详情取数，detail 消息带 fundTables', async () => {
    const store = { get: () => undefined, update: () => Promise.resolve() };
    host.initStockFundFlow(store);

    const before = panel.webview.pushed.length;
    panel.fire({ command: 'select', code: 'sz000977' });
    await tick();

    const call = fundStub.calls.find((c) => c.code === 'sz000977');
    assert.ok(call, '应触发详情取数');
    assert.strictEqual(call.deps.store, store, '登录态必须透传给 analy.get_sp');

    const detail = panel.webview.pushed.slice(before).find((m) => m.type === 'detail');
    assert.ok(detail, '应推送 detail 消息');
    assert.ok(Array.isArray(detail.data.fundTables), 'detail 应携带三块表格字段');
  });
});
