/**
 * 资金动态窗口的多源编排层。
 *
 * 分层意图（方案二）：
 * - `xxjwxcData` / `emMoneyFlow` —— 单一数据源客户端，只负责请求与解析
 * - `fundFlowData`（本文件）      —— 跨源选择与降级，返回窗口直接可用的结构
 * - `webview/stockFundFlow.ts`   —— 只负责开窗与消息收发，不含取数逻辑
 *
 * 这样编排逻辑也能被单测覆盖（mock 两个源的导出函数即可），
 * 不必把降级判断塞进无法测试的 webview 层。
 */
import {
  fetchStockMainFlow,
  fetchStockAnalysisGroups,
  fetchStockQuote,
  fetchIndustryFlow,
  MainFlowData,
  AnalysisGroup,
} from './xxjwxcData';
import { fetchEastIndustryFlow, fetchEastStockMainFlow, toSecid } from './emMoneyFlow';
import { fetchStockNames } from './tencentStock';
import { mapLimit } from './utils';

/** 逐股取数并发上限：第三方接口短时高并发会触发反爬（实测东财被封） */
const STOCK_CONCURRENCY = 5;
/** 列表最多展示的自选股数，避免自选几十只时请求过多 */
const MAX_STOCKS = 30;

/** 日志只取 message：避免 axios 错误对象（含完整 config/request）刷屏输出面板 */
function errMsg(e: any): string {
  if (!e) return String(e);
  if (typeof e === 'string') return e;
  return e.message || e.code || String(e);
}

/** 粒度 A：一只自选股的当日主力净流入 */
export interface StockFundRow {
  code: string;
  /** 股票名称（腾讯批量行情），取不到时为空串 */
  name: string;
  /** 当日累计主力净流入（取分时序列末元素），两源皆无时为 null */
  mainNet: number | null;
  /** 数据日期（如 20261019），东财备源无日期时为空串 */
  tm: string;
  /** 数据来源：xxjwxc（主）/ east（备源）/ ''（无数据） */
  source: string;
}

/** 粒度 D：一个行业的主力资金流 */
export interface IndustryRow {
  /** 东财板块代码（BK 开头），xxjwxc 源没有代码时为空串 */
  code: string;
  name: string;
  amount: number;
  /** 占成交额比例（%），xxjwxc 源无此数据时为 0 */
  ratio: number;
}

/** 所属板块（粒度 C） */
export interface SectorRow {
  name: string;
  percent: number;
}

/** 选中股详情：粒 B 的分时曲线 + 粒度 C 的所属板块 + 第三方分析结论 */
export interface StockDetail {
  code: string;
  name: string;
  /** 现价，取不到时为 0 */
  price: number;
  /** 涨跌幅（%），取不到时为 0 */
  percent: number;
  mainFlow: MainFlowData | null;
  /** 第三方量化分析（结构化分组，供窗口按卡片渲染） */
  analysis: AnalysisGroup[];
  sectors: SectorRow[];
}

/**
 * 是否为 A 股个股代码（sh/sz + 6 位数字）。
 * 港股 hk、美股 usr、期货 nf、商品 hf 一律不支持 —— 若不过滤，
 * 这些代码会各自白等 30s 超时 + 1 次重试，拖垮整个窗口。
 */
export function isAShareCode(code: any): boolean {
  if (typeof code !== 'string') return false;
  return toSecid(code) !== null;
}

/**
 * 粒度 A：逐股取当日主力净流入。
 *
 * - 非 A 股代码直接跳过（不发请求）
 * - 限流并发，避免打爆第三方
 * - 单股失败保留该行、mainNet 置 null —— 绝不让一只股票拖垮整个列表
 * - mainNet 取**末元素**：main[] 是分时累计序列，求和会得到天文数字
 * - 主源失败才回退东财当日值：只在 xxjwxc 不可用时才打东财
 *   （东财 API 有按 IP 频率限制，正常情况下不增加请求）
 *
 * 注：备源只在主源失败时生效，此时分时曲线（粒度 B）同样是空的，
 * 因此不会出现"列表一个值、点进去另一个值"的跨源矛盾。
 *
 * 股票名称走腾讯批量行情（一次请求拿全部），与逐股资金流并发；
 * 名称失败只丢展示名，行与资金流数据照常返回。
 */
