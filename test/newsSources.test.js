/**
 * 登录后资讯按来源分组展示（方案 A）测试。
 *
 * 官网 pages/news/news 的 4 个分段各自对应独立接口；本组用例锁定：
 * - NEWS_SOURCES 元数据与请求 body（现有实现把 {} 发给所有接口，投资日历根本没取）
 * - 四源拉取的降级、分组归一化与 URL 分流
 * - NewsService/NewsProvider 的两级树与分级 TTL
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

const xxj = require('../out/explorer/xxjwxcNews');
const { NewsService, NewsSourceGroupTreeItem, NewsTreeItem } = require('../out/explorer/newsService');
const { NewsProvider } = require('../out/explorer/newsProvider');
const jyg = require('../out/webview/jiuyangongshe-news');
const shared = require('../out/shared/xxjwxcData');

function makeStore(session) {
  const map = new Map();
  if (session) map.set('leek-fund.ljgxSession', session);
  return {
    get: (key) => map.get(key),
    update: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
  };
}

const SESSION = {
  sessionId: 'tok',
  openId: 'o1',
  overdueTime: 0,
  userName: '金玉',
  avatarUrl: '',
  did: 'd1',
};

/** 成功响应（list 由调用方给出） */
function ok(list) {
  return { status: 200, data: { state: true, error: 'normal', data: { list } } };
}

describe('资讯来源元数据 NEWS_SOURCES', () => {
  it('4 个来源、顺序与标签与官网分段一致', () => {
    assert.deepStrictEqual(
      xxj.NEWS_SOURCES.map((s) => s.key),
      ['hot', 'flash', 'global', 'calendar']
    );
    assert.deepStrictEqual(
      xxj.NEWS_SOURCES.map((s) => s.label),
      ['热点快讯', '今日快讯', '全球新闻', '投资日历']
    );
  });

  it('每个来源的 endpoint / body / pageUrl 正确，投资日历靠 tag=1 分流', () => {
    const byKey = Object.fromEntries(xxj.NEWS_SOURCES.map((s) => [s.key, s]));
    assert.strictEqual(byKey.hot.endpoint, '/shares.get_glh_tm');
    assert.strictEqual(byKey.flash.endpoint, '/shares.get_hejjw');
    assert.strictEqual(byKey.global.endpoint, '/shares.get_xzw');
    assert.strictEqual(byKey.calendar.endpoint, '/shares.get_xzw');
    assert.deepStrictEqual(byKey.flash.body, { dayStr: '' });
    assert.deepStrictEqual(byKey.global.body, { start: '', end: '', tag: '' });
    assert.deepStrictEqual(byKey.calendar.body, { start: '', end: '', tag: '1' });
    assert.ok(byKey.calendar.pageUrl.includes('pages/article/tzrl'));
    assert.ok(byKey.hot.pageUrl.includes('pages/article/jdkp'));
  });

  it('快讯类 30s TTL，新闻/日历 5min TTL', () => {
    const byKey = Object.fromEntries(xxj.NEWS_SOURCES.map((s) => [s.key, s]));
    assert.strictEqual(byKey.hot.ttlMs, 30 * 1000);
    assert.strictEqual(byKey.flash.ttlMs, 30 * 1000);
    assert.strictEqual(byKey.global.ttlMs, 5 * 60 * 1000);
    assert.strictEqual(byKey.calendar.ttlMs, 5 * 60 * 1000);
  });

  it('resolveNewsSourceUrl 按来源分流，未知来源回退资讯首页', () => {
    assert.ok(xxj.resolveNewsSourceUrl('flash').includes('pages/article/hejjw'));
    assert.ok(xxj.resolveNewsSourceUrl('calendar').includes('pages/article/tzrl'));
    assert.ok(xxj.resolveNewsSourceUrl(undefined).includes('pages/news/news'));
    assert.ok(xxj.resolveNewsSourceUrl('jyg').includes('pages/news/news'));
  });
});

describe('四源拉取 fetchXxjSource', () => {
  it('按元数据发 POST：URL、body、user-token', async () => {
    const captured = [];
    const axios = {
      post: async (url, body, config) => {
        captured.push({ url, body, token: config.headers['user-token'] });
        return ok([{ tmStr: '14:20', title: 'T', content: 'C' }]);
      },
    };
    for (const meta of xxj.NEWS_SOURCES) {
      const rows = await xxj.fetchXxjSource(meta.key, { store: makeStore(SESSION), axios });
      assert.strictEqual(rows.length, 1, `${meta.key} 应解析出 1 条`);
    }
    assert.strictEqual(captured.length, 4);
    xxj.NEWS_SOURCES.forEach((meta, i) => {
      assert.ok(captured[i].url.includes(meta.endpoint.slice(1)), `${meta.key} URL`);
      assert.deepStrictEqual(captured[i].body, meta.body, `${meta.key} body`);
      assert.strictEqual(captured[i].token, 'tok');
    });
  });

  it('未登录不发请求返回空数组', async () => {
    let calls = 0;
    const rows = await xxj.fetchXxjSource('flash', {
      store: makeStore(null),
      axios: { post: async () => { calls += 1; return ok([]); } },
    });
    assert.deepStrictEqual(rows, []);
    assert.strictEqual(calls, 0);
  });

  it('1018 / 网络失败 / 载荷非数组一律返回 null（供分组标记失败）', async () => {
    const store = makeStore(SESSION);
    const cases = [
      { status: 200, data: { state: false, code: 1018 } },
      { status: 200, data: { state: true, data: { list: 'bad' } } },
    ];
    for (const response of cases) {
      assert.strictEqual(await xxj.fetchXxjSource('global', { store, axios: { post: async () => response } }), null);
    }
    assert.strictEqual(
      await xxj.fetchXxjSource('global', { store, axios: { post: async () => { throw new Error('boom'); } } }),
      null
    );
  });
});

