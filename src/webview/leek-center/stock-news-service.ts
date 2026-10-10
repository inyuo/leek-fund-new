import { Webview } from 'vscode';
import { fetchJYGNewsByCode, JYGArticleItem, resolveJYGStock } from '../jiuyangongshe-news';

/**
 * 前端消费的资讯条目。
 * 字段命名沿用旧快讯结构（created_at 为「秒级」时间戳），
 * 以便前端列表渲染逻辑无需改动。
 */
export interface StockNewsItem {
  id: string;
  title: string;
  summary: string;
  /** 秒级 Unix 时间戳 */
  created_at: number;
  warn_words: string | null;
  stocks: { code: string; name: string }[];
}

export interface StockNewsPayload {
  messages: StockNewsItem[];
  allDayMessages: StockNewsItem[];
  lastUpdate: number;
  /** 当前查询的股票，便于前端回显 */
  stock: { keyword: string; name: string; code: string } | null;
}

const EMPTY_PAYLOAD = (): StockNewsPayload => ({
  messages: [],
  allDayMessages: [],
  lastUpdate: Date.now(),
  stock: null,
});

/** 韭研 create_time 形如 "2026-10-09 09:25:22"，按东八区解析为秒级时间戳 */
function parseCreateTime(createTime?: string): number {
  if (!createTime) return 0;
  const ms = Date.parse(String(createTime).trim().replace(' ', 'T') + '+08:00');
  if (Number.isNaN(ms)) {
    const fallback = Date.parse(String(createTime).trim().replace(' ', 'T'));
    return Number.isNaN(fallback) ? 0 : Math.floor(fallback / 1000);
  }
  return Math.floor(ms / 1000);
}

function truncate(text: string, max = 500): string {
  const value = String(text || '');
  return value.length > max ? value.slice(0, max) + '…' : value;
}

function toNewsItem(item: JYGArticleItem): StockNewsItem {
  return {
    id: item.article_id || `${item.create_time}-${item.title}`,
    title: item.title || '无标题',
    summary: truncate(item.content),
    created_at: parseCreateTime(item.create_time),
    warn_words: item.warn_words ?? null,
    stocks: (item.stock_list || []).map((s) => ({ code: s.code, name: s.name })),
  };
}

/**
 * 资讯服务：数据源为韭研公社个股新闻。
 *
 * 注意：韭研公社只提供「按股票维度」的资讯查询，没有全市场快讯流，
 * 因此调用方必须传入股票名称或代码。
 */
export class StockNewsService {
  /** 最近一次成功查询的股票，供 AI 分析等无参场景复用 */
  private lastStockKeyword = '';

  constructor(private webview: Webview | null) {}

  /**
   * 拉取个股新闻。
   * @param stockKeyword 股票名称或代码，如「贵州茅台」/「sh600519」；为空时回退到上次查询的股票
   */
  public async fetchNewsData(stockKeyword?: string, limit = 30): Promise<StockNewsPayload> {
    const keyword = String(stockKeyword || this.lastStockKeyword || '').trim();
    if (!keyword) {
      return EMPTY_PAYLOAD();
    }

    const articles = await fetchJYGNewsByCode(keyword, limit, 0);
    if (!articles.length) {
      const stillEmpty = EMPTY_PAYLOAD();
      stillEmpty.stock = { keyword, name: '', code: '' };
      return stillEmpty;
    }

    this.lastStockKeyword = keyword;

    // 反查股票标准名称/代码，便于前端展示
    const ref = await resolveJYGStock(keyword).catch(() => null);
    const allDayMessages = articles.map(toNewsItem);

    return {
      // 韭研返回已按时间倒序，"最新"取前 20 条
      messages: allDayMessages.slice(0, 20),
      allDayMessages,
      lastUpdate: Date.now(),
      stock: {
        keyword,
        name: ref?.name || keyword,
        code: ref?.code || '',
      },
    };
  }

  /** 把个股新闻拼成纯文本，供 AI 分析作为上下文 */
  public async fetchNewsText(stockKeyword?: string, limit = 20): Promise<string> {
    const payload = await this.fetchNewsData(stockKeyword, limit);
    const items = payload.allDayMessages || [];
    if (!items.length) return '';
    return items
      .map((n) => {
        const ts = n.created_at ? `[${new Date(n.created_at * 1000).toLocaleString('zh-CN')}] ` : '';
        const warn = n.warn_words ? ` (敏感词: ${n.warn_words})` : '';
        return `- ${ts}${n.title}${warn}\n  ${n.summary}`;
      })
      .join('\n');
  }

  async getNewsData(stockKeyword?: string) {
    try {
      const data = await this.fetchNewsData(stockKeyword);
      this.postNewsData(data);
    } catch (err) {
      console.error('Fetch stock news error', err);
      this.sendEmptyData();
    }
  }

  private postNewsData(data: StockNewsPayload) {
    this.webview?.postMessage({
      command: 'newsData',
      data,
    });
  }

  private sendEmptyData() {
    this.postNewsData(EMPTY_PAYLOAD());
  }
}

/** 兼容旧引用名 */
export const FlashNewsService = StockNewsService;
export type FlashNewsService = StockNewsService;