export async function loadStockFundRows(codes: any): Promise<StockFundRow[]> {
  const list = (Array.isArray(codes) ? codes : [])
    .filter(isAShareCode)
    .slice(0, MAX_STOCKS);

  if (list.length === 0) return [];

  const pair = await Promise.all([
    mapLimit(list, STOCK_CONCURRENCY, async (code: string): Promise<StockFundRow> => {
      try {
        const flow = await fetchStockMainFlow(code);
        if (flow && flow.main.length > 0) {
          return {
            code,
            name: '',
            mainNet: flow.main[flow.main.length - 1],
            tm: flow.tm,
            source: 'xxjwxc',
          };
        }
      } catch (e) {
        console.error('[资金动态] 取个股资金流失败', code, errMsg(e));
      }

      // 主源不可用 → 东财当日主力净流入兜底
      try {
        const east = await fetchEastStockMainFlow(code);
        if (east !== null && east !== undefined && !isNaN(east)) {
          return { code, name: '', mainNet: east, tm: '', source: 'east' };
        }
      } catch (e) {
        console.error('[资金动态] 东财个股资金流兜底失败', code, errMsg(e));
      }

      return { code, name: '', mainNet: null, tm: '', source: '' };
    }),
    fetchStockNames(list).catch((e) => {
      console.error('[资金动态] 批量取股票名称失败', errMsg(e));
      return {} as { [code: string]: string };
    }),
  ]);

  const rows = pair[0];
  const names = pair[1] || {};
  for (const row of rows) {
    row.name = names[row.code] || '';
  }
  return rows;
}

/**
 * 粒度 D：全行业资金流排名。
 * 东财 `clist/get` 为主源（有板块代码与占比），空了回退 xxjwxc `get_hy_time`。
 */
export async function loadIndustryRows(): Promise<IndustryRow[]> {
  try {
    const east = await fetchEastIndustryFlow();
    if (Array.isArray(east) && east.length > 0) {
      return east.map((row) => ({
        code: row.code,
        name: row.name,
        amount: row.amount,
        ratio: row.ratio,
      }));
    }
  } catch (e) {
    console.error('[资金动态] 东财行业资金流失败', errMsg(e));
  }

  try {
    const rows = await fetchIndustryFlow();
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => ({
      code: '',
      name: row.name,
      amount: row.amount,
      ratio: 0,
    }));
  } catch (e) {
    console.error('[资金动态] xxjwxc 行业资金流失败', errMsg(e));
    return [];
  }
}

/**
 * 选中股详情：分时资金曲线（B）+ 所属板块（C）+ 第三方分析结论。
 *
 * 三个子请求并发且各自 catch —— 任一失败只丢该字段，
 * 其余照常返回（教训：韭研超时被静默吞掉时，模型只能回答"无法实时抓取"）。
 */
export async function loadStockDetail(code: any): Promise<StockDetail> {
  const safeCode = typeof code === 'string' ? code : '';
  const empty: StockDetail = {
    code: safeCode,
    name: '',
    price: 0,
    percent: 0,
    mainFlow: null,
    analysis: [],
    sectors: [],
  };

  if (!isAShareCode(safeCode)) return empty;

  const pair = await Promise.all([
    fetchStockMainFlow(safeCode).catch((e) => {
      console.error('[资金动态] 取分时资金流失败', errMsg(e));
      return null;
    }),
    fetchStockQuote(safeCode).catch((e) => {
      console.error('[资金动态] 取个股信息失败', errMsg(e));
      return null;
    }),
    fetchStockAnalysisGroups(safeCode).catch((e) => {
      console.error('[资金动态] 取分析结论失败', errMsg(e));
      return [];
    }),
  ]);
  const flow = pair[0];
  const quote = pair[1];
  const analysis = pair[2];

  let sectors: SectorRow[] = [];
  if (quote && Array.isArray(quote.hy)) {
    sectors = quote.hy
      .filter((item: any) => item && typeof item.name === 'string' && item.name)
      .map((item: any) => ({ name: item.name, percent: Number(item.percent) || 0 }));
  }

  return {
    code: safeCode,
    name: quote && typeof quote.name === 'string' ? quote.name : '',
    price: quote ? Number(quote.price) || 0 : 0,
    percent: quote ? Number(quote.percent) || 0 : 0,
    mainFlow: flow,
    analysis: Array.isArray(analysis) ? analysis : [],
    sectors,
  };
}

export default {
  isAShareCode,
  loadStockFundRows,
  loadIndustryRows,
  loadStockDetail,
};
