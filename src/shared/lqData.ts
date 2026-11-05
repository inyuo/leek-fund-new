/**
 * 量价掘金「策略选股」数据层（官网 pages/lq/lq，2026-11-04 实测契约）。
 *
 * 9 类策略共用 POST /shares.get_lq {tag, days}：
 * 无 token 返回 {state:false, code:1018} —— 必须登录，故复用 ljgxPostAuth
 * 的统一降级层（1018 清会话、网络/HTTP/业务失败一律 null，绝不抛异常）。
 *
 * 返回 data 是两级分组：{ list:[{title, list:[{code,...}]}], hyTags, tsTags }。
 * 具体行字段以登录后真机响应为准，这里做防御式归一化：任何缺失都收敛成空值，
 * 让 UI 层只依赖稳定的 LqResult 形状。
 */
import { LjgxFetchDeps, ljgxPostAuth } from './ljgxData';

/** 策略元数据：一行一个，驱动树入口、面板 chips 与命令参数 */
export interface LqTagMeta {
  tag: string;
  label: string;
}

export const LQ_TAGS: LqTagMeta[] = [
  { tag: 'cd', label: '超跌' },
  { tag: 'qs', label: '趋势' },
  { tag: 'dwfl', label: '低位' },
  { tag: 'szx', label: '十字星' },
  { tag: 'ztb', label: '涨停' },
  { tag: 'cx', label: '次新股' },
  { tag: 'hy', label: '板块' },
  { tag: 'jzc', label: '净增持' },
  { tag: 'fk', label: '风口' },
];

/** 官网 titleUtils.dayChoice 的 8 档天数 */
export interface LqDayMeta {
  num: number;
  name: string;
}

export const LQ_DAYS: LqDayMeta[] = [
  { num: 1, name: '近1天' },
  { num: 3, name: '近3天' },
  { num: 5, name: '近5天' },
  { num: 10, name: '近10天' },
  { num: 20, name: '近20天' },
  { num: 30, name: '近30天' },
  { num: 60, name: '近60天' },
  { num: 100, name: '近100天' },
];

/** 归一化后的个股行（字段缺失一律空值） */
export interface LqRow {
  code: string;
  name: string;
  percent: number | null;
  note: string;
}

export interface LqGroup {
  title: string;
  rows: LqRow[];
}

export interface LqTagLink {
  doc: string;
  url: string;
}

export interface LqResult {
  groups: LqGroup[];
  hyTags: string[];
  tsTags: LqTagLink[];
}

function str(v: any): string {
  return typeof v === 'string' ? v : '';
}

function firstStr(row: any, keys: string[]): string {
  for (const key of keys) {
    const v = str(row[key]);
    if (v) return v;
  }
  return '';
}

/** 数字或数字字符串 → number，其余 null */
function numberOrNull(v: any): number | null {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (isFinite(n)) return n;
  }
  return null;
}

function firstNumber(row: any, keys: string[]): number | null {
  for (const key of keys) {
    const n = numberOrNull(row[key]);
    if (n !== null) return n;
  }
  return null;
}

/**
 * 裸 6 位 A 股代码补交易所前缀（官网 get_lq 行 code 无前缀）。
 * 下游资金动态面板（isAShareCode/下拉选项）只认 sh/sz+6 位，不补前缀
 * 则 initialCode 匹配不到任何 option、详情直接判空（“没有选中的股票”）。
 * 已带前缀与非 A 股代码原样透传（展示不丢，点入资金动态自会被过滤）。
 */
export function toAShareCode(code: any): string {
  const raw = typeof code === 'string' ? code.trim() : '';
  if (!/^\d{6}$/.test(raw)) return raw;
  // 6/5/9 起归沪市（个股/基金/ETF），0/1/2/3 起归深市
  return /^[659]/.test(raw) ? `sh${raw}` : `sz${raw}`;
}

function normalizeTags(list: any): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    const text = typeof item === 'string' ? item : item && typeof item === 'object'
      ? firstStr(item, ['name', 'doc', 'title'])
      : '';
    if (text) out.push(text);
  }
  return out;
}

function normalizeLinks(list: any): LqTagLink[] {
  if (!Array.isArray(list)) return [];
  const out: LqTagLink[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    out.push({ doc: firstStr(item, ['doc', 'name', 'title']), url: str(item.url) });
  }
  return out;
}

/** 空结果（每次新建，避免调用方共享可变数组） */
function emptyResult(): LqResult {
  return { groups: [], hyTags: [], tsTags: [] };
}

/**
 * 官网 data.data → LqResult（纯函数）。
 * - 分组无有效行则整组跳过；行缺 code 跳过（树/面板点击依赖 code）；
 * - 标签非数组一律收敛为空数组；任何异常输入返回空结构，不抛错。
 */
export function normalizeLqGroups(payload: any): LqResult {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.list)) {
    return emptyResult();
  }

  const result = emptyResult();
  for (const group of payload.list) {
    if (!group || typeof group !== 'object' || !Array.isArray(group.list)) continue;

    const rows: LqRow[] = [];
    for (const item of group.list) {
      if (!item || typeof item !== 'object') continue;
      const code = toAShareCode(firstStr(item, ['code', 'Code', 'symbol']));
      if (!code) continue;
      rows.push({
        code,
        name: firstStr(item, ['name', 'Name', 'stockName']),
        percent: firstNumber(item, ['percent', 'zdf', 'Zdf', 'zd']),
        note: firstStr(item, ['desc', 'msg', 'reason', 'td1', 'note']),
      });
    }
    if (!rows.length) continue;

    result.groups.push({
      title: firstStr(group, ['title', 'name', 'tm', 'date']),
      rows,
    });
  }
  result.hyTags = normalizeTags(payload.hyTags);
  result.tsTags = normalizeLinks(payload.tsTags);
  return result;
}

/** 非法 tag/days 收敛到默认值，避免把脏参数发到第三方接口 */
function safeTag(tag: string): string {
  return LQ_TAGS.some((t) => t.tag === tag) ? tag : 'ztb';
}

function safeDays(days: number): number {
  return LQ_DAYS.some((d) => d.num === days) ? days : 1;
}

/**
 * 拉取指定策略榜单。deps 传 {store, axios}（生产只传 store，测试注入 axios）。
 * 失败（未登录 / 1018 / 网络 / 业务）一律返回 null，由 UI 渲染登录引导或失败占位。
 */
export async function fetchLqList(
  tag: string,
  days: number,
  deps?: LjgxFetchDeps
): Promise<LqResult | null> {
  const payload = await ljgxPostAuth(
    'shares.get_lq',
    { tag: safeTag(tag), days: safeDays(days) },
    deps
  );
  if (!payload) return null;
  return normalizeLqGroups(payload);
}

export default { LQ_TAGS, LQ_DAYS, normalizeLqGroups, fetchLqList };
