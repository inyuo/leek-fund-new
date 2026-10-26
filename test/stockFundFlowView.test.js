/**
 * 资金动态窗口模板行为测试（伪 DOM 执行内联 script）：
 * 1) 左侧自选股列表显示股票名称（name 字段透传渲染）
 * 2) 第三方量化分析按分组卡片渲染（结构化 {name, msgs[]}）
 *
 * 模板是纯字符串拼接渲染，没有 DOM 依赖，用轻量桩即可断言 innerHTML。
 */
const assert = require('assert');
const { loadTemplate } = require('./helpers/webview-dom');

/** init 数据：粒度 A 列表 + 粒度 D 行业 */
function initData(stocks) {
  return {
    type: 'init',
    data: {
      stocks,
      industry: [{ code: 'BK1', name: '通信', amount: 100, ratio: 1.5 }],
      total: stocks.length,
      initialCode: '',
      updatedAt: new Date().toISOString(),
    },
  };
}

describe('资金动态模板 stock-fund-flow.html', () => {
  it('左侧列表显示股票名称与代码', () => {
    const page = loadTemplate('stock-fund-flow.html');
    page.fire('message', {
      data: initData([
        { code: 'sh600519', name: '贵州茅台', mainNet: 123450000, tm: '20261026', source: 'xxjwxc' },
      ]),
    });

    const html = page.el('stockList').innerHTML;
    assert.ok(html.includes('贵州茅台'), `列表应显示股票名称，实际：${html.slice(0, 200)}`);
    assert.ok(html.includes('sh600519'), '列表应同时保留代码');
  });

  it('名称缺失时只显示代码，不出现 undefined/[object Object]', () => {
    const page = loadTemplate('stock-fund-flow.html');
    page.fire('message', {
      data: initData([{ code: 'sz000001', name: '', mainNet: null, tm: '', source: '' }]),
    });

    const html = page.el('stockList').innerHTML;
    assert.ok(html.includes('sz000001'), '无名称时应回退显示代码');
    assert.ok(!html.includes('undefined'), '不应渲染 undefined');
    assert.ok(!html.includes('[object Object]'), '不应渲染 [object Object]');
  });

  it('量化分析按分组卡片渲染：组名标题 + 逐条消息', () => {
    const page = loadTemplate('stock-fund-flow.html');
    page.fire('message', {
      data: {
        type: 'detail',
        data: {
          code: 'sh600519',
          name: '贵州茅台',
          price: 1333.1,
          percent: -0.14,
          mainFlow: null,
          analysis: [
            { name: 'PEG估值', msgs: ['peg指标:-4.945', '行业对比:平均 2.074'] },
            { name: '综合评分(多维度)', msgs: ['综合:97.07'] },
          ],
          sectors: [],
        },
      },
    });

    const html = page.el('analysisBox').innerHTML;
    assert.ok(html.includes('PEG估值'), `应渲染组名，实际：${html.slice(0, 300)}`);
    assert.ok(html.includes('综合评分(多维度)'), '应渲染第二个组名');
    assert.ok(html.includes('peg指标'), '应渲染组内消息');
    assert.ok(html.includes('97.07'), '应渲染组内指标值');
    assert.ok(!html.includes('[object Object]'), '结构化数据不能整块 toString');
  });

  it('分析为空数组时显示空态提示', () => {
    const page = loadTemplate('stock-fund-flow.html');
    page.fire('message', {
      data: {
        type: 'detail',
        data: {
          code: 'sh600519',
          name: '贵州茅台',
          price: 0,
          percent: 0,
          mainFlow: null,
          analysis: [],
          sectors: [],
        },
      },
    });

    const html = page.el('analysisBox').innerHTML;
    assert.ok(html.includes('暂无分析结论'), `空分析应显示空态，实际：${html.slice(0, 200)}`);
  });
});
