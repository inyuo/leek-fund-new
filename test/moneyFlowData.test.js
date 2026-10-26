/**
 * 资金动态数据源测试：
 * 1) xxjwxc 客户端 —— 超时重试、个股主力流、行业分时流、头条、分析结论
 * 2) 东财备源 —— secid 转换、行业流解析、个股当日主力净流入
 *
 * 说明：外网请求在单测里一律 mock axios，只测解析与降级逻辑，
 * 不让单测依赖第三方接口的实时可用性。
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

const vscodeMockPath = path.join(__dirname, 'helpers', 'vscode-mock.js');
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return vscodeMockPath;
  return origResolveFilename.call(this, request, ...args);
};

const axios = require('axios');
const xxj = require('../out/shared/xxjwxcData');
const em = require('../out/shared/emMoneyFlow');
const tc = require('../out/shared/tencentStock');

const originalPost = axios.post;
const originalGet = axios.get;
afterEach(() => {
  axios.post = originalPost;
  axios.get = originalGet;
});

/** 构造一个超时错误 */
function timeoutError() {
  const err = new Error('timeout of 30000ms exceeded');
  err.code = 'ECONNABORTED';
  return err;
}

/** xxjwxc 标准成功响应 */
function ok(data) {
  return { status: 200, data: { state: true, error: 'normal', data } };
}

describe('xxjwxc 个股主力资金流 fetchStockMainFlow', () => {
  it('解析 price[] 与 main[] 数组', async () => {
    axios.post = async () =>
      ok({ tm: '20261019', price: [1330.99, 1334.3], main: [17216224, 20943808] });

    const r = await xxj.fetchStockMainFlow('sh600519');
    assert.strictEqual(r.tm, '20261019');
    assert.deepStrictEqual(r.price, [1330.99, 1334.3]);
    assert.deepStrictEqual(r.main, [17216224, 20943808]);
  });

  it('接口失败时返回 null 而不是抛异常', async () => {
    axios.post = async () => {
      throw timeoutError();
    };
    assert.strictEqual(await xxj.fetchStockMainFlow('sh600519'), null);
  });

  it('状态为 state:false 时返回 null', async () => {
    axios.post = async () => ({ status: 200, data: { state: false, code: 1018, error: '缓存已过期' } });
    assert.strictEqual(await xxj.fetchStockMainFlow('sh600519'), null);
  });

  it('payload 缺 main 数组时返回 null（避免下游拿到半截数据）', async () => {
    axios.post = async () => ok({ tm: '20261019', price: [1] });
    assert.strictEqual(await xxj.fetchStockMainFlow('sh600519'), null);
  });
});

describe('xxjwxc 请求超时重试', () => {
  it('首次超时后自动重试一次并拿到数据', async () => {
    let calls = 0;
    axios.post = async () => {
      calls += 1;
      if (calls === 1) throw timeoutError();
      return ok({ tm: '20261019', price: [1, 2], main: [3, 4] });
    };

    const r = await xxj.fetchStockMainFlow('sh600519');
    assert.strictEqual(calls, 2, `应重试一次，实际请求 ${calls} 次`);
    assert.ok(r && r.main.length === 2);
  });

  it('连续失败时返回 null 且不抛异常', async () => {
    let calls = 0;
    axios.post = async () => {
      calls += 1;
      throw timeoutError();
    };
    const r = await xxj.fetchStockMainFlow('sh600519');
    assert.strictEqual(r, null);
    assert.strictEqual(calls, 2, '应只尝试 2 次（首试 + 1 次重试），实际 ' + calls);
  });

  it('失败响应的超时值为 30000ms（接口实测最慢 25.7s）', async () => {
    let seenTimeout = null;
    axios.post = async (url, body, opts) => {
      seenTimeout = opts && opts.timeout;
      return ok({ tm: 'x', price: [1], main: [1] });
    };
    await xxj.fetchStockMainFlow('sh600519');
    assert.strictEqual(seenTimeout, 30000);
  });
});

