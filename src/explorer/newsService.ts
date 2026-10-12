/**
 * 资讯模块数据服务（数据源：韭研公社社区流，全市场文章）
 *
 * 原为「雪球用户动态」，因雪球接口需 cookie 且已不可用而废弃；
 * 金十快讯 WebSocket 老协议实测已失效，故改用韭研公社社区文章接口。
 */
import { TreeItem } from 'vscode';
import { fetchJYGCommunityNews } from '../webview/jiuyangongshe-news';
import { buildJYGNewsItems, JYGNewsItem } from './jygNews';

const MAX_LABEL_LENGTH = 60;
/** 资讯刷新频率本就受控，缓存 30s 避免树刷新触发重复请求 */
const CACHE_TTL = 30 * 1000;

export class NewsTreeItem extends TreeItem {
  readonly news: JYGNewsItem;

  constructor(news: JYGNewsItem) {
    super(truncate(news.title, MAX_LABEL_LENGTH));
    this.news = news;
    this.id = news.id;
    this.description = [news.timeLabel, news.stocksLabel].filter(Boolean).join(' ');
    this.tooltip = `[${news.timeLabel}] ${news.title}\n${news.summary}`;
    this.command = {
      title: '查看资讯原文',
      command: 'leek-fund.newItemClick',
      arguments: [news],
    };
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export class NewsService {
  private cache: NewsTreeItem[] = [];
  private cacheTime = 0;
  private inflight: Promise<NewsTreeItem[]> | null = null;

  /** 树节点列表：社区流文章 → 资讯条目（最新在前） */
  async getNewsList(limit = 50): Promise<NewsTreeItem[]> {
    const now = Date.now();
    if (now - this.cacheTime < CACHE_TTL && this.cache.length > 0) {
      return this.cache;
    }
    if (this.inflight) {
      return this.inflight;
    }

    this.inflight = this.fetchList(limit)
      .then((items) => {
        this.cache = items;
        this.cacheTime = Date.now();
        return items;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async fetchList(limit: number): Promise<NewsTreeItem[]> {
    try {
      const rawList = await fetchJYGCommunityNews(limit);
      const items = buildJYGNewsItems(rawList, limit).map((news) => new NewsTreeItem(news));
      // 请求失败时保留旧数据，避免刷新后清空列表
      return items.length > 0 ? items : this.cache;
    } catch (e) {
      console.error('[资讯] 拉取社区流失败', e);
      return this.cache;
    }
  }
}
