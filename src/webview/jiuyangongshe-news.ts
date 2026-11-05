import axios from 'axios';
import * as crypto from 'crypto';

const JYG_API_BASE = 'https://app.jiuyangongshe.com/jystock-app/api/v2';
const JYG_SEARCH_URL = `${JYG_API_BASE}/article/search`;
const JYG_STOCK_ARTICLE_URL = `${JYG_API_BASE}/article/stock`;
const JYG_COMMUNITY_URL = `${JYG_API_BASE}/article/community`;

/**
 * 韭研公社接口鉴权盐值。
 * 新版 token = md5(`${SALT}:${timestamp}`)，与 header 中的 timestamp 配套使用。
 */
const JYG_TOKEN_SALT = 'Uu0KfOB8iUP69d3c';

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface JYGStockRef {
  stock_id: string;
  code: string;
  name: string;
}

export interface JYGArticleItem {
  title: string;
  content: string;
  warn_words: string | null;
  create_time?: string;
  article_id?: string;
  /** 文章关联的股票列表 */
  stock_list?: JYGStockRef[];
}

/**
 * 生成韭研公社接口鉴权 token。
 * 旧版依赖百度统计 HMACCOUNT cookie + ETag，已被服务端废弃（errCode 110 token无效）。
 */
export function buildJYGToken(timestamp: string): string {
  return crypto.createHash('md5').update(`${JYG_TOKEN_SALT}:${timestamp}`).digest('hex');
}

/** 允许用 JYG_TOKEN 环境变量覆盖（自建代理/特殊鉴权场景） */
function getTokenOverride(): string {
  const fromEnv = (process.env && process.env.JYG_TOKEN) || '';
  return fromEnv.trim();
}

interface JYGRequestOptions {
  /** 显式指定 token，优先级最高 */
  token?: string;
}

/**
 * 韭研接口响应极不稳定（实测同一只股票连查 5 次：0.7s / 10.8s / 0.7s / 0.7s / 25.7s），
 * 且 AI 分析链路是两跳串行（search 拿 stock_id → article/stock 拿文章），
 * 任一跳失败都会让新闻附录整体丢失，模型于是回答"无法实时抓取"。
 * 因此放宽超时并对失败自动重试一次。
 */
const JYG_TIMEOUT = 30000;
const JYG_MAX_ATTEMPTS = 2;

async function jygPostOnce(url: string, payload: any, options: JYGRequestOptions = {}): Promise<any | null> {
  const timestamp = Date.now().toString();
  const token = (options.token && options.token.trim()) || getTokenOverride() || buildJYGToken(timestamp);

  try {
    const res = await axios.post(url, payload, {
      headers: {
        Origin: 'https://www.jiuyangongshe.com',
        platform: '3',
        timestamp,
        token,
        'Content-Type': 'application/json',
        Referer: 'https://www.jiuyangongshe.com/',
        'User-Agent': DEFAULT_UA,
        Accept: 'application/json, text/plain, */*',
      },
      timeout: JYG_TIMEOUT,
      validateStatus: () => true,
    });

    if (!res || res.status >= 400) {
      console.error('[JYG] HTTP error', url, res && res.status, res && res.statusText);
      return null;
    }

    const data = res.data || {};
    if (data.errCode && String(data.errCode) !== '0') {
      console.error('[JYG] API errCode', data.errCode, data.msg);
      return null;
    }
    return data;
  } catch (e) {
    console.error('[JYG] request error', url, e);
    return null;
  }
}

/** 统一的 POST 封装：自动附加鉴权头、超时重试、统一错误处理 */
async function jygPost(url: string, payload: any, options: JYGRequestOptions = {}): Promise<any | null> {
  for (let attempt = 1; attempt <= JYG_MAX_ATTEMPTS; attempt++) {
    const data = await jygPostOnce(url, payload, options);
    if (data) return data;
    if (attempt < JYG_MAX_ATTEMPTS) {
      console.warn(`[JYG] 第 ${attempt} 次请求失败，重试：${url}`);
    }
  }
  return null;
}

function mapArticle(raw: any): JYGArticleItem {
  return {
    title: raw?.title ?? '',
    content: raw?.content ?? '',
    warn_words: raw?.warn_words ?? null,
    create_time: raw?.create_time,
    article_id: raw?.article_id,
    stock_list: Array.isArray(raw?.stock_list) ? raw.stock_list : [],
  };
}