describe('xxjwxc 行业分时资金流 parseHyTime', () => {
  const PAYLOAD = {
    state: true,
    error: 'normal',
    data: {
      title: '2026-10-19 行业主力净流入分时图',
      sum: '-347.85亿',
      list: ['通信线缆及配套', '通信设备', '出版'],
      data: [
        ['name', 'jlr', 'tm'],
        ['通信设备', 226808608, '09:30'],
        ['出版', -357359184, '09:30'],
        ['通信设备', 456625232, '09:40'],
        ['出版', -513768816, '09:40'],
        ['通信线缆及配套', 182499309, '09:30'],
      ],
    },
  };

  it('每个行业只保留最新时点的净流入', () => {
    const rows = xxj.parseHyTime(PAYLOAD);
    const byName = {};
    rows.forEach((r) => {
      byName[r.name] = r.amount;
    });
    assert.strictEqual(byName['通信设备'], 456625232, '应取 09:40 而非 09:30');
    assert.strictEqual(byName['出版'], -513768816);
    assert.strictEqual(byName['通信线缆及配套'], 182499309);
  });

  it('按净流入金额从大到小排序', () => {
    const rows = xxj.parseHyTime(PAYLOAD);
    assert.strictEqual(rows[0].name, '通信设备');
    assert.strictEqual(rows[rows.length - 1].name, '出版');
  });

  it('空/异常入参返回空数组', () => {
    assert.deepStrictEqual(xxj.parseHyTime(null), []);
    assert.deepStrictEqual(xxj.parseHyTime({ state: true, data: {} }), []);
    assert.deepStrictEqual(xxj.parseHyTime({ state: true, data: { data: [] } }), []);
  });

  it('fetchIndustryFlow 成功时返回解析结果', async () => {
    axios.post = async () => ({ status: 200, data: PAYLOAD });
    const rows = await xxj.fetchIndustryFlow();
    assert.strictEqual(rows.length, 3);
  });

  it('fetchIndustryFlow 失败时返回空数组', async () => {
    axios.post = async () => {
      throw timeoutError();
    };
    assert.deepStrictEqual(await xxj.fetchIndustryFlow(), []);
  });
});

describe('xxjwxc 财经头条 fetchHeadlines', () => {
  it('返回标题数组', async () => {
    axios.post = async () => ok({ list: ['头条一', '头条二'] });
    assert.deepStrictEqual(await xxj.fetchHeadlines(), ['头条一', '头条二']);
  });

  it('失败时返回空数组（资讯兜底不能抛异常）', async () => {
    axios.post = async () => {
      throw timeoutError();
    };
    assert.deepStrictEqual(await xxj.fetchHeadlines(), []);
  });
});

describe('xxjwxc 个股分析结论 fetchStockAnalysis', () => {
  it('把 list[].msgs 拼成可读文本行', async () => {
    axios.post = async () =>
      ok({
        list: [
          { name: '综合评分(多维度)', msgs: ['综合:96.01(趋势:95.96)'] },
          { name: '特色数据', msgs: ['主力成本:1318.26;机构参与度:60.41%'] },
        ],
      });
    const text = await xxj.fetchStockAnalysis('sh600519');
    assert.ok(text.includes('综合评分(多维度)'), '应含分组名');
    assert.ok(text.includes('综合:96.01'), '应含指标值');
    assert.ok(text.includes('机构参与度:60.41%'), '应含机构参与度');
  });

  it('失败时返回空串', async () => {
    axios.post = async () => {
      throw timeoutError();
    };
    assert.strictEqual(await xxj.fetchStockAnalysis('sh600519'), '');
  });
});

describe('xxjwxc 结构化分析分组 fetchStockAnalysisGroups', () => {
  const LIST = {
    list: [
      { name: 'PEG估值', msgs: ['peg指标:-4.945', '行业对比:平均 2.074 | 中值 383.219'] },
      { name: '综合评分(多维度)', msgs: ['综合:97.07(趋势:97.30)'] },
      { name: '空分组', msgs: [] },
      '脏数据行',
    ],
  };

  it('按分组返回 {name, msgs[]} 结构，跳过空分组与脏行', async () => {
    axios.post = async () => ok(LIST);
    const groups = await xxj.fetchStockAnalysisGroups('sh600519');
    assert.strictEqual(groups.length, 2, '空分组与非对象行不应出现');
    assert.strictEqual(groups[0].name, 'PEG估值');
    assert.deepStrictEqual(groups[0].msgs, ['peg指标:-4.945', '行业对比:平均 2.074 | 中值 383.219']);
    assert.strictEqual(groups[1].name, '综合评分(多维度)');
  });

  it('失败时返回空数组', async () => {
    axios.post = async () => {
      throw timeoutError();
    };
    assert.deepStrictEqual(await xxj.fetchStockAnalysisGroups('sh600519'), []);
  });

  it('payload 无 list 时返回空数组', async () => {
    axios.post = async () => ok({});
    assert.deepStrictEqual(await xxj.fetchStockAnalysisGroups('sh600519'), []);
  });
});

