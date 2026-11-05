/**
 * 个股资金三块表格：官网 `#/pages/add/add` 的「资金动态」tab（StockInfoFund）
 * 用 `POST /analy.get_sp {code}` 取 spData，服务端的 list 每项是一张表：
 *   { title, d1..d4（4 列表头）, list: [{ d1..d4, color }] }
 * 用户确认的三块是「主力分析 / 主力资金 / 明-暗盘」，标题由服务端下发，
 * 因此这里不做硬编码，只做防御式归一。
 *
 * 该接口需要 user-token（未登录实测返回 1018），统一复用 ljgxPostAuth。
 * 未登录、会话失效、网络失败一律返回 [] —— 调用方据此隐藏整块区域。
 */
import { LjgxFetchDeps, ljgxPostAuth } from './ljgxData';

/** 一张表的行：4 个单元格 + 服务端给的行颜色 */
export interface FundTableRow {
  cells: string[];
  color: string;
}

/** 一张资金表（官网三块之一） */
export interface FundTable {
  title: string;
  columns: string[];
  rows: FundTableRow[];
}

/** 单块最多渲染 20 行，避免脏数据把左栏撑爆 */
const MAX_ROWS = 20;
/** 只接受 CSS 颜色字面量，挡掉 `red;}</style>` 之类注入 */
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,20})$/;

/**
 * 用户确认只要这三块。实测官网对 sz000977 返回 13 块（还含违规记录、
 * 分红配送、业绩预告、增减持、龙虎榜、游资榜、名人分析等），必须按标题过滤。
 * 顺序也由此固定，不依赖服务端返回顺序。
 */
const FUND_TABLE_TITLES = ['主力分析', '主力资金', '明暗盘'];

/** 标题归一：兼容 `明/暗盘`、`明\暗盘`、`明暗盘` 等分隔符写法 */
function titleKey(v: any): string {
  return str(v).replace(/[\\/\s]/g, '');
}

function str(v: any): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && isFinite(v)) return String(v);
  return '';
}

function safeColor(v: any): string {
  const color = str(v);
  return COLOR_RE.test(color) ? color : '';
}

/** 把官网 spData 归一为渲染直接可用的结构；脏块/脏行直接丢弃 */
export function normalizeFundTables(payload: any): FundTable[] {
  const list = payload && Array.isArray(payload.list) ? payload.list : [];
  const picked: Array<{ order: number; table: FundTable }> = [];

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const title = str(raw.title);
    const order = FUND_TABLE_TITLES.indexOf(titleKey(raw.title));
    if (!title || order < 0) continue;

    const columns = [str(raw.d1), str(raw.d2), str(raw.d3), str(raw.d4)];
    const rawRows = Array.isArray(raw.list) ? raw.list : [];
    const rows: FundTableRow[] = [];
    for (const row of rawRows) {
      if (!row || typeof row !== 'object') continue;
      const cells = [str(row.d1), str(row.d2), str(row.d3), str(row.d4)];
      if (!cells.some(Boolean)) continue;
      rows.push({ cells, color: safeColor(row.color) });
      if (rows.length >= MAX_ROWS) break;
    }

    if (rows.length) picked.push({ order, table: { title, columns, rows } });
  }

  return picked.sort((a, b) => a.order - b.order).map((item) => item.table);
}

/** 取当前个股的三块资金表；未登录/失败返回空数组（不抛错） */
export async function fetchStockFundTables(
  code: string,
  deps?: LjgxFetchDeps
): Promise<FundTable[]> {
  if (typeof code !== 'string' || !code) return [];
  const payload = await ljgxPostAuth('analy.get_sp', { code }, deps);
  if (!payload) return [];
  return normalizeFundTables(payload);
}

export default { fetchStockFundTables, normalizeFundTables };