/** 去掉 sh/sz/bj 前缀，得到纯数字代码，便于"名称或代码"两种入参都能匹配 */
function normalizeCode(code: string): string {
  return String(code || '').trim().toLowerCase().replace(/^(sh|sz|bj)/, '');
}

/**
 * 在候选股票列表中匹配目标股票，支持传入股票名称（贵州茅台）或代码（sh600519 / 600519）。
 */
function matchStock(candidates: any[], target: string): JYGStockRef | null {
  const keyword = String(target || '').trim();
  if (!keyword) return null;
  const kwLower = keyword.toLowerCase();
  const kwCode = normalizeCode(keyword);

  const list = candidates.filter((it) => it && it.stock_id);

  // 1. 精确匹配名称或代码
  for (const it of list) {
    const name = String(it.name || '').trim();
    const code = String(it.code || '').trim().toLowerCase();
    if (name === keyword || code === kwLower || normalizeCode(code) === kwCode) {
      return { stock_id: it.stock_id, code: it.code, name: it.name };
    }
  }
  // 2. 模糊匹配（名称互相包含）
  for (const it of list) {
    const name = String(it.name || '').trim();
    if (name && (name.includes(keyword) || keyword.includes(name))) {
      return { stock_id: it.stock_id, code: it.code, name: it.name };
    }
  }
  return null;
}

/** 按时间倒序（最新的在前）；create_time 形如 "2026-10-09 09:25:22"，可直接字典序比较 */
function sortByCreateTimeDesc(items: JYGArticleItem[]): JYGArticleItem[] {
  return items.sort((a, b) => String(b.create_time || '').localeCompare(String(a.create_time || '')));
}

/**
 * 解析股票在韭研公社的内部 stock_id。
 * 韭研未开放"代码 -> stock_id"接口，这里通过文章搜索结果里的 stock_list 反查。
 */
export async function resolveJYGStock(
  stockNameOrCode: string,
  options: JYGRequestOptions = {}
): Promise<JYGStockRef | null> {
  const keyword = String(stockNameOrCode || '').trim();
  if (!keyword) return null;

  const data = await jygPost(
    JYG_SEARCH_URL,
    { back_garden: 0, keyword, order: 1, limit: 20, start: 0, type: '1' },
    options
  );
  const result: any[] = data?.data?.result || [];
  if (!Array.isArray(result) || result.length === 0) return null;

  const candidates: any[] = [];
  for (const article of result) {
    const stockList = article?.stock_list;
    if (Array.isArray(stockList)) {
      for (const s of stockList) candidates.push(s);
    }
  }
  return matchStock(candidates, keyword);
}

/**
 * 韭研接口会在列表头部固定插入官方置顶帖（is_top=1，实测为 2 条：站规合集、清朗行动专帖）。
 * 若按 limit 原样请求，小 limit 时取回的全是置顶帖，过滤后就会得到空结果。
 * 因此多取一些再截断，保证调用方拿到的条数。
 */
const TOP_PINNED_RESERVE = 5;

/**
 * 拉取个股新闻（韭研公社）。
 *
 * 两段式：
 *   1) /article/search 按名称/代码搜索，从 stock_list 反查该股 stock_id；
 *   2) /article/stock 用 stock_id 精确拉取该股文章（服务端已按时间倒序）。
 *
 * 相比旧实现修复了三点：
 *   - 鉴权从失效的 HMACCOUNT/ETag 换成 md5(`${SALT}:${timestamp}`)；
 *   - limit / start 形参此前被硬编码覆盖，现已真正生效；
 *   - 小 limit 时不再因官方置顶帖被过滤而返回空结果。
 */
