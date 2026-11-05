/**
 * xxjwxc 官网资讯源（登录后资讯切换）。
 *
 * 官网 webshares 的「资讯」内容由两个接口组成（2026-11-04 实测契约）：
 * - POST /shares.get_hejjw  7×24 快讯流 [{tmStr:"14:20", content:"..."}]，需登录
 * - POST /shares.get_xzw    新闻资讯 [{tmStr, title, content}]，需登录（title 可能为空）
 * 无 token 响应 {state:false, code:1018}。
 *
 * 与全站数据层惯例一致：失败一律返回空数组/降级值，绝不抛异常，
 * console.error 只打 message。登录态经 LjgxStorage 注入，测试可替换。
 */
import axios from 'axios';
import { createVscodeStorage, loadSession, LjgxSession, LjgxStorage } from '../shared/ljgxData';
import { JYGNewsItem } from './jygNews';

const XXJ_API_BASE = 'https://www.xxjwxc.cn/shares/api/v1';
const XXJ_TIMEOUT = 30000;
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 官网资讯页（无独立原文链接时统一跳这里） */
const XXJ_NEWS_PAGE_URL = 'https://www.xxjwxc.cn/webshares/#/pages/news/news';

const SOURCE_TAG_FLASH = 'xxj-flash';
const SOURCE_TAG_NEWS = 'xxj-news';

/* ---------- 登录后四来源（官网 pages/news/news 的 segmentedList） ---------- */
export type NewsSourceKey = 'hot' | 'flash' | 'global' | 'calendar';

export interface NewsSourceMeta {
  key: NewsSourceKey;
  label: string;
  /** 官网接口路径（相对 XXJ_API_BASE） */
  endpoint: string;
  /** 请求体：投资日历靠 xzw 的 tag=1 分流，不能一律传 {} */
  body: Record<string, any>;
  /** 点击条目打开的官网子页 */
  pageUrl: string;
  /** 分级缓存 TTL：快讯 30s，新闻/日历 5min */
  ttlMs: number;
  defaultCollapsed?: boolean;
}

const NEWS_PAGE_BASE = 'https://www.xxjwxc.cn/webshares/#/pages/article/';

export const NEWS_SOURCES: NewsSourceMeta[] = [
  {
    key: 'hot',
    label: '热点快讯',
    endpoint: '/shares.get_glh_tm',
    body: { start: '', end: '' },
    pageUrl: `${NEWS_PAGE_BASE}jdkp`,
    ttlMs: 30 * 1000,
  },
  {
    key: 'flash',
    label: '今日快讯',
    endpoint: '/shares.get_hejjw',
    body: { dayStr: '' },
    pageUrl: `${NEWS_PAGE_BASE}hejjw`,
    ttlMs: 30 * 1000,
  },
  {
    key: 'global',
    label: '全球新闻',
    endpoint: '/shares.get_xzw',
    body: { start: '', end: '', tag: '' },
    pageUrl: `${NEWS_PAGE_BASE}xzw`,
    ttlMs: 5 * 60 * 1000,
    defaultCollapsed: true,
  },
  {
    key: 'calendar',
    label: '投资日历',
    endpoint: '/shares.get_xzw',
    body: { start: '', end: '', tag: '1' },
    pageUrl: `${NEWS_PAGE_BASE}tzrl`,
    ttlMs: 5 * 60 * 1000,
    defaultCollapsed: true,
  },
];

/** 来源 → 官网子页；未知来源回退资讯首页 */
export function resolveNewsSourceUrl(source?: string): string {
  const meta = typeof source === 'string' ? NEWS_SOURCES.find((s) => s.key === source) : undefined;
  return meta ? meta.pageUrl : XXJ_NEWS_PAGE_URL;
}

/** 接口原始条目（hejjw / xzw 共用形状，title 可为空） */
export interface XxjRawNewsItem {
  tmStr: string;
  title: string;
  content: string;
}

function errMsg(e: any): string {
  if (!e) return String(e);
  if (typeof e === 'string') return e;
  return e.message || e.code || String(e);
}

/** 登录态判定：store 可注入（测试）；无注入且无 vscode context 时按未登录处理 */
export function hasXxjSession(deps?: { store?: LjgxStorage }): boolean {
  try {
    const store =
      (deps && deps.store) ||
      (globalStateContextMemento ? createVscodeStorage(globalStateContextMemento) : null);
    if (!store) return false;
    const session = loadSession(store);
    return !!(session && session.sessionId);
  } catch (e) {
    console.error('[资讯] 读取 xxjwxc 登录态失败', errMsg(e));
    return false;
  }
}

/** globalState.context 由 extension.ts 在 activate 时赋值；测试环境为 undefined */
let globalStateContextMemento: LjgxStorage | null = null;

/** 生产侧注册 storage（extension.ts activate 时调用一次） */
export function initXxjNewsStorage(store: LjgxStorage): void {
  globalStateContextMemento = store;
}