describe('分组归一化 buildXxjSourceGroups', () => {
  it('四组各带 source、条数、按来源的原文 URL；null 表示失败', () => {
    const groups = xxj.buildXxjSourceGroups(
      {
        hot: [{ tmStr: '14:20', title: '异动A', content: '正文A' }],
        flash: [{ tmStr: '14:21', content: '快讯B' }],
        global: [{ tmStr: '14:22', title: '全球C', content: '正文C' }],
        calendar: null,
      },
      20
    );
    assert.strictEqual(groups.length, 4);
    assert.strictEqual(groups[0].label, '热点快讯');
    assert.strictEqual(groups[0].items[0].source, 'hot');
    assert.strictEqual(groups[1].items[0].title, '快讯B');
    assert.ok(groups[2].items[0].url.includes('pages/article/xzw'));
    assert.strictEqual(groups[3].failed, true, 'null 载荷应标记为失败');
    assert.deepStrictEqual(groups[3].items, []);
  });

  it('每组受 limit 截断，且先按时间倒序再截断', () => {
    const rows = [
      { tmStr: '09:00', content: '早' },
      { tmStr: '15:00', content: '晚' },
      { tmStr: '12:00', content: '中' },
    ];
    const groups = xxj.buildXxjSourceGroups({ hot: rows, flash: [], global: [], calendar: [] }, 2);
    assert.strictEqual(groups[0].items.length, 2);
    assert.strictEqual(groups[0].items[0].title, '晚', '应先排序再截断');
    assert.strictEqual(groups[0].items[1].title, '中');
  });

  it('异常输入不抛错，缺时间/正文的条目跳过', () => {
    const groups = xxj.buildXxjSourceGroups(
      { hot: [null, {}, { tmStr: '10:00', content: '有效' }], flash: 'bad' },
      20
    );
    assert.strictEqual(groups[0].items.length, 1);
    assert.strictEqual(groups[0].items[0].title, '有效');
    assert.deepStrictEqual(groups[1].items, []);
    assert.deepStrictEqual(xxj.buildXxjSourceGroups(null, 20), []);
  });
});

describe('NewsService 四源分组与分级 TTL', () => {
  const orig = {
    has: xxj.hasXxjSession,
    fetch: xxj.fetchXxjSource,
    jyg: jyg.fetchJYGCommunityNews,
    headline: shared.fetchHeadlines,
  };

  afterEach(() => {
    xxj.hasXxjSession = orig.has;
    xxj.fetchXxjSource = orig.fetch;
    jyg.fetchJYGCommunityNews = orig.jyg;
    shared.fetchHeadlines = orig.headline;
  });

  it('已登录 → 返回 4 个分组，不请求韭研/头条', async () => {
    let jygCalls = 0;
    xxj.hasXxjSession = () => true;
    xxj.fetchXxjSource = async () => [{ tmStr: '14:20', content: '内容' }];
    jyg.fetchJYGCommunityNews = async () => { jygCalls += 1; return []; };

    const groups = await new NewsService().getNewsGroups();
    assert.strictEqual(groups.length, 4);
    assert.strictEqual(jygCalls, 0, '登录后不应请求韭研');
    assert.strictEqual(groups[0].items.length, 1);
  });

  it('某来源失败 → 仅该组 failed，其余组照常展示', async () => {
    xxj.hasXxjSession = () => true;
    xxj.fetchXxjSource = async (key) => (key === 'calendar' ? null : [{ tmStr: '14:20', content: '内容' }]);

    const groups = await new NewsService().getNewsGroups();
    assert.strictEqual(groups.find((g) => g.key === 'calendar').failed, true);
    assert.strictEqual(groups.find((g) => g.key === 'hot').items.length, 1);
  });

  it('分级 TTL：二次调用不重拉未过期来源', async () => {
    const calls = [];
    xxj.hasXxjSession = () => true;
    xxj.fetchXxjSource = async (key) => {
      calls.push(key);
      return [{ tmStr: '14:20', content: '内容' }];
    };

    const service = new NewsService();
    await service.getNewsGroups();
    assert.strictEqual(calls.length, 4);
    await service.getNewsGroups();
    assert.strictEqual(calls.length, 4, '30s/5min 内应命中缓存');
  });

  it('forceRefresh 清空分级缓存并全量重拉', async () => {
    const calls = [];
    xxj.hasXxjSession = () => true;
    xxj.fetchXxjSource = async (key) => {
      calls.push(key);
      return [{ tmStr: '14:20', content: '内容' }];
    };

    const service = new NewsService();
    await service.getNewsGroups();
    await service.forceRefreshGroups();
    assert.strictEqual(calls.length, 8, '手动刷新应重新拉 4 个来源');
  });

  it('未登录 → 返回空分组，旧扁平降级链路仍可用', async () => {
    xxj.hasXxjSession = () => false;
    jyg.fetchJYGCommunityNews = async () => [
      { article_id: 'a1', title: '韭研文章', content: '<p>x</p>', create_time: '2026-11-04 10:00:00', stock_list: [], user: {} },
    ];
    const service = new NewsService();
    assert.deepStrictEqual(await service.getNewsGroups(), []);
    const list = await service.getNewsList(10);
    assert.strictEqual(list[0].news.title, '韭研文章');
  });
});