describe('腾讯批量股票名称 fetchStockNames / parseStockNames', () => {
  const BODY =
    'v_sh600519="1~贵州茅台~600519~1333.10~1335.00~...";\n' +
    'v_sz000001="51~平安银行~000001~11.26~...";\n' +
    'v_pv_none_match="1";\n';

  it('解析批量行情文本为 代码→名称 映射', () => {
    const names = tc.parseStockNames(BODY);
    assert.strictEqual(names.sh600519, '贵州茅台');
    assert.strictEqual(names.sz000001, '平安银行');
    assert.strictEqual(Object.keys(names).length, 2, '无名称的 pv_none_match 行不应入表');
  });

  it('一次请求取回全部代码的名称', async () => {
    axios.get = async () => ({ status: 200, data: BODY });
    const names = await tc.fetchStockNames(['sh600519', 'sz000001']);
    assert.strictEqual(names.sh600519, '贵州茅台');
    assert.strictEqual(names.sz000001, '平安银行');
  });

  it('请求失败时返回空对象（名称缺失不能拖垮列表）', async () => {
    axios.get = async () => {
      throw timeoutError();
    };
    assert.deepStrictEqual(await tc.fetchStockNames(['sh600519']), {});
  });

  it('空代码列表不发请求', async () => {
    let called = false;
    axios.get = async () => {
      called = true;
      return { status: 200, data: BODY };
    };
    assert.deepStrictEqual(await tc.fetchStockNames([]), {});
    assert.strictEqual(called, false);
  });
});

describe('并发限流 mapLimit', () => {
  const { mapLimit } = require('../out/shared/utils');

  it('结果顺序与输入顺序一致', async () => {
    const input = [1, 2, 3, 4, 5];
    const out = await mapLimit(input, 2, async (n) => n * 10);
    assert.deepStrictEqual(out, [10, 20, 30, 40, 50]);
  });

  it('并发执行数不超过 limit（避免打爆第三方接口触发反爬）', async () => {
    let running = 0;
    let peak = 0;
    const input = [1, 2, 3, 4, 5, 6, 7, 8];

    await mapLimit(input, 3, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
    });

    assert.ok(peak <= 3, `并发峰值 ${peak} 超过 limit 3`);
    assert.ok(peak >= 2, `并发未生效，峰值仅 ${peak}`);
  });

  it('limit 大于元素数时不报错', async () => {
    const out = await mapLimit([1, 2], 50, async (n) => n);
    assert.deepStrictEqual(out, [1, 2]);
  });

  it('空数组返回空数组', async () => {
    assert.deepStrictEqual(await mapLimit([], 3, async (n) => n), []);
  });

  it('limit 为 0 或非法值时退化为逐个执行，不陷入死循环', async () => {
    const out = await mapLimit([1, 2, 3], 0, async (n) => n * 2);
    assert.deepStrictEqual(out, [2, 4, 6]);
  });

  it('任务抛错时整体 reject', async () => {
    await assert.rejects(
      () => mapLimit([1, 2, 3], 2, async (n) => (n === 2 ? Promise.reject(new Error('x')) : n)),
      /x/
    );
  });
});