/** 带 user-token 的 POST 封装：失败返回 null（不抛错），1018 同样按空数据处理 */
async function xxjNewsPost(
  path: string,
  body: Record<string, any>,
  session: LjgxSession,
  deps?: { axios?: any }
): Promise<any | null> {
  try {
    const client = (deps && deps.axios) || axios;
    const res = await client.post(
      `${XXJ_API_BASE}${path}`,
      body,
      {
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://www.xxjwxc.cn',
          Referer: 'https://www.xxjwxc.cn/webshares/',
          'User-Agent': DEFAULT_UA,
          Accept: 'application/json, text/plain, */*',
          'user-token': session.sessionId,
        },
        timeout: XXJ_TIMEOUT,
        validateStatus: () => true,
      }
    );
    if (!res || res.status >= 400) {
      console.error('[资讯] xxjwxc HTTP error', path, res && res.status);
      return null;
    }
    const payload = res.data;
    if (!payload || payload.state !== true) {
      // 1018（未登录/缓存过期）与其他业务失败一样按空数据处理
      return null;
    }
    return payload.data;
  } catch (e) {
    console.error('[资讯] xxjwxc 请求失败', path, errMsg(e));
    return null;
  }
}

/** 拉取 7×24 快讯流（原始条目，未合并） */
export async function fetchXxjFlash(deps?: { store?: LjgxStorage; axios?: any }): Promise<XxjRawNewsItem[]> {
  const session = resolveSession(deps);
  if (!session) return [];
  const data = await xxjNewsPost('/shares.get_hejjw', {}, session, deps);
  const list = data && data.list;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (item: any) => item && typeof item.tmStr === 'string' && typeof item.content === 'string' && item.content
  );
}

/** 拉取新闻资讯（原始条目，未合并） */
export async function fetchXxjNews(deps?: { store?: LjgxStorage; axios?: any }): Promise<XxjRawNewsItem[]> {
  const session = resolveSession(deps);
  if (!session) return [];
  const data = await xxjNewsPost('/shares.get_xzw', {}, session, deps);
  const list = data && data.list;
  if (!Array.isArray(list)) return [];
  return list.filter((item: any) => item && typeof item.tmStr === 'string');
}

function resolveSession(deps?: { store?: LjgxStorage }): LjgxSession | null {
  try {
    const store =
      (deps && deps.store) ||
      (globalStateContextMemento ? createVscodeStorage(globalStateContextMemento) : null);
    return store ? loadSession(store) : null;
  } catch (e) {
    return null;
  }
}

/** "14:20" → 今日该时刻的毫秒时间戳（解析失败返回 0，仅用于排序） */
function tmStrToTime(tmStr: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(tmStr || '').trim());
  if (!m) return 0;
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.getTime();
}

const MAX_TITLE_LENGTH = 120;
const MAX_SUMMARY_LENGTH = 200;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 合并快讯 + 新闻并按时间倒序，映射为资讯树条目（与韭研条目同构）。
 * - title 取 content/title 兜底（xzw 实测存在 title 为空的条目）
 * - tmStr 缺失的条目跳过（无时间无法排序）
 * - id 在同一批内唯一（树节点身份依赖 id）
 */
export function buildXxjNewsItems(flash: any, news: any, limit = 50): JYGNewsItem[] {
  const safeLimit = Math.max(0, limit);
  const rows: { raw: XxjRawNewsItem; tag: string }[] = [];
  if (Array.isArray(flash)) {
    flash.forEach((item) => {
      if (item && typeof item.tmStr === 'string' && item.tmStr) rows.push({ raw: item, tag: SOURCE_TAG_FLASH });
    });
  }
  if (Array.isArray(news)) {
    news.forEach((item) => {
      if (item && typeof item.tmStr === 'string' && item.tmStr) rows.push({ raw: item, tag: SOURCE_TAG_NEWS });
    });
  }

  const items: JYGNewsItem[] = [];
  for (const { raw, tag } of rows) {
    const content = typeof raw.content === 'string' ? raw.content.replace(/\s+/g, ' ').trim() : '';
    const title = (typeof raw.title === 'string' ? raw.title.replace(/\s+/g, ' ').trim() : '') || content;
    if (!title) continue;

    items.push({
      id: `${tag}-${items.length}`,
      url: XXJ_NEWS_PAGE_URL,
      time: tmStrToTime(raw.tmStr),
      timeLabel: raw.tmStr,
      title: truncate(title, MAX_TITLE_LENGTH),
      summary: truncate(content, MAX_SUMMARY_LENGTH),
      stocksLabel: '',
    });
    if (items.length >= safeLimit) break;
  }

  // 倒序：新在前（同分钟保持插入顺序，服务端本就新在前）
  items.sort((a, b) => b.time - a.time);
  return items;
}

