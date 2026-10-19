import axios from 'axios';

/**
 * 东财资金流备源。
 *
 * 实测结论（2026-10-19）：
 * - 东财 `clist/get`（行业板块资金流）稳定可用 → 行业流主源
 * - 东财 `fflow/kline/get`（个股主力资金流）短时间连续请求会触发反爬
 *   （Empty reply from server），补 ut token / 换 cb / 换域名均无效，
 *   但恢复后可用 → 仅作个股资金流**备源**，由 xxjwxc 主源失败时才调用
 *
 * 所有 fetch 失败一律返回 null / 空数组，绝不抛异常。
 */

const EM_API_BASE = 'https://push2.eastmoney.com/api/qt';
const EM_REFERER = 'https://quote.eastmoney.com/';
const EM_TIMEOUT = 15000;
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 日志只取 message：axios 错误对象带完整 config/request/response，直接打会刷屏 */
function errMsg(e: any): string {
  if (!e) return String(e);
  if (typeof e === 'string') return e;
  return e.message || e.code || String(e);
}

/** 东财行业板块资金流项 */
export interface EastIndustryItem {
  code: string;
  name: string;
  amount: number;
  ratio: number;
}

/**
 * 股票代码 → 东财 secid。
 * sh600519 → 1.600519（沪市），sz000001 → 0.000001（深市/创业板/科创板）。
 * 指数（nf_）、港股（hk）等非 A 股代码返回 null。
 */
export function toSecid(code: string): string | null {
  const raw = String(code || '')
    .trim()
    .toLowerCase();
  const matched = /^(sh|sz)(\d{6})$/.exec(raw);
  if (!matched) return null;
  const market = matched[1] === 'sh' ? '1' : '0';
  return `${market}.${matched[2]}`;
}

/** 解析东财 clist 行业资金流响应（f12=代码 f14=名称 f62=主力净流入 f184=占比） */
export function parseEastIndustryFlow(payload: any): EastIndustryItem[] {
  const diff = payload && payload.data && payload.data.diff;
  if (!Array.isArray(diff)) return [];

  const rows: EastIndustryItem[] = [];
  for (const item of diff) {
    if (!item || typeof item.f14 !== 'string') continue;
    const amount = Number(item.f62);
    if (isNaN(amount)) continue;
    const ratio = Number(item.f184);
    rows.push({
      code: item.f12 ? String(item.f12) : '',
      name: item.f14,
      amount,
      ratio: isNaN(ratio) ? 0 : ratio,
    });
  }
  return rows;
}

/** 单次请求东财行业资金流（内部，由 fetchEastIndustryFlow 负责重试） */
async function fetchEastIndustryFlowOnce(): Promise<EastIndustryItem[]> {
  try {
    const url =
      `${EM_API_BASE}/clist/get?pn=1&pz=50&po=1&np=1&fltt=2&invt=2&fid=f62` +
      '&fs=m:90+t:2&fields=f12,f14,f62,f184';
    const res = await axios.get(url, {
      headers: { Referer: EM_REFERER, 'User-Agent': DEFAULT_UA },
      timeout: EM_TIMEOUT,
      validateStatus: () => true,
    });
    if (!res || res.status >= 400) {
      console.error('[EM] HTTP error industry flow', res && res.status);
      return [];
    }
    return parseEastIndustryFlow(res.data);
  } catch (e) {
    console.error('[EM] request error industry flow:', errMsg(e));
    return [];
  }
}

/**
 * 东财全行业主力资金流排名（前 50，按主力净流入降序由后端 po=1 保证）。
 *
 * 东财的 API 路径存在按 IP 的频率限制：短时间内连续请求会被 WAF 拦成
 * ECONNRESET / Empty reply（实测同一 URL 间隔几小时结果不同，而同期
 * quote.eastmoney.com 网页始终 200）。正常插件使用频率远低于触发阈值，
 * 但仍重试一次以吸收偶发抖动。
 */
export async function fetchEastIndustryFlow(): Promise<EastIndustryItem[]> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const rows = await fetchEastIndustryFlowOnce();
    if (rows.length > 0) return rows;
    if (attempt < 2) console.warn('[EM] 行业资金流无数据，重试第 2 次');
  }
  return [];
}

/**
 * 东财个股当日主力净流入（备源）。
 * kline 形如 "2026-10-19,主力净流入,小单,中单,大单,超大单"，取最后一段的第 2 项。
 */
export async function fetchEastStockMainFlow(code: string): Promise<number | null> {
  const secid = toSecid(code);
  if (!secid) return null;

  try {
    const url =
      `${EM_API_BASE}/fflow/kline/get?secid=${secid}` +
      '&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56&klt=101&lmt=1';
    const res = await axios.get(url, {
      headers: { Referer: EM_REFERER, 'User-Agent': DEFAULT_UA },
      timeout: EM_TIMEOUT,
      validateStatus: () => true,
    });
    if (!res || res.status >= 400) return null;

    const klines = res.data && res.data.data && res.data.data.klines;
    if (!Array.isArray(klines) || !klines.length) return null;

    const last = String(klines[klines.length - 1]).split(',');
    if (last.length < 2) return null;
    const main = Number(last[1]);
    return isNaN(main) ? null : main;
  } catch (e) {
    console.error('[EM] request error stock main flow:', errMsg(e));
    return null;
  }
}

export default {
  toSecid,
  parseEastIndustryFlow,
  fetchEastIndustryFlow,
  fetchEastStockMainFlow,
};
