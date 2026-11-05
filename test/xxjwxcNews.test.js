/**
 * xxjwxc 官网资讯源测试（登录后资讯切换）。
 *
 * 数据源（2026-11-04 实测契约）：
 * - POST /shares.get_hejjw  7×24 快讯流 [{tmStr:"14:20", content:"..."}]，需登录
 * - POST /shares.get_xzw    新闻资讯 [{tmStr, title, content}]，需登录
 * 无 token 响应 {state:false, code:1018}；登录态来自 ljgxData 会话。
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

const {
  buildXxjNewsItems,
  hasXxjSession,
  fetchXxjFlash,
  fetchXxjNews,
} = require('../out/explorer/xxjwxcNews');

function makeStore(session) {
  const map = new Map();
  if (session) map.set('leek-fund.ljgxSession', session);
  return {
    get: (key) => map.get(key),
    update: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
    _map: map,
  };
}

const SESSION = { sessionId: 'tok', openId: 'o1', overdueTime: 0, userName: '金玉', avatarUrl: '', did: 'd1' };

describe('xxjwxc 资讯条目合并 buildXxjNewsItems', () => {
  it('快讯 + 新闻合并并按时间倒序', () => {
    const items = buildXxjNewsItems(
      [{ tmStr: '14:20', content: '快讯内容A' }, { tmStr: '09:30', content: '快讯内容B' }],
      [{ tmStr: '14:33', title: '新闻标题C', content: '新闻正文C' }],
      50
    );
    assert.strictEqual(items.length, 3);
    assert.strictEqual(items[0].title, '新闻标题C');
    assert.strictEqual(items[1].title, '快讯内容A');
    assert.strictEqual(items[2].title, '快讯内容B');
  });

  it('快讯条目映射：timeLabel=tmStr、title=content、url 指向官网资讯页', () => {
    const items = buildXxjNewsItems([{ tmStr: '14:20', content: '中韩半导体ETF涨超9%' }], [], 50);
    assert.strictEqual(items[0].timeLabel, '14:20');
    assert.strictEqual(items[0].title, '中韩半导体ETF涨超9%');
    assert.ok(items[0].url.startsWith('https://www.xxjwxc.cn/webshares/'), `url 应指向官网，实际 ${items[0].url}`);
    assert.ok(items[0].id, '必须有 id');
  });

  it('新闻条目：title 缺失时用 content 兜底，summary 取正文', () => {
    const items = buildXxjNewsItems(
      [],
      [
        { tmStr: '14:32', title: '', content: '诺和诺德：全年展望假设' },
        { tmStr: '14:33', title: '速卖通欧盟本地成交占比突破60%', content: '阿里旗下速卖通海外双11数据' },
      ],
      50
    );
    assert.strictEqual(items[0].title, '速卖通欧盟本地成交占比突破60%');
    assert.strictEqual(items[1].title, '诺和诺德：全年展望假设');
    assert.strictEqual(items[0].summary, '阿里旗下速卖通海外双11数据');
  });

  it('同批 id 唯一且受 limit 截断', () => {
    const flash = Array.from({ length: 5 }, (_, i) => ({ tmStr: `1${i}:00`, content: `快讯${i}` }));
    const news = Array.from({ length: 5 }, (_, i) => ({ tmStr: `0${i}:00`, title: `新闻${i}`, content: '' }));
    const items = buildXxjNewsItems(flash, news, 6);
    assert.strictEqual(items.length, 6);
    const ids = items.map((i) => i.id);
    assert.strictEqual(new Set(ids).size, ids.length, `id 重复：${ids.join(',')}`);
  });

  it('空/异常输入返回空数组不抛错', () => {
    assert.deepStrictEqual(buildXxjNewsItems(null, null, 50), []);
    assert.deepStrictEqual(buildXxjNewsItems([], [], 50), []);
    assert.deepStrictEqual(buildXxjNewsItems('bad', 42, 50), []);
  });

  it('tmStr 缺失的条目跳过而不是崩溃', () => {
    const items = buildXxjNewsItems([{ content: '无时间' }, { tmStr: '10:00', content: '正常' }], [], 50);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].title, '正常');
  });
});

describe('登录态判定 hasXxjSession', () => {
  it('store 有会话 → true', () => {
    assert.strictEqual(hasXxjSession({ store: makeStore(SESSION) }), true);
  });

  it('store 无会话 → false', () => {
    assert.strictEqual(hasXxjSession({ store: makeStore(null) }), false);
  });

  it('未传 store 且无 vscode context → false 不抛错', () => {
    assert.strictEqual(hasXxjSession(), false);
  });
});

describe('xxjwxc 资讯拉取（axios 注入）', () => {
  function axiosWith(data) {
    return { post: async () => ({ status: 200, data }) };
  }

  it('fetchXxjFlash 解析 hejjw 载荷并带 user-token', async () => {
    let captured = null;
    const axios = {
      post: async (url, body, config) => {
        captured = { url, config };
        return { status: 200, data: { state: true, error: 'normal', data: { list: [{ tmStr: '14:20', content: '快讯A' }] } } };
      },
    };
    const items = await fetchXxjFlash({ store: makeStore(SESSION), axios });
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].content, '快讯A');
    assert.strictEqual(captured.config.headers['user-token'], 'tok');
    assert.ok(captured.url.includes('shares.get_hejjw'));
  });

  it('fetchXxjNews 解析 xzw 载荷', async () => {
    const items = await fetchXxjNews({
      store: makeStore(SESSION),
      axios: axiosWith({ state: true, error: 'normal', data: { list: [{ tmStr: '14:33', title: 'T', content: 'C' }] } }),
    });
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].title, 'T');
  });

  it('1018/网络失败返回空数组不抛错', async () => {
    assert.deepStrictEqual(
      await fetchXxjFlash({ store: makeStore(SESSION), axios: axiosWith({ state: false, code: 1018, error: 'x' }) }),
      []
    );
    assert.deepStrictEqual(
      await fetchXxjFlash({ store: makeStore(SESSION), axios: { post: async () => { throw new Error('boom'); } } }),
      []
    );
  });
});

describe('资讯切换：登录后走 xxjwxc 源', () => {
  const { NewsService } = require('../out/explorer/newsService');
  const xxjModule = require('../out/explorer/xxjwxcNews');
  const newsModule = require('../out/webview/jiuyangongshe-news');
  const xxjShared = require('../out/shared/xxjwxcData');
  const orig = {
    has: xxjModule.hasXxjSession,
    flash: xxjModule.fetchXxjFlash,
    news: xxjModule.fetchXxjNews,
    jyg: newsModule.fetchJYGCommunityNews,
    headline: xxjShared.fetchHeadlines,
  };

  afterEach(() => {
    xxjModule.hasXxjSession = orig.has;
    xxjModule.fetchXxjFlash = orig.flash;
    xxjModule.fetchXxjNews = orig.news;
    newsModule.fetchJYGCommunityNews = orig.jyg;
    xxjShared.fetchHeadlines = orig.headline;
  });

  it('已登录 → 主源 xxjwxc 快讯+新闻，不请求韭研', async () => {
    let jygCalls = 0;
    xxjModule.hasXxjSession = () => true;
    xxjModule.fetchXxjFlash = async () => [{ tmStr: '14:20', content: '登录态快讯' }];
    xxjModule.fetchXxjNews = async () => [{ tmStr: '14:10', title: '登录态新闻', content: '' }];
    newsModule.fetchJYGCommunityNews = async () => {
      jygCalls += 1;
      return [];
    };

    const list = await new NewsService().getNewsList(10);
    assert.strictEqual(jygCalls, 0, '登录后不应请求韭研');
    assert.strictEqual(list[0].news.title, '登录态快讯');
    assert.strictEqual(list[1].news.title, '登录态新闻');
  });

  it('已登录但 xxjwxc 全失败 → 降级韭研 → 头条', async () => {
    xxjModule.hasXxjSession = () => true;
    xxjModule.fetchXxjFlash = async () => [];
    xxjModule.fetchXxjNews = async () => [];
    newsModule.fetchJYGCommunityNews = async () => [];
    xxjShared.fetchHeadlines = async () => ['兜底头条'];

    const list = await new NewsService().getNewsList(10);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].news.title, '兜底头条');
  });

  it('未登录 → 维持韭研主源', async () => {
    xxjModule.hasXxjSession = () => false;
    newsModule.fetchJYGCommunityNews = async () => [
      { article_id: 'a1', title: '韭研文章', content: '<p>x</p>', create_time: '2026-11-04 10:00:00', stock_list: [], user: {} },
    ];

    const list = await new NewsService().getNewsList(10);
    assert.strictEqual(list[0].news.title, '韭研文章');
  });
});
