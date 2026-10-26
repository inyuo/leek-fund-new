import axios from 'axios';

/**
 * xxjwxc（复利备忘录）数据源客户端。
 *
 * 全部接口无需鉴权，但响应时间实测波动大（同一只股票连查 5 次：
 * 0.7s / 10.8s / 0.7s / 0.7s / 25.7s），因此统一 30s 超时 + 失败重试一次。
 *
 * 这些是第三方未鉴权接口，随时可能加鉴权或封禁 —— 所有 fetch 函数在失败时
 * 一律返回 null / 空数组，绝不抛异常，让调用方按"数据缺失"降级处理。
 * （教训：韭研接口超时被静默吞掉后，AI 拿不到数据只能回答"无法实时抓取"。）
 */

const XXJ_API_BASE = 'https://www.xxjwxc.cn/shares/api/v1';
const XXJ_TIMEOUT = 30000;
const XXJ_MAX_ATTEMPTS = 2;
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 日志只取 message：axios 错误对象带完整 config/request/response，直接打会刷屏 */
function errMsg(e: any): string {
  if (!e) return String(e);
  if (typeof e === 'string') return e;
  return e.message || e.code || String(e);
}

/** 个股当日分时：价格序列与主力净流入序列（等长，同时间轴） */
export interface MainFlowData {
  tm: string;
  price: number[];
  main: number[];
}

/** 行业主力净流入（某一时点的最新值） */
export interface IndustryFlowItem {
  name: string;
  amount: number;
}

async function xxjPostOnce(path: string, body: any): Promise<any | null> {
  try {
    const res = await axios.post(`${XXJ_API_BASE}${path}`, body || {}, {
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://www.xxjwxc.cn',
        Referer: 'https://www.xxjwxc.cn/webshares/',
        'User-Agent': DEFAULT_UA,
        Accept: 'application/json, text/plain, */*',
      },
      timeout: XXJ_TIMEOUT,
      validateStatus: () => true,
    });

    if (!res || res.status >= 400) {
      console.error('[XXJ] HTTP error', path, res && res.status, res && res.statusText);
      return null;
    }

    const payload = res.data;
    // state!==true 表示业务失败（如 1018 未登录、1001 参数无效）
    if (!payload || payload.state !== true) {
      console.error('[XXJ] business error', path, payload && payload.code, payload && payload.error);
      return null;
    }
    return payload;
  } catch (e) {
    console.error('[XXJ] request error', path, errMsg(e));
    return null;
  }
}

/**
 * 统一 POST 封装：30s 超时 + 失败重试一次，始终返回 payload 或 null。
 * 导出以便后续消费方复用同一套降级策略。
 */
export async function xxjPost(path: string, body: any): Promise<any | null> {
  for (let attempt = 1; attempt <= XXJ_MAX_ATTEMPTS; attempt++) {
    const payload = await xxjPostOnce(path, body);
    if (payload) return payload;
    if (attempt < XXJ_MAX_ATTEMPTS) {
      console.warn(`[XXJ] 第 ${attempt} 次请求失败，重试：${path}`);
    }
  }
  return null;
}

/** 个股当日主力资金流（分时粒度） */
export async function fetchStockMainFlow(code: string): Promise<MainFlowData | null> {
  const payload = await xxjPost('/analy.get_share_main', { code });
  const data = payload && payload.data;
  if (!data || !Array.isArray(data.price) || !Array.isArray(data.main)) return null;
  if (!data.price.length || data.price.length !== data.main.length) return null;
  return {
    tm: data.tm ? String(data.tm) : '',
    price: data.price,
    main: data.main,
  };
}

/** 个股第三方分析的一个分组（如「PEG估值」下的多条指标） */
export interface AnalysisGroup {
  name: string;
  msgs: string[];
}

/**
 * 个股第三方分析结论的**结构化**形式（PEG、最佳均线回测、次日预测、
 * 综合评分、机构参与度）。这是 xxjwxc 独有的数据，东财/新浪没有对应接口。
 *
 * 资金动态窗口需要按分组渲染成卡片 → 用这个结构化版本；
 * AI prompt 需要纯文本 → 用下面的 fetchStockAnalysis。
 */
export async function fetchStockAnalysisGroups(code: string): Promise<AnalysisGroup[]> {
  const payload = await xxjPost('/analy.analy_code', { code });
  const list = payload && payload.data && payload.data.list;
  if (!Array.isArray(list)) return [];

  const groups: AnalysisGroup[] = [];
  for (const group of list) {
    if (!group || typeof group.name !== 'string') continue;
    const msgs = Array.isArray(group.msgs)
      ? group.msgs.filter((m: any) => typeof m === 'string' && m)
      : [];
    if (!msgs.length) continue;
    groups.push({ name: group.name, msgs });
  }
  return groups;
}

/**
 * 个股第三方分析结论的文本形式，便于直接拼进 AI prompt。
 * 与 fetchStockAnalysisGroups 同源，只是把分组拍平成 `【组名】msg1；msg2`。
 */
export async function fetchStockAnalysis(code: string): Promise<string> {
  const groups = await fetchStockAnalysisGroups(code);
  if (!groups.length) return '';
  return groups.map((g) => `【${g.name}】${g.msgs.join('；')}`).join('\n');
}

