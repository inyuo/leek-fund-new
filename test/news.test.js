/**
 * 资讯模块（韭研公社社区流）数据源转换测试。
 * 数据来自 /article/community 接口（全市场文章，时间倒序），转换为树节点数据。
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

// newsService / NewsTreeItem 依赖 vscode 的 TreeItem，测试环境注入最小 mock
const vscodeMockPath = path.join(__dirname, 'helpers', 'vscode-mock.js');
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return vscodeMockPath;
  return origResolveFilename.call(this, request, ...args);
};

const { buildJYGNewsItems } = require('../out/explorer/jygNews');

/** 构造一条社区接口返回的原始文章 */
function makeArticle(id, title, opts = {}) {
  const {
    createTime = '2026-10-12 10:05:03',
    content = '<p>正文内容</p>',
    stocks = [],
    isTop = 0,
  } = opts;
  return {
    article_id: id,
    is_top: isTop,
    title,
    subtitle: '',
    content,
    create_time: createTime,
    warn_words: null,
    stock_list: stocks,
    user: { nickname: '韭菜盒子' },
  };
}

describe('资讯树节点转换 buildJYGNewsItems', () => {
  it('生成节点，带 id、标题与原文链接', () => {
    const items = buildJYGNewsItems([makeArticle('jyebflll98', '金丹科技涨价函')]);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].id, 'jyebflll98');
    assert.strictEqual(items[0].url, 'https://www.jiuyangongshe.com/a/jyebflll98');
    assert.strictEqual(items[0].title, '金丹科技涨价函');
  });

  it('正文去除 HTML 标签并压缩空白', () => {
    const items = buildJYGNewsItems([
      makeArticle('1', '标题', { content: '<p>第一段<br/>换行&nbsp;了</p><b>加粗</b>' }),
    ]);
    const s = items[0].summary;
    assert.ok(!s.includes('<'), `不应包含标签，实际：${s}`);
    assert.ok(s.includes('第一段') && s.includes('加粗'), `应保留正文，实际：${s}`);
    assert.ok(!/\s{2,}/.test(s), `应压缩空白，实际：${s}`);
  });

  it('标题与正文的 HTML 实体（含无分号写法）一并清理', () => {
    const items = buildJYGNewsItems([
      makeArticle('1', '排队&nbsp;等票&nbsp;', { content: 'A&nbspB&nbsp;C&amp;D' }),
    ]);
    assert.ok(!items[0].title.includes('&'), `标题不应残留实体，实际：${items[0].title}`);
    assert.strictEqual(items[0].summary, 'A B C&D');
  });

  it('时间格式化为 MM-DD HH:mm', () => {
    const items = buildJYGNewsItems([makeArticle('1', '标题', { createTime: '2026-10-12 09:45:00' })]);
    assert.strictEqual(items[0].timeLabel, '10-12 09:45');
  });

  it('关联股票取名称，超过 3 个折叠为 +N', () => {
    const items = buildJYGNewsItems([
      makeArticle('1', '标题', {
        stocks: [
          { stock_id: 'a', code: 'sz300829', name: '金丹科技' },
          { stock_id: 'b', code: 'sh688517', name: '金冠电气' },
        ],
      }),
      makeArticle('2', '标题2', {
        stocks: ['古越龙山', '会稽山', '轻纺城', '广东明珠'].map((name, i) => ({
          stock_id: String(i),
          code: `sh60000${i}`,
          name,
        })),
      }),
    ]);
    assert.strictEqual(items[0].stocksLabel, '金丹科技 金冠电气');
    assert.strictEqual(items[1].stocksLabel, '古越龙山 会稽山 轻纺城 +1');
  });

  it('过滤官方置顶帖（is_top=1）', () => {
    const items = buildJYGNewsItems([
      makeArticle('top1', '站规合集', { isTop: 1 }),
      makeArticle('normal', '正常文章'),
    ]);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].id, 'normal');
  });

  it('跳过没有 article_id 的条目，保留有效条目', () => {
    const items = buildJYGNewsItems([
      { title: '无 id 文章', content: '', create_time: '2026-10-12 10:00:00' },
      makeArticle('7', '有效文章'),
    ]);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].id, '7');
  });

  it('按 limit 截断', () => {
    const list = Array.from({ length: 5 }, (_, i) => makeArticle(String(i), `消息${i}`));
    assert.strictEqual(buildJYGNewsItems(list, 3).length, 3);
    assert.strictEqual(buildJYGNewsItems(list, 100).length, 5);
  });
});