/* ---------- 按来源分组（方案 A） ---------- */
export interface NewsSourceGroup {
  key: NewsSourceKey;
  label: string;
  items: JYGNewsItem[];
  failed: boolean;
  updatedAt: number;
}

/**
 * 拉取单个来源。返回语义：
 * - null → 请求失败/载荷不可解析（分组显示「加载失败，点击重试」）
 * - []   → 未登录或该来源暂无数据
 * - 数组 → 原始条目
 */
export async function fetchXxjSource(
  key: string,
  deps?: { store?: LjgxStorage; axios?: any }
): Promise<XxjRawNewsItem[] | null> {
  const meta = NEWS_SOURCES.find((s) => s.key === key);
  if (!meta) return null;
  const session = resolveSession(deps);
  if (!session) return [];
  const data = await xxjNewsPost(meta.endpoint, meta.body, session, deps);
  if (!data || !Array.isArray(data.list)) return null;
  return data.list.filter(
    (item: any) => item && typeof item === 'object' && typeof item.tmStr === 'string'
  ) as XxjRawNewsItem[];
}

/**
 * 四来源结果 → 分组列表（纯函数）。results 为 null/非对象时返回 []，
 * 让 Provider 回退到旧的扁平降级链路；某来源为 null 则标记该组失败。
 */
export function buildXxjSourceGroups(results: any, limitPerGroup = 20): NewsSourceGroup[] {
  if (!results || typeof results !== 'object') return [];
  const safeLimit = Math.max(0, limitPerGroup);
  const now = Date.now();

  return NEWS_SOURCES.map((meta) => {
    const raw = results[meta.key];
    const failed = raw === null || raw === undefined;
    const list = Array.isArray(raw) ? raw : [];
    const items: JYGNewsItem[] = [];

    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const content = typeof item.content === 'string' ? item.content.replace(/\s+/g, ' ').trim() : '';
      const title =
        (typeof item.title === 'string' ? item.title.replace(/\s+/g, ' ').trim() : '') || content;
      const timeLabel = String(item.tmStr || item.tm || item.date || '').trim();
      if (!title || !timeLabel) continue;

      items.push({
        id: `${meta.key}-${items.length}`,
        url: typeof item.url === 'string' && item.url ? item.url : meta.pageUrl,
        time: tmStrToTime(timeLabel),
        timeLabel,
        title: truncate(title, MAX_TITLE_LENGTH),
        summary: truncate(content, MAX_SUMMARY_LENGTH),
        stocksLabel: '',
        source: meta.key,
      });
    }
    items.sort((a, b) => b.time - a.time);
    if (items.length > safeLimit) items.length = safeLimit;

    return { key: meta.key, label: meta.label, items, failed, updatedAt: now };
  });
}

/**
 * 登录后为 AI 分析聚合四来源分类资讯（与「资讯」视图同源）。
 * 未登录直接返回 []（不发请求）；登录态经 deps 或全局 storage 解析。
 */
export async function fetchXxjNewsGroupsForAi(
  limitPerGroup = 8,
  deps?: { store?: LjgxStorage; axios?: any }
): Promise<NewsSourceGroup[]> {
  if (!hasXxjSession(deps)) return [];
  const results: Record<string, any> = {};
  const fetched = await Promise.all(NEWS_SOURCES.map((s) => fetchXxjSource(s.key, deps)));
  NEWS_SOURCES.forEach((s, i) => {
    results[s.key] = fetched[i];
  });
  return buildXxjSourceGroups(results, limitPerGroup);
}

/**
 * 四来源分组 → AI prompt 附录（纯函数）。
 * 仅保留有条目的分组；全部为空返回空串，让调用方回退到韭研源。
 */
export function buildXxjNewsAppendix(groups: any): string {
  if (!Array.isArray(groups) || !groups.length) return '';
  const sections: string[] = [];
  for (const g of groups) {
    if (!g || !Array.isArray(g.items) || !g.items.length) continue;
    const lines = g.items.map((n: JYGNewsItem) => {
      const time = n.timeLabel ? `[${n.timeLabel}] ` : '';
      const summary = n.summary ? ` —— ${n.summary}` : '';
      return `- ${time}${n.title}${summary}`;
    });
    sections.push(`【${g.label}】\n${lines.join('\n')}`);
  }
  if (!sections.length) return '';
  return `\n\n以下为「资讯」栏分类新闻（来自复利备忘录，登录态）：\n${sections.join('\n\n')}`;
}

export default {
  hasXxjSession,
  initXxjNewsStorage,
  fetchXxjFlash,
  fetchXxjNews,
  buildXxjNewsItems,
  NEWS_SOURCES,
  resolveNewsSourceUrl,
  fetchXxjSource,
  buildXxjSourceGroups,
  fetchXxjNewsGroupsForAi,
  buildXxjNewsAppendix,
};
