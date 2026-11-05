/**
 * 资讯模块数据服务（数据源：韭研公社社区流，全市场文章）
 *
 * 原为「雪球用户动态」，因雪球接口需 cookie 且已不可用而废弃；
 * 金十快讯 WebSocket 老协议实测已失效，故改用韭研公社社区文章接口。
 */
import { TreeItem, TreeItemCollapsibleState } from 'vscode';
import { fetchJYGCommunityNews } from '../webview/jiuyangongshe-news';
import { fetchHeadlines } from '../shared/xxjwxcData';
import { buildJYGNewsItems, JYGNewsItem } from './jygNews';
import { buildHeadlineNewsItems } from './headlineNews';
import {
  NEWS_SOURCES,
  NewsSourceGroup,
  NewsSourceMeta,
  buildXxjNewsItems,
  buildXxjSourceGroups,
  fetchXxjFlash,
  fetchXxjNews,
  fetchXxjSource,
  hasXxjSession,
} from './xxjwxcNews';

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

function formatClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 登录后的来源分组节点（根节点）：标题带条数，失败时可直接点击重试 */
export class NewsSourceGroupTreeItem extends TreeItem {
  readonly group: NewsSourceGroup;

  constructor(group: NewsSourceGroup, meta: NewsSourceMeta) {
    super(`${group.label} (${group.items.length})`);
    this.group = group;
    this.id = `news-source-${group.key}`;
    this.description = group.failed
      ? '加载失败，点击重试'
      : `更新于 ${formatClock(group.updatedAt)}`;
    this.collapsibleState = meta.defaultCollapsed
      ? TreeItemCollapsibleState.Collapsed
      : TreeItemCollapsibleState.Expanded;
    if (group.failed) {
      this.command = { title: '刷新资讯', command: 'leek-fund.refreshFollow', arguments: [] };
    }
  }
}

export class NewsService {
  private cache: NewsTreeItem[] = [];
  private cacheTime = 0;
  private inflight: Promise<NewsTreeItem[]> | null = null;
  /** 四来源分级缓存：按来源各自的 TTL 决定何时重拉 */
  private groupCache = new Map<string, { time: number; group: NewsSourceGroup }>();
  private groupInflight = new Map<string, Promise<any>>();

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

  /**
   * 强制刷新：丢弃缓存重新拉取。
   * 供「刷新资讯」命令使用 —— 树的 onDidChangeTreeData 只触发重绘，
   * 重绘时仍会命中 TTL 缓存，因此必须有独立的清缓存出口。
   */
  async forceRefresh(): Promise<NewsTreeItem[]> {
    this.clearCaches();
    return this.getNewsList();
  }

  /** 手动刷新分组：清掉所有分级缓存后全量重拉 */
  async forceRefreshGroups(): Promise<NewsSourceGroup[]> {
    this.clearCaches();
    return this.getNewsGroups();
  }

  private clearCaches(): void {
    this.cache = [];
    this.cacheTime = 0;
    this.inflight = null;
    this.groupCache.clear();
    this.groupInflight.clear();
  }

  /**
   * 登录后四来源分组：按各自 TTL 分级缓存，单源失败不影响其他分组。
   * 未登录返回 []，由 Provider 回退到旧的扁平降级链路。
   */
  async getNewsGroups(limitPerGroup = 20): Promise<NewsSourceGroup[]> {
    if (!hasXxjSession()) return [];
    const now = Date.now();
    const results: Record<string, any> = {};
    const cached = new Map<string, NewsSourceGroup>();
    const pending: { key: string; task: Promise<any> }[] = [];

    for (const meta of NEWS_SOURCES) {
      const hit = this.groupCache.get(meta.key);
      if (hit && now - hit.time < meta.ttlMs) {
        cached.set(meta.key, hit.group);
        results[meta.key] = [];
        continue;
      }
      let task = this.groupInflight.get(meta.key);
      if (!task) {
        task = fetchXxjSource(meta.key).catch(() => null);
        this.groupInflight.set(meta.key, task);
        void task.then(() => this.groupInflight.delete(meta.key));
      }
      pending.push({ key: meta.key, task });
      results[meta.key] = [];
    }

    const fetched = await Promise.all(pending.map((p) => p.task));
    pending.forEach((p, i) => {
      results[p.key] = fetched[i];
    });

    const groups = buildXxjSourceGroups(results, limitPerGroup);
    for (const group of groups) {
      const hit = cached.get(group.key);
      if (hit) {
        Object.assign(group, hit);
      } else {
        this.groupCache.set(group.key, { time: Date.now(), group });
      }
    }
    return groups;
  }

  private async fetchList(limit: number): Promise<NewsTreeItem[]> {
    let items: NewsTreeItem[] = [];

    // 登录了 xxjwxc（量价掘金）→ 资讯主源切换为官网快讯+新闻
    if (hasXxjSession()) {
      try {
        const pair = await Promise.all([fetchXxjFlash(), fetchXxjNews()]);
        items = buildXxjNewsItems(pair[0], pair[1], limit).map((news) => new NewsTreeItem(news));
      } catch (e) {
        console.error('[资讯] 拉取 xxjwxc 资讯失败', e);
      }
      if (items.length === 0) {
        console.warn('[资讯] xxjwxc 资讯不可用（未登录态变更或接口失败），降级韭研公社');
      }
    }

    // 未登录（或 xxjwxc 失败降级）：韭研公社社区流
    if (items.length === 0) {
      try {
        const rawList = await fetchJYGCommunityNews(limit);
        items = buildJYGNewsItems(rawList, limit).map((news) => new NewsTreeItem(news));
      } catch (e) {
        console.error('[资讯] 拉取社区流失败', e);
      }
    }

    // 主源为空/失败 → 降级到 xxjwxc 财经头条，避免视图整片空白
    if (items.length === 0) {
      try {
        const titles = await fetchHeadlines();
        items = buildHeadlineNewsItems(titles, limit).map((news) => new NewsTreeItem(news));
        if (items.length > 0) {
          console.warn('[资讯] 社区流不可用，已回退到财经头条');
        }
      } catch (e) {
        console.error('[资讯] 拉取财经头条失败', e);
      }
    }

    // 两个源都失败时保留旧数据，避免刷新后清空列表
    return items.length > 0 ? items : this.cache;
  }
}
