/**
 * 资讯模块（韭研公社社区流）数据源转换测试。
 * 数据来自 /article/community 接口（全市场文章，时间倒序），转换为树节点数据。
 */
const assert = require('assert');
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