/**
 * 解析行业分时资金流。
 * 响应结构：data.data = [["name","jlr","tm"], [行业名, 净流入金额, 时间], ...]，
 * 每个行业每 5 分钟一条，需为每个行业保留**最新时点**的值。
 */
export function parseHyTime(payload: any): IndustryFlowItem[] {
  const table = payload && payload.data && payload.data.data;
  if (!Array.isArray(table) || table.length < 2) return [];

  const latest: { [name: string]: { amount: number; tm: string } } = {};
  for (let i = 1; i < table.length; i++) {
    const row = table[i];
    if (!Array.isArray(row) || row.length < 3) continue;
    const name = row[0];
    const amount = Number(row[1]);
    const tm = String(row[2] || '');
    if (typeof name !== 'string' || !name || isNaN(amount)) continue;

    const prev = latest[name];
    // 数据按时间升序排列，但这里显式比较时间，避免依赖顺序假设
    if (!prev || tm >= prev.tm) {
      latest[name] = { amount, tm };
    }
  }

  const rows: IndustryFlowItem[] = Object.keys(latest).map((name) => ({
    name,
    amount: latest[name].amount,
  }));
  rows.sort((a, b) => b.amount - a.amount);
  return rows;
}

/** 行业主力净流入排名（xxjwxc 源，每个行业取最新时点，按金额降序） */
export async function fetchIndustryFlow(): Promise<IndustryFlowItem[]> {
  const payload = await xxjPost('/shares.get_hy_time', {});
  if (!payload) return [];
  return parseHyTime(payload);
}

/** 财经头条标题列表（无参数，资讯模块的第二数据源） */
export async function fetchHeadlines(): Promise<string[]> {
  const payload = await xxjPost('/analy.get_tou_tiao', {});
  const list = payload && payload.data && payload.data.list;
  if (!Array.isArray(list)) return [];
  return list.filter((item: any) => typeof item === 'string' && item.length > 0);
}

/**
 * 分时金额格式化：带正负号，按亿/万缩写。
 * 例：322524958 → "+3.23亿"，-784795000 → "-7.85亿"，50000 → "+5.00万"
 */
function formatFlowAmount(value: number): string {
  const abs = Math.abs(value);
  const sign = value >= 0 ? '+' : '-';
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(2)}万`;
  return `${sign}${abs.toFixed(0)}元`;
}

/**
 * 把主力资金流 + 第三方分析结论格式化成 AI prompt 附录。
 *
 * 语义要点：`main[]` 是**分时累计序列**（222 个点，非单调），
 * 因此当日累计值只能取**末元素**，绝不能对数组求和 ——
 * 实测 sum=712亿 远超茅台当日成交规模，求和会把错误数据喂给模型。
 *
 * 任一参数为空则该段不出现；两者都空返回空串。
 */
export function buildStockMoneyFlowAppendix(
  mainFlow: MainFlowData | null,
  analysis: string
): string {
  const parts: string[] = [];

  if (mainFlow && Array.isArray(mainFlow.main) && mainFlow.main.length) {
    const current = mainFlow.main[mainFlow.main.length - 1];
    const tail = mainFlow.main
      .slice(-20)
      .map(formatFlowAmount)
      .join(' → ');
    parts.push(
      `当日主力资金流（分时累计序列）：\n` +
        `- 时间：${mainFlow.tm || '未知'}，时点数 ${mainFlow.main.length}\n` +
        `- 当前累计主力净流入：${formatFlowAmount(current)}\n` +
        `- 末 20 个时点：${tail}`
    );
  }

  if (analysis) {
    parts.push(`第三方量化分析结论：\n${analysis}`);
  }

  if (!parts.length) return '';
  return `\n\n以下为该股资金与量化数据（来自复利备忘录 xxjwxc）：\n\n${parts.join('\n\n')}`;
}

/**
 * 个股信息：名称、现价、涨幅、所属板块。
 * 所属板块供「资金动态」窗口的板块资金区（粒度 C）使用 ——
 * 这是唯一能一次拿到名称+现价+涨幅+板块的公开接口。
 */
export async function fetchStockQuote(keyword: string): Promise<any | null> {
  const payload = await xxjPost('/shares.search', { code: keyword, tag: '' });
  const info = payload && payload.data && payload.data.info;
  if (!info || typeof info.name !== 'string' || !info.name) return null;

  const hy = Array.isArray(info.hy) ? info.hy : [];
  return {
    code: info.code ? String(info.code) : '',
    name: info.name,
    price: Number(info.price) || 0,
    percent: Number(info.percent) || 0,
    hy: hy
      .filter((item: any) => item && typeof item.name === 'string' && item.name)
      .map((item: any) => ({
        name: item.name,
        percent: Number(item.percent) || 0,
        code: item.code ? String(item.code) : '',
      })),
  };
}

export default {
  xxjPost,
  fetchStockMainFlow,
  fetchStockAnalysis,
  fetchStockAnalysisGroups,
  parseHyTime,
  fetchIndustryFlow,
  fetchHeadlines,
  fetchStockQuote,
  buildStockMoneyFlowAppendix,
};
