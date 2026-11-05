/**
 * AI 分析股票的取数链路测试：
 * 1) 搜狐 JSONP 原文 → 干净 CSV（A 股分支此前直接把 JSONP + GBK 乱码塞给模型）
 * 2) 韭研请求超时后应重试（接口实测 0.7s~25.7s 剧烈波动，15s 超时经常触发）
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

const vscodeMockPath = path.join(__dirname, 'helpers', 'vscode-mock.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return vscodeMockPath;
  return origResolve.call(this, request, ...args);
};

const { parseSohuQfqToCsv, fetchRecentQfqTradeDataForAi } = require('../out/shared/aiStockHistoryData');

/** 搜狐 hisHq 真实 JSONP 片段（字段：日期,开盘,收盘,涨跌额,涨跌幅,最低,最高,成交量,成交额,换手率,振幅） */
const SOHU_JSONP =
  'historySearchHandler([{"status":0,"hq":[["2026-10-16","1311.57","1329.00","16.03","1.22%","1301.68","1329.88","38502","507552.00","0.31%","20.00"],["2026-10-15","1286.00","1312.97","26.97","2.10%","1282.00","1317.76","57677","753770.00","0.46%","21.00"]],"code":"cn_600519","stat":["�ۼ�:","2026-07-20��2026-10-16","76.00","6.07%"]}])';

describe('搜狐 JSONP → CSV 清洗', () => {
  it('输出 CSV 表头与数据行，不再包含 JSONP 包装', () => {
    const csv = parseSohuQfqToCsv(SOHU_JSONP);
    const lines = csv.split('\n');
    assert.strictEqual(lines[0], '日期,开盘,收盘,涨跌幅,最低,最高,成交量(手),成交额(万)');
    assert.strictEqual(lines[1], '2026-10-16,1311.57,1329.00,1.22%,1301.68,1329.88,38502,507552.00');
    assert.strictEqual(lines[2], '2026-10-15,1286.00,1312.97,2.10%,1282.00,1317.76,57677,753770.00');
  });

  it('丢弃 stat 字段（该处为 GBK 乱码，会污染模型输入）', () => {
    const csv = parseSohuQfqToCsv(SOHU_JSONP);
    assert.ok(!csv.includes('historySearchHandler'), '不应含 JSONP 包装');
    assert.ok(!csv.includes('stat'), '不应含 stat 字段');
    assert.ok(!csv.includes('�'), '不应含解码失败的乱码');
  });

  it('非法输入返回空串而不是抛异常', () => {
    assert.strictEqual(parseSohuQfqToCsv(''), '');
    assert.strictEqual(parseSohuQfqToCsv('not jsonp'), '');
    assert.strictEqual(parseSohuQfqToCsv('historySearchHandler([{"status":1,"hq":[]}])'), '');
  });

  it('A 股分支最终产出 CSV（fetchRecentQfqTradeDataForAi）', async () => {
    const { text } = await fetchRecentQfqTradeDataForAi('sh600519', '1w');
    if (!text) return; // 网络不可用时跳过，不在单测里依赖外网
    assert.ok(text.startsWith('日期,开盘,收盘'), `应为 CSV，实际开头：${text.slice(0, 40)}`);
    assert.ok(!text.includes('historySearchHandler'), '不应把 JSONP 原文交给模型');
  });
});

describe('韭研请求超时重试', () => {
  const axios = require('axios');
  const originalPost = axios.post;
  afterEach(() => {
    axios.post = originalPost;
  });

  const okResult = {
    status: 200,
    data: { errCode: '0', data: { result: [{ article_id: 'a1', is_top: 0, title: '标题', content: '', create_time: '2026-10-19 09:00:00', stock_list: [] }] } },
  };

  it('首次超时后应自动重试并拿到数据', async () => {
    const { fetchJYGCommunityNews } = require('../out/webview/jiuyangongshe-news');
    let calls = 0;
    axios.post = async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('timeout of 15000ms exceeded');
        err.code = 'ECONNABORTED';
        throw err;
      }
      return okResult;
    };

    const list = await fetchJYGCommunityNews(5);
    assert.strictEqual(calls, 2, `超时后应重试一次，实际请求 ${calls} 次`);
    assert.strictEqual(list.length, 1, '重试成功后应返回数据');
  });

  it('持续失败时返回空数组而不是抛异常', async () => {
    const { fetchJYGCommunityNews } = require('../out/webview/jiuyangongshe-news');
    axios.post = async () => {
      const err = new Error('timeout of 15000ms exceeded');
      err.code = 'ECONNABORTED';
      throw err;
    };
    const list = await fetchJYGCommunityNews(5);
    assert.deepStrictEqual(list, []);
  });
});

describe('韭研新闻附录 buildJygNewsAppendix', () => {
  it('有条目 → 关键词标注 + 逐条 [时间] 标题 + warn_words/正文摘要', () => {
    const { buildJygNewsAppendix } = require('../out/webview/jiuyangongshe-news');
    const text = buildJygNewsAppendix('贵州茅台', [
      { create_time: '2026-11-04 09:30:00', title: '公告A', content: 'x'.repeat(400), warn_words: '减持' },
      { title: '公告B', content: '短内容' },
    ]);
    assert.ok(text.includes('韭研公社该股新闻（关键词：贵州茅台）'), text);
    assert.ok(text.includes('[2026-11-04 09:30:00] 公告A'), text);
    assert.ok(text.includes('warn_words: 减持'), text);
    assert.ok(text.includes('…'), '超长正文应截断');
    assert.ok(text.includes('公告B'), text);
  });

  it('空/非数组返回空串', () => {
    const { buildJygNewsAppendix } = require('../out/webview/jiuyangongshe-news');
    assert.strictEqual(buildJygNewsAppendix('x', []), '');
    assert.strictEqual(buildJygNewsAppendix('x', null), '');
  });
});