describe('NewsProvider 两级树', () => {
  const orig = { has: xxj.hasXxjSession, fetch: xxj.fetchXxjSource };

  afterEach(() => {
    xxj.hasXxjSession = orig.has;
    xxj.fetchXxjSource = orig.fetch;
  });

  it('根节点为 4 个来源分组，分组下为资讯条目', async () => {
    xxj.hasXxjSession = () => true;
    xxj.fetchXxjSource = async () => [
      { tmStr: '14:20', content: '内容A' },
      { tmStr: '14:21', content: '内容B' },
    ];

    const provider = new NewsProvider();
    const roots = await provider.getChildren();
    assert.strictEqual(roots.length, 4);
    assert.ok(roots.every((n) => n instanceof NewsSourceGroupTreeItem));
    assert.ok(roots[0].label.includes('热点快讯'));

    const children = await provider.getChildren(roots[0]);
    assert.strictEqual(children.length, 2);
    assert.ok(children.every((n) => n instanceof NewsTreeItem));
    assert.ok(children[0].news.source, '条目应带来源标识');
  });

  it('分组失败时显示失败占位且可点击重试', async () => {
    xxj.hasXxjSession = () => true;
    xxj.fetchXxjSource = async (key) => (key === 'hot' ? null : []);

    const provider = new NewsProvider();
    const roots = await provider.getChildren();
    const hot = roots.find((n) => n.group.key === 'hot');
    assert.ok(hot.description.includes('失败'), `实际 description: ${hot.description}`);
    const children = await provider.getChildren(hot);
    assert.strictEqual(children.length, 1);
    assert.ok(children[0].label.includes('重试'));
    assert.strictEqual(children[0].command.command, 'leek-fund.refreshFollow');
  });
});

describe('AI 资讯附录 buildXxjNewsAppendix / fetchXxjNewsGroupsForAi', () => {
  it('仅保留有条目的分组，按【标签】分组，条目为 [时间] 标题 —— 摘要', () => {
    const groups = [
      {
        key: 'hot',
        label: '热点快讯',
        failed: false,
        updatedAt: 0,
        items: [
          { id: 'h0', url: '', time: 0, timeLabel: '14:20', title: '半导体异动', summary: '板块大涨', stocksLabel: '', source: 'hot' },
        ],
      },
      { key: 'global', label: '全球新闻', failed: false, updatedAt: 0, items: [] },
    ];
    const text = xxj.buildXxjNewsAppendix(groups);
    assert.ok(text.includes('【热点快讯】'), text);
    assert.ok(text.includes('[14:20] 半导体异动'), text);
    assert.ok(text.includes('板块大涨'), text);
    assert.ok(!text.includes('【全球新闻】'), '空分组不应出现');
    assert.ok(text.includes('资讯」栏分类新闻'), '应标注来源为资讯栏分类信息');
  });

  it('空/异常输入返回空串', () => {
    assert.strictEqual(xxj.buildXxjNewsAppendix([]), '');
    assert.strictEqual(xxj.buildXxjNewsAppendix(null), '');
    assert.strictEqual(
      xxj.buildXxjNewsAppendix([{ key: 'hot', label: 'x', items: [], failed: false, updatedAt: 0 }]),
      ''
    );
  });

  it('未登录 fetchXxjNewsGroupsForAi 直接返回 []（不发请求）', async () => {
    let calls = 0;
    const groups = await xxj.fetchXxjNewsGroupsForAi(8, {
      store: makeStore(null),
      axios: { post: async () => { calls += 1; return ok([]); } },
    });
    assert.deepStrictEqual(groups, []);
    assert.strictEqual(calls, 0, '未登录不应发请求');
  });

  it('登录后聚合四来源为分组', async () => {
    const groups = await xxj.fetchXxjNewsGroupsForAi(8, {
      store: makeStore(SESSION),
      axios: { post: async () => ok([{ tmStr: '14:20', title: 'A', content: 'aa' }]) },
    });
    assert.strictEqual(groups.length, 4);
    assert.strictEqual(groups[0].items[0].title, 'A');
  });
});