describe('AI prompt 资金附录构造 buildStockMoneyFlowAppendix', () => {
  const FLOW = { tm: '20261019', price: [1, 2], main: [17216224, 322524958] };
  const ANALYSIS = '【综合评分(多维度)】综合:96.01(趋势:95.96)';

  it('两者都空时返回空串（不产生空附录）', () => {
    assert.strictEqual(xxj.buildStockMoneyFlowAppendix(null, ''), '');
    assert.strictEqual(xxj.buildStockMoneyFlowAppendix(null, ''), '');
  });

  it('只有一项时只包含该项', () => {
    const onlyFlow = xxj.buildStockMoneyFlowAppendix(FLOW, '');
    assert.ok(onlyFlow.includes('主力资金流'), '应含资金流段');
    assert.ok(!onlyFlow.includes('量化分析'), '不应含分析段');

    const onlyAna = xxj.buildStockMoneyFlowAppendix(null, ANALYSIS);
    assert.ok(!onlyAna.includes('主力资金流'), '不应含资金流段');
    assert.ok(onlyAna.includes('量化分析'), '应含分析段');
  });

  it('两者都有时全部出现', () => {
    const text = xxj.buildStockMoneyFlowAppendix(FLOW, ANALYSIS);
    assert.ok(text.includes('主力资金流'));
    assert.ok(text.includes('量化分析'));
    assert.ok(text.includes('综合:96.01'));
  });

  it('用末值作为当日累计主力净流入，绝不对数组求和', () => {
    // main[] 是分时累计序列：sum=494687182 远大于真实当日值 322524958
    const text = xxj.buildStockMoneyFlowAppendix(FLOW, '');
    assert.ok(text.includes('3.23亿'), `末值 322524958 应格式化为 3.23亿，实际：${text}`);
    assert.ok(!text.includes('4.95亿'), '不得把数组求和后的 4.95亿 当作当日值');
  });

  it('金额按亿/万格式化并带正负号', () => {
    const text = xxj.buildStockMoneyFlowAppendix(
      { tm: 't', price: [1], main: [-784795000] },
      ''
    );
    assert.ok(text.includes('-7.85亿'), `负值应为 -7.85亿，实际：${text}`);

    const small = xxj.buildStockMoneyFlowAppendix({ tm: 't', price: [1], main: [50000] }, '');
    assert.ok(small.includes('+5.00万'), `5万应带正号，实际：${small}`);
  });

  it('附录标注数据来源与时间，便于模型判断时效', () => {
    const text = xxj.buildStockMoneyFlowAppendix(FLOW, ANALYSIS);
    assert.ok(text.includes('20261019'), '应含数据日期');
    assert.ok(text.includes('复利备忘录') || text.includes('xxjwxc'), '应标注来源');
  });
});

describe('xxjwxc 个股信息 fetchStockQuote', () => {
  const QUOTE = {
    state: true,
    error: 'normal',
    data: {
      info: {
        code: 'sh600519',
        name: '贵州茅台',
        price: 1337.05,
        change: 8.05,
        percent: 0.61,
        hy: [{ name: '贵州板块', percent: 0.54, code: 'BK0173' }],
      },
    },
  };

  it('返回名称/现价/涨幅/所属板块', async () => {
    axios.post = async () => ({ status: 200, data: QUOTE });
    const info = await xxj.fetchStockQuote('sh600519');
    assert.strictEqual(info.name, '贵州茅台');
    assert.strictEqual(info.price, 1337.05);
    assert.strictEqual(info.percent, 0.61);
    assert.strictEqual(info.hy.length, 1);
    assert.strictEqual(info.hy[0].name, '贵州板块');
  });

  it('失败时返回 null', async () => {
    axios.post = async () => {
      throw timeoutError();
    };
    assert.strictEqual(await xxj.fetchStockQuote('sh600519'), null);
  });
});

