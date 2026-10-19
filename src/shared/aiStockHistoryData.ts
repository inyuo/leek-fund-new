import axios from 'axios';

export function formatDateYYYYMMDD(d: Date): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function calcStartDateByRange(base: Date, range: string): Date {
  const y = base.getFullYear();
  const m = base.getMonth();
  const d = base.getDate();
  switch (range) {
    case '1y':
      return new Date(y - 1, m, d);
    case '6m':
      return new Date(y, m - 6, d);
    case '1m':
      return new Date(y, m - 1, d);
    case '1w':
      return new Date(base.getTime() - 7 * 24 * 60 * 60 * 1000);
    case '3m':
    default:
      return new Date(y, m - 3, d);
  }
}

function toSohuCode(stockId: string): string | null {
  if (!stockId || stockId.length < 3) return null;
  const lower = stockId.toLowerCase();
  if (lower.startsWith('sh') || lower.startsWith('sz')) {
    return `cn_${lower.slice(2)}`;
  }
  return null;
}

/** 腾讯 fqkline 港股代码：数字部分补足 5 位小写 hk00700，指数等字母后缀为大写 hkHSI */
function normalizeTencentHkSymbol(stockId: string): string | null {
  const lower = stockId.toLowerCase();
  if (!lower.startsWith('hk') || stockId.length < 3) return null;
  const suffix = stockId.slice(2);
  if (/^\d+$/.test(suffix)) {
    return `hk${suffix.padStart(5, '0')}`;
  }
  if (suffix.length > 0) {
    return `hk${suffix.toUpperCase()}`;
  }
  return null;
}

function rangeToMaxBars(range: string): number {
  switch (range) {
    case '1y':
      return 320;
    case '6m':
      return 160;
    case '1m':
      return 35;
    case '1w':
      return 15;
    case '3m':
    default:
      return 100;
  }
}

async function fetchSohuQfqText(stockId: string, startCompact: string, endCompact: string): Promise<string> {
  const sohuCode = toSohuCode(stockId);
  if (!sohuCode) return '';
  const url = `http://q.stock.sohu.com/hisHq?code=${sohuCode}&start=${startCompact}&end=${endCompact}&stat=1&order=D&period=d&callback=historySearchHandler&rt=jsonp`;
  const response = await axios.get(url, { responseType: 'text' });
  const raw = typeof response === 'string' ? response : response.data ? String(response.data) : '';
  return parseSohuQfqToCsv(raw);
}

/**
 * 搜狐 hisHq 的 JSONP 原文 → 干净 CSV。
 *
 * 该接口返回 `historySearchHandler([{status,hq:[[日期,开盘,收盘,涨跌额,涨跌幅,最低,最高,成交量,成交额,换手率,振幅]],stat:[...]}])`，
 * 且 stat 字段为 GBK 编码，按 utf-8 解出是乱码。此前把整段 JSONP 原文直接拼进
 * AI prompt（实测约 6.5k 字符，含乱码），既浪费 token 又干扰模型理解。
 */
export function parseSohuQfqToCsv(jsonp: string): string {
  const text = String(jsonp || '').trim();
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start < 0 || end <= start) return '';

  let payload: any;
  try {
    payload = JSON.parse(text.slice(start + 1, end));
  } catch (e) {
    return '';
  }

  const hq = Array.isArray(payload) && payload[0] ? payload[0].hq : null;
  if (!Array.isArray(hq) || !hq.length) return '';

  const lines = ['日期,开盘,收盘,涨跌幅,最低,最高,成交量(手),成交额(万)'];
  for (const row of hq) {
    if (!Array.isArray(row) || row.length < 9) continue;
    lines.push([row[0], row[1], row[2], row[4], row[5], row[6], row[7], row[8]].join(','));
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

async function fetchTencentHkQfqText(
  stockId: string,
  startYmd: string,
  endYmd: string,
  range: string
): Promise<string> {
  const sym = normalizeTencentHkSymbol(stockId);
  if (!sym) return '';
  const maxBars = rangeToMaxBars(range);
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${encodeURIComponent(
    `${sym},day,${startYmd},${endYmd},${maxBars},qfq`
  )}`;
  const res = await axios.get(url, { responseType: 'json' });
  const day = res.data?.data?.[sym]?.day;
  if (!Array.isArray(day) || !day.length) return '';
  const lines = ['日期,开盘,收盘,最高,最低,成交量'];
  for (const row of day) {
    if (!Array.isArray(row) || row.length < 6) continue;
    lines.push(`${row[0]},${row[1]},${row[2]},${row[3]},${row[4]},${row[5]}`);
  }
  return lines.join('\n');
}

/**
 * AI 个股分析用的前复权日线文本：A 股走搜狐，港股走腾讯（与扩展内港股行情同源）。
 */
export async function fetchRecentQfqTradeDataForAi(
  stockId: string,
  range: string
): Promise<{ text: string; sourceLabel: string }> {
  const now = new Date();
  const startDate = calcStartDateByRange(now, range);
  const startYmd = formatDateYYYYMMDD(startDate);
  const endYmd = formatDateYYYYMMDD(now);
  const startCompact = startYmd.replace(/-/g, '');
  const endCompact = endYmd.replace(/-/g, '');

  const lower = stockId.toLowerCase();
  if (lower.startsWith('hk')) {
    const text = await fetchTencentHkQfqText(stockId, startYmd, endYmd, range);
    return { text, sourceLabel: '腾讯财经（港股前复权日线）' };
  }

  const text = await fetchSohuQfqText(stockId, startCompact, endCompact);
  return { text, sourceLabel: '搜狐财经' };
}
