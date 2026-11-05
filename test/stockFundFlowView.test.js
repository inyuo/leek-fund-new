/**
 * 资金动态窗口模板行为测试（伪 DOM 执行内联 script）：
 * 1) 右栏三块资金表格（主力分析 / 主力资金 / 明-暗盘）跟随选中个股渲染
 * 2) 未登录（fundTables 为空）时右栏整块不显示
 * 3) 顶栏股票下拉仍可切换个股
 * 4) 第三方量化分析按分组卡片渲染
 *
 * 模板是纯字符串拼接渲染，没有 DOM 依赖，用轻量桩即可断言 innerHTML。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadTemplate } = require('./helpers/webview-dom');

/** init 数据：股票下拉 + 行业列表 */
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

function detailData(fundTables) {
  return {
    type: 'detail',
    data: {
      code: 'sz000977',
      name: '浪潮信息',
      price: 57.35,
      percent: 2.87,
      mainFlow: null,
      analysis: [],
      sectors: [],
      fundTables,
    },
  };
}

const TABLES = [
  {
    title: '主力分析',
    columns: ['分析日', '主力成本(占比)', '排名', '得分'],
    rows: [{ cells: ['2026-11-04', '53.56(38.74%)', '167(-809)', '77.24'], color: '#008000' }],
  },
  {
    title: '主力资金',
    columns: ['日期', '净流入', '累积', '资金评分'],
    rows: [{ cells: ['2026-11-04', '2.24亿', '2.24亿', '0.00'], color: '#ff0000' }],
  },
  {
    title: '明/暗盘',
    columns: ['日期', '暗盘', '明盘', '净流入'],
    rows: [{ cells: ['2026-11-04', '3.28亿', '2.23亿', '5.51亿'], color: '#ff0000' }],
  },
];

describe('资金动态模板 stock-fund-flow.html', () => {
  it('三块资金表格板块排在布局右侧，主内容列在左', () => {
    const htmlSrc = fs.readFileSync(
      path.join(__dirname, '..', 'template', 'stock-fund-flow.html'),
      'utf8'
    );
    // grid 列序：300px 列在右（fr 在前），fundPanel 靠 order 排到第二列
    assert.ok(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+300px/.test(htmlSrc),
      'grid 应为「主内容列 + 右栏 300px」的列序'
    );
    assert.ok(/#fundPanel\s*\{[^}]*order:\s*2/.test(htmlSrc), 'fundPanel 应 order:2 排到右侧');
    assert.ok(/\.layout\s*>\s*div\s*\{[^}]*order:\s*1/.test(htmlSrc), '主内容列应 order:1 排在左侧');
    // 提示文案不能再指向左栏
    assert.ok(!htmlSrc.includes('点击左侧'), '提示文案不应再出现「点击左侧」');
  });

  it('右栏渲染三块资金表格：标题、表头、行值与颜色', () => {
    const page = loadTemplate('stock-fund-flow.html');
    page.fire('message', { data: detailData(TABLES) });

    const html = page.el('fundTables').innerHTML;
    assert.ok(html.includes('主力分析'), `应渲染第一块标题，实际：${html.slice(0, 200)}`);
    assert.ok(html.includes('主力资金'), '应渲染第二块标题');
    assert.ok(html.includes('明/暗盘'), '应渲染第三块标题');
    assert.ok(html.includes('主力成本(占比)'), '应渲染 4 列表头');
    assert.ok(html.includes('53.56(38.74%)'), '应渲染行值');
    assert.ok(html.includes('5.51亿'), '应渲染明暗盘净流入');
    assert.ok(html.includes('#ff0000'), '行颜色应透传');
    assert.strictEqual(page.el('fundPanel').style.display, '', '有数据时右栏可见');
  });

  it('未登录（fundTables 为空）时右栏整块不显示', () => {
    const page = loadTemplate('stock-fund-flow.html');
    page.fire('message', { data: detailData([]) });

    assert.strictEqual(page.el('fundPanel').style.display, 'none');
    assert.strictEqual(page.el('fundTables').innerHTML, '', '不显示登录引导或空态占位');
  });

  it('表格字段转义，不出现 undefined/[object Object]', () => {
    const page = loadTemplate('stock-fund-flow.html');
    page.fire('message', {
      data: detailData([
        {
          title: '<img src=x>',
          columns: ['日期', '净流入'],
          rows: [{ cells: ['11-04', null], color: '' }],
        },
      ]),
    });

    const html = page.el('fundTables').innerHTML;
    assert.ok(!html.includes('<img src=x>'), '标题必须转义');
    assert.ok(html.includes('&lt;img'), '应输出转义后的标题');
    assert.ok(!html.includes('undefined'), '不应渲染 undefined');
    assert.ok(!html.includes('[object Object]'), '不应渲染 [object Object]');
  });

  it('顶栏股票下拉显示名称与代码，切换时发 select 消息', () => {
    const page = loadTemplate('stock-fund-flow.html');
    page.fire('message', {
      data: initData([
        { code: 'sh600519', name: '贵州茅台', mainNet: 123450000, tm: '20261026', source: 'xxjwxc' },
      ]),
    });

    const html = page.el('stockSelect').innerHTML;
    assert.ok(html.includes('贵州茅台'), `下拉应显示名称，实际：${html.slice(0, 200)}`);
    assert.ok(html.includes('sh600519'), '下拉应保留代码');

    page.posted.length = 0;
    const sel = page.el('stockSelect');
    sel.value = 'sh600519';
    (sel.listeners.change || []).forEach((fn) => fn());
    assert.ok(
      page.posted.some((m) => m.command === 'select' && m.code === 'sh600519'),
      '切换股票应通知宿主重拉详情'
    );
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