describe('资金动态多源编排 fundFlowData', () => {
  const flowModule = require('../out/shared/xxjwxcData');
  const emModule = require('../out/shared/emMoneyFlow');
  const tcModule = require('../out/shared/tencentStock');
  const fund = require('../out/shared/fundFlowData');
  const orig = {
    fetchStockMainFlow: flowModule.fetchStockMainFlow,
    fetchIndustryFlow: flowModule.fetchIndustryFlow,
    fetchStockQuote: flowModule.fetchStockQuote,
    fetchStockAnalysis: flowModule.fetchStockAnalysis,
    fetchStockAnalysisGroups: flowModule.fetchStockAnalysisGroups,
    fetchEastIndustryFlow: emModule.fetchEastIndustryFlow,
    fetchEastStockMainFlow: emModule.fetchEastStockMainFlow,
    fetchStockNames: tcModule.fetchStockNames,
  };
  afterEach(() => {
    flowModule.fetchStockMainFlow = orig.fetchStockMainFlow;
    flowModule.fetchIndustryFlow = orig.fetchIndustryFlow;
    flowModule.fetchStockQuote = orig.fetchStockQuote;
    flowModule.fetchStockAnalysis = orig.fetchStockAnalysis;
    flowModule.fetchStockAnalysisGroups = orig.fetchStockAnalysisGroups;
    emModule.fetchEastIndustryFlow = orig.fetchEastIndustryFlow;
    emModule.fetchEastStockMainFlow = orig.fetchEastStockMainFlow;
    tcModule.fetchStockNames = orig.fetchStockNames;
  });
  beforeEach(() => {
    // 名称接口默认放行（避免旧用例打外网），需要断言的用例再覆盖
    tcModule.fetchStockNames = async () => ({});
  });

  describe('loadStockFundRows（A：逐股当日主力净流入）', () => {
    it('过滤掉非 A 股代码（港股/美股/期货/商品不发请求）', async () => {
      const seen = [];
      flowModule.fetchStockMainFlow = async (code) => {
        seen.push(code);
        return { tm: 't', price: [1], main: [100] };
      };

      const rows = await fund.loadStockFundRows(['sh600519', 'hk00700', 'usr_ixic', 'nf_IF0', 'sz000001']);
      assert.deepStrictEqual(seen.sort(), ['sh600519', 'sz000001'], `实际请求了 ${seen.join(',')}`);
      assert.strictEqual(rows.length, 2);
    });

    it('A 股失败时该行保留且 mainNet 为 null（不丢行、不抛错）', async () => {
      flowModule.fetchStockMainFlow = async (code) =>
        code === 'sz000001' ? null : { tm: 't', price: [1], main: [123450000] };
      emModule.fetchEastStockMainFlow = async () => null;

      const rows = await fund.loadStockFundRows(['sh600519', 'sz000001']);
      assert.strictEqual(rows.length, 2, '失败的股票不能从列表消失');
      const ok = rows.find((r) => r.code === 'sh600519');
      const bad = rows.find((r) => r.code === 'sz000001');
      assert.strictEqual(ok.mainNet, 123450000, '取末时点作为当日累计值');
      assert.strictEqual(bad.mainNet, null);
    });

    it('xxjwxc 失败时回退东财当日主力净流入（单点故障兜底）', async () => {
      flowModule.fetchStockMainFlow = async () => null;
      emModule.fetchEastStockMainFlow = async (code) =>
        code === 'sh600519' ? 384310560 : null;

      const rows = await fund.loadStockFundRows(['sh600519', 'sz000001']);
      const ok = rows.find((r) => r.code === 'sh600519');
      const bad = rows.find((r) => r.code === 'sz000001');
      assert.strictEqual(ok.mainNet, 384310560, '应使用东财备源当日值');
      assert.strictEqual(bad.mainNet, null, '两源都失败才置 null');
    });

    it('主源成功时不触碰东财备源（避免多余的高风控接口请求）', async () => {
      let eastCalls = 0;
      flowModule.fetchStockMainFlow = async () => ({ tm: 't', price: [1], main: [7] });
      emModule.fetchEastStockMainFlow = async () => {
        eastCalls += 1;
        return 999;
      };

      const rows = await fund.loadStockFundRows(['sh600519']);
      assert.strictEqual(rows[0].mainNet, 7, '主源可用时必须用主源值');
      assert.strictEqual(eastCalls, 0, `主源正常却调用了东财备源 ${eastCalls} 次`);
    });

    it('mainNet 取末元素而非求和（main[] 是分时累计序列）', async () => {
      flowModule.fetchStockMainFlow = async () => ({
        tm: 't',
        price: [1, 2],
        main: [10, 20, 30],
      });
      const rows = await fund.loadStockFundRows(['sh600519']);
      assert.strictEqual(rows[0].mainNet, 30, '应取末元素 30，而非求和 60');
    });

    it('空输入返回空数组', async () => {
      assert.deepStrictEqual(await fund.loadStockFundRows([]), []);
      assert.deepStrictEqual(await fund.loadStockFundRows(null), []);
    });

    it('行内附带股票名称（腾讯批量接口一次取回）', async () => {
      flowModule.fetchStockMainFlow = async () => ({ tm: 't', price: [1], main: [7] });
      let requested = [];
      tcModule.fetchStockNames = async (codes) => {
        requested = codes;
        return { sh600519: '贵州茅台', sz000001: '平安银行' };
      };

      const rows = await fund.loadStockFundRows(['sh600519', 'sz000001']);
      assert.deepStrictEqual(requested.sort(), ['sh600519', 'sz000001'], '应批量请求全部 A 股代码');
      assert.strictEqual(rows[0].name, '贵州茅台');
      assert.strictEqual(rows[1].name, '平安银行');
    });

    it('名称接口失败时行保留且 name 为空串（不拖垮整个列表）', async () => {
      flowModule.fetchStockMainFlow = async () => ({ tm: 't', price: [1], main: [7] });
      tcModule.fetchStockNames = async () => ({});

      const rows = await fund.loadStockFundRows(['sh600519']);
      assert.strictEqual(rows.length, 1, '名称失败不能丢行');
      assert.strictEqual(rows[0].name, '', '取不到名称时应为空串而非 undefined');
      assert.strictEqual(rows[0].mainNet, 7, '资金流数据不受名称失败影响');
    });
  });

  describe('loadIndustryRows（D：全行业资金流排名）', () => {
    it('东财可用时用东财（含 code/ratio）', async () => {
      emModule.fetchEastIndustryFlow = async () => [
        { code: 'BK1', name: '通信', amount: 100, ratio: 1.5 },
      ];
      flowModule.fetchIndustryFlow = async () => {
        throw new Error('不应被调用');
      };

      const rows = await fund.loadIndustryRows();
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].code, 'BK1');
      assert.strictEqual(rows[0].ratio, 1.5);
    });

    it('东财空时回退 xxjwxc 行业流', async () => {
      emModule.fetchEastIndustryFlow = async () => [];
      flowModule.fetchIndustryFlow = async () => [{ name: '出版', amount: -500 }];

      const rows = await fund.loadIndustryRows();
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].name, '出版');
      assert.strictEqual(rows[0].amount, -500);
      assert.strictEqual(rows[0].code, '', 'xxjwxc 无板块代码，应为空串而非 undefined');
    });

    it('两源都空时返回空数组（不抛错）', async () => {
      emModule.fetchEastIndustryFlow = async () => [];
      flowModule.fetchIndustryFlow = async () => [];
      assert.deepStrictEqual(await fund.loadIndustryRows(), []);
    });
  });

  describe('loadStockDetail（B 分时曲线 + C 所属板块）', () => {
    it('聚合分时资金流、所属板块与第三方分析', async () => {
      flowModule.fetchStockMainFlow = async () => ({ tm: '20261019', price: [1, 2], main: [3, 4] });
      flowModule.fetchStockQuote = async () => ({
        name: '贵州茅台',
        price: 1337.05,
        percent: 0.61,
        hy: [{ name: '贵州板块', percent: 0.54 }],
      });
      flowModule.fetchStockAnalysisGroups = async () => [
        { name: '综合评分(多维度)', msgs: ['综合:96.01'] },
      ];

      const d = await fund.loadStockDetail('sh600519');
      assert.strictEqual(d.code, 'sh600519');
      assert.strictEqual(d.name, '贵州茅台');
      assert.strictEqual(d.price, 1337.05, '现价应透传');
      assert.strictEqual(d.percent, 0.61, '涨跌幅应透传');
      assert.strictEqual(d.mainFlow.main.length, 2);
      assert.strictEqual(d.sectors.length, 1);
      assert.strictEqual(d.analysis.length, 1, '分析结论应为结构化分组数组');
      assert.strictEqual(d.analysis[0].name, '综合评分(多维度)');
      assert.deepStrictEqual(d.analysis[0].msgs, ['综合:96.01']);
    });

    it('任一子请求失败只丢该字段，其余照常返回', async () => {
      flowModule.fetchStockMainFlow = async () => null;
      flowModule.fetchStockQuote = async () => {
        throw new Error('boom');
      };
      flowModule.fetchStockAnalysisGroups = async () => [];

      const d = await fund.loadStockDetail('sh600519');
      assert.strictEqual(d.code, 'sh600519');
      assert.strictEqual(d.mainFlow, null);
      assert.deepStrictEqual(d.sectors, []);
      assert.deepStrictEqual(d.analysis, [], '分析失败应为空数组而非 undefined');
      assert.strictEqual(d.name, '', 'quote 失败时名称为空串而非 undefined');
      assert.strictEqual(d.price, 0, 'quote 失败时现价为 0 而非 undefined');
      assert.strictEqual(d.percent, 0);
    });

    it('非 A 股代码直接返回空详情，不发请求', async () => {
      let called = false;
      flowModule.fetchStockMainFlow = async () => {
        called = true;
        return null;
      };
      const d = await fund.loadStockDetail('hk00700');
      assert.strictEqual(called, false);
      assert.strictEqual(d.code, 'hk00700');
      assert.strictEqual(d.mainFlow, null);
    });
  });
});