export async function fetchJYGNewsByCode(
  stockName: string,
  limit = 15,
  start = 0,
  options: JYGRequestOptions = {}
): Promise<JYGArticleItem[]> {
  const keyword = String(stockName || '').trim();
  if (!keyword) return [];

  const safeLimit = Math.max(1, limit);
  const safeStart = Math.max(0, start);
  // 多取置顶帖预留量 + 覆盖 start 偏移
  const fetchLimit = Math.min(100, safeStart + safeLimit + TOP_PINNED_RESERVE);

  const stock = await resolveJYGStock(keyword, options);

  // 优先走个股文章接口
  if (stock && stock.stock_id) {
    const data = await jygPost(
      JYG_STOCK_ARTICLE_URL,
      { stock_id: stock.stock_id, order: 1, limit: fetchLimit, start: safeStart },
      options
    );
    const list: any[] = data?.data?.result || [];
    if (Array.isArray(list) && list.length > 0) {
      // is_top=1 为公社官方置顶公告（如站规/招聘），与个股无关，过滤掉
      const items = list.filter((it) => !it?.is_top).map(mapArticle);
      return sortByCreateTimeDesc(items).slice(safeStart, safeStart + safeLimit);
    }
  }

  // 降级：直接用搜索结果，并只保留确实关联目标股票的文章
  const data = await jygPost(
    JYG_SEARCH_URL,
    { back_garden: 0, keyword, order: 1, limit: fetchLimit, start: 0, type: '1' },
    options
  );
  const list: any[] = data?.data?.result || [];
  if (!Array.isArray(list) || list.length === 0) return [];

  const filtered = list.filter((it) => {
    if (it?.is_top) return false;
    if (!stock) return true;
    const stockList = Array.isArray(it?.stock_list) ? it.stock_list : [];
    return stockList.some((s: any) => s && s.stock_id === stock.stock_id);
  });

  return sortByCreateTimeDesc(filtered.map(mapArticle)).slice(safeStart, safeStart + safeLimit);
}

/**
 * 拉取社区流（全市场文章，服务端按时间倒序）。
 *
 * type=3 为「综合/题材」流，实测返回当天最新文章且带关联股票；
 * type 为空会报 errCode 12000，故必须显式传入。
 * 返回原始结构（保留 is_top 等字段），由调用方决定如何消费。
 */
export async function fetchJYGCommunityNews(
  limit = 30,
  start = 0,
  type: string | number = 3,
  options: JYGRequestOptions = {}
): Promise<any[]> {
  const safeLimit = Math.max(1, Math.min(100, limit));
  const safeStart = Math.max(0, start);
  // 多取置顶帖预留量，避免过滤 is_top 后不足量
  const fetchLimit = Math.min(100, safeStart + safeLimit + TOP_PINNED_RESERVE);

  const data = await jygPost(
    JYG_COMMUNITY_URL,
    { back_garden: 0, type, order: 1, limit: fetchLimit, start: safeStart },
    options
  );
  const list: any[] = data?.data?.result || [];
  return Array.isArray(list) ? list : [];
}

/**
 * 韭研该股新闻 → AI prompt 附录（纯函数）。
 * 未登录（或资讯源缺失）时的降级附录，与资讯视图 fetchList 的降级链路同源。
 * 空/非数组返回空串，让调用方按「数据缺失」不追加该段。
 */
export function buildJygNewsAppendix(keyword: string, items: any): string {
  if (!Array.isArray(items) || !items.length) return '';
  const lines: string[] = [];
  for (const item of items) {
    if (!item) continue;
    const ts = item.create_time ? `[${item.create_time}] ` : '';
    lines.push(`- ${ts}${item.title || ''}`);
    if (item.warn_words) lines.push(`  - warn_words: ${item.warn_words}`);
    const snippet = item.content
      ? item.content.length > 300
        ? item.content.slice(0, 300) + '…'
        : item.content
      : '';
    if (snippet) lines.push(`  - content: ${snippet}`);
  }
  if (!lines.length) return '';
  return `\n\n以下为韭研公社该股新闻（关键词：${keyword}）：\n${lines.join('\n')}`;
}

export default {
  fetchJYGNewsByCode,
  fetchJYGCommunityNews,
  resolveJYGStock,
  buildJYGToken,
  buildJygNewsAppendix,
};

export async function testJYGNews(stockCode: string = '贵州茅台', limit = 5, start = 0) {
  try {
    const items = await fetchJYGNewsByCode(stockCode, limit, start);
    console.log(`JYG test -> keyword=${stockCode}, items=${items.length}`);
    console.log(
      JSON.stringify(
        items.slice(0, Math.min(3, items.length)).map((x) => ({
          title: x.title,
          create_time: x.create_time,
          article_id: x.article_id,
          warn_words: x.warn_words,
          stocks: (x.stock_list || []).map((s) => `${s.code}/${s.name}`),
          content: x.content ? x.content.slice(0, 120) : '',
        })),
        null,
        2
      )
    );
    return items;
  } catch (e) {
    console.error('testJYGNews error', e);
    return [];
  }
}