describe('资讯刷新（缓存与强制刷新）', () => {
  const { NewsService } = require('../out/explorer/newsService');
  const newsModule = require('../out/webview/jiuyangongshe-news');
  const originalFetch = newsModule.fetchJYGCommunityNews;

  /** 可控的接口 mock：每次调用返回一批文章并计数 */
  function mockFetch(counter) {
    newsModule.fetchJYGCommunityNews = async (limit) => {
      counter.calls += 1;
      return [makeArticle(`id-${counter.calls}`, `第${counter.calls}批消息`)];
    };
  }

  afterEach(() => {
    newsModule.fetchJYGCommunityNews = originalFetch;
  });

  it('缓存期内重复读取只请求一次接口', async () => {
    const counter = { calls: 0 };
    mockFetch(counter);
    const service = new NewsService();

    await service.getNewsList();
    await service.getNewsList();
    assert.strictEqual(counter.calls, 1, `缓存期内应只请求 1 次，实际 ${counter.calls} 次`);
  });

  it('手动刷新必须绕过缓存，重新拉取并返回新内容', async () => {
    const counter = { calls: 0 };
    mockFetch(counter);
    const service = new NewsService();

    const first = await service.getNewsList();
    assert.strictEqual(first[0].news.title, '第1批消息');

    // 用户点击「刷新资讯」：必须重新请求，而不是返回 30s 内的旧缓存
    const refreshed = await service.forceRefresh();
    assert.strictEqual(counter.calls, 2, `点刷新后应重新请求接口，实际仍为 ${counter.calls} 次`);
    assert.strictEqual(refreshed[0].news.title, '第2批消息', '刷新后应拿到新一批内容');

    // 刷新后的结果也应成为新缓存
    const cached = await service.getNewsList();
    assert.strictEqual(cached[0].news.title, '第2批消息');
    assert.strictEqual(counter.calls, 2, '刷新结果应被缓存，不应再次请求');
  });
});

describe('资讯降级：xxjwxc 财经头条转换', () => {
  const { buildHeadlineNewsItems } = require('../out/explorer/headlineNews');

  it('把标题数组转成资讯条目', () => {
    const items = buildHeadlineNewsItems(['头条A', '头条B'], 10);
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].title, '头条A');
    assert.ok(items[0].id, '必须有 id');
    assert.ok(items[0].url, '必须有 url 供点击打开');
    assert.strictEqual(items[0].stocksLabel, '', '头条无关联股票');
    assert.strictEqual(typeof items[0].time, 'number');
  });

  it('跳过空标题并按 limit 截断', () => {
    const items = buildHeadlineNewsItems(['', '   ', '有效标题', '另一条'], 1);
    assert.strictEqual(items.length, 1, '空标题应被跳过，且受 limit 约束');
    assert.strictEqual(items[0].title, '有效标题');
  });

  it('id 在同一批内唯一（否则树节点身份会互相覆盖）', () => {
    const items = buildHeadlineNewsItems(['甲', '乙', '丙'], 10);
    const ids = items.map((i) => i.id);
    assert.strictEqual(new Set(ids).size, ids.length, `id 重复：${ids.join(',')}`);
  });

  it('空/异常输入返回空数组', () => {
    assert.deepStrictEqual(buildHeadlineNewsItems(null, 10), []);
    assert.deepStrictEqual(buildHeadlineNewsItems([], 10), []);
    assert.deepStrictEqual(buildHeadlineNewsItems('bad', 10), []);
  });
});

describe('资讯降级触发：韭研失败时回退头条', () => {
  const { NewsService } = require('../out/explorer/newsService');
  const newsModule = require('../out/webview/jiuyangongshe-news');
  const xxjModule = require('../out/shared/xxjwxcData');
  const originalJyg = newsModule.fetchJYGCommunityNews;
  const originalHeadline = xxjModule.fetchHeadlines;

  afterEach(() => {
    newsModule.fetchJYGCommunityNews = originalJyg;
    xxjModule.fetchHeadlines = originalHeadline;
  });

  it('韭研返回空时回退到财经头条', async () => {
    newsModule.fetchJYGCommunityNews = async () => [];
    xxjModule.fetchHeadlines = async () => ['头条A', '头条B'];

    const list = await new NewsService().getNewsList(5);
    assert.strictEqual(list.length, 2, '应展示头条而不是空列表');
    assert.strictEqual(list[0].news.title, '头条A');
  });

  it('韭研抛错时同样回退', async () => {
    newsModule.fetchJYGCommunityNews = async () => {
      throw new Error('timeout of 30000ms exceeded');
    };
    xxjModule.fetchHeadlines = async () => ['头条X'];

    const list = await new NewsService().getNewsList(5);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].news.title, '头条X');
  });

  it('两个源都失败时返回空数组而不抛异常', async () => {
    newsModule.fetchJYGCommunityNews = async () => {
      throw new Error('boom');
    };
    xxjModule.fetchHeadlines = async () => {
      throw new Error('boom2');
    };

    const list = await new NewsService().getNewsList(5);
    assert.deepStrictEqual(list, []);
  });

  it('韭研正常时不调用头条源（避免多余请求）', async () => {
    let headlineCalls = 0;
    newsModule.fetchJYGCommunityNews = async () => [makeArticle('a1', '韭研文章')];
    xxjModule.fetchHeadlines = async () => {
      headlineCalls += 1;
      return ['不该被调用'];
    };

    const list = await new NewsService().getNewsList(5);
    assert.strictEqual(list[0].news.title, '韭研文章');
    assert.strictEqual(headlineCalls, 0, '主源正常时不应触发降级');
  });
});