describe('东财 secid 转换 toSecid', () => {
  it('沪市 → 1.', () => {
    assert.strictEqual(em.toSecid('sh600519'), '1.600519');
    assert.strictEqual(em.toSecid('SH600519'), '1.600519');
  });

  it('深市/创业板/科创板 → 0.', () => {
    assert.strictEqual(em.toSecid('sz000001'), '0.000001');
    assert.strictEqual(em.toSecid('sz300750'), '0.300750');
    assert.strictEqual(em.toSecid('sh688981'), '1.688981');
  });

  it('指数 nf_ 前缀等非法输入返回 null', () => {
    assert.strictEqual(em.toSecid('nf_IF'), null);
    assert.strictEqual(em.toSecid(''), null);
    assert.strictEqual(em.toSecid('hk00700'), null);
  });
});

describe('东财行业资金流解析 parseEastIndustryFlow', () => {
  const PAYLOAD = {
    rc: 0,
    data: {
      total: 496,
      diff: [
        { f12: 'BK1592', f14: '通信线缆及配套', f62: 2646652752.0, f184: 10.91 },
        { f12: 'BK0448', f14: '通信设备', f62: 2624345088.0, f184: 3.26 },
        { f12: 'BK1215', f14: '通信', f62: -100.5, f184: -0.5 },
      ],
    },
  };

  it('映射 code/name/amount/ratio 字段', () => {
    const rows = em.parseEastIndustryFlow(PAYLOAD);
    assert.strictEqual(rows.length, 3);
    assert.deepStrictEqual(rows[0], {
      code: 'BK1592',
      name: '通信线缆及配套',
      amount: 2646652752.0,
      ratio: 10.91,
    });
  });

  it('空/异常入参返回空数组', () => {
    assert.deepStrictEqual(em.parseEastIndustryFlow(null), []);
    assert.deepStrictEqual(em.parseEastIndustryFlow({ data: null }), []);
    assert.deepStrictEqual(em.parseEastIndustryFlow({ data: { diff: 'bad' } }), []);
  });

  it('fetchEastIndustryFlow 成功时返回解析结果', async () => {
    axios.get = async () => ({ status: 200, data: PAYLOAD });
    const rows = await em.fetchEastIndustryFlow();
    assert.strictEqual(rows.length, 3);
  });

  it('fetchEastIndustryFlow 失败时返回空数组', async () => {
    axios.get = async () => {
      throw timeoutError();
    };
    assert.deepStrictEqual(await em.fetchEastIndustryFlow(), []);
  });
});

describe('东财个股当日主力净流入 fetchEastStockMainFlow', () => {
  const PAYLOAD = {
    data: { klines: ['2026-10-19,384310560.0,-317440.0,-383993120.0,158828928.0,225481632.0'] },
  };

  it('取 kline 第二段（主力净流入）', async () => {
    axios.get = async () => ({ status: 200, data: PAYLOAD });
    assert.strictEqual(await em.fetchEastStockMainFlow('sh600519'), 384310560);
  });

  it('失败时返回 null', async () => {
    axios.get = async () => {
      throw timeoutError();
    };
    assert.strictEqual(await em.fetchEastStockMainFlow('sh600519'), null);
  });

  it('secid 非法时直接返回 null 不发请求', async () => {
    let called = false;
    axios.get = async () => {
      called = true;
      return { status: 200, data: PAYLOAD };
    };
    assert.strictEqual(await em.fetchEastStockMainFlow('hk00700'), null);
    assert.strictEqual(called, false, '非法 secid 不应发请求');
  });
});
