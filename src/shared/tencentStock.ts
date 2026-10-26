import Axios from 'axios';
import Log from './log';
import { decode } from 'iconv-lite';

const searchUrl = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/smartbox/search/get';
const stockDataUrl = 'https://qt.gtimg.cn/q=';
const QUOTE_TIMEOUT = 15000;

/**
 * 解析腾讯批量行情文本为 代码→名称 映射。
 *
 * 响应形如 `v_sh600519="1~贵州茅台~600519~1333.10~...";`（GBK 编码），
 * 字段以 `~` 分隔，名称固定在第 2 段。无效代码返回 `v_pv_none_match="1";`，
 * 没有名称段 → 不入表。
 *
 * 实测（2026-10-26）：30 只一次请求约 15KB；`r_` 精简前缀对 A 股返回
 * pv_none_match，必须用原始代码前缀。
 */
export function parseStockNames(body: string): { [code: string]: string } {
  const names: { [code: string]: string } = {};
  if (typeof body !== 'string' || !body) return names;

  const re = /v_([0-9a-z]+)="([^"]*)"/gi;
  let matched: RegExpExecArray | null;
  while ((matched = re.exec(body)) !== null) {
    const code = matched[1].toLowerCase();
    const fields = String(matched[2] || '').split('~');
    const name = fields.length > 1 ? fields[1] : '';
    if (name) names[code] = name;
  }
  return names;
}

/**
 * 批量取自选股名称（腾讯行情，一次请求）。
 *
 * 供「资金动态」左侧列表显示股票名 —— 列表只有代码时可读性差。
 * 失败一律返回空对象，绝不抛异常：名称缺失只影响展示，不能拖垮资金流列表。
 */
export const fetchStockNames = async (codes: string[]): Promise<{ [code: string]: string }> => {
  const list = (Array.isArray(codes) ? codes : []).filter((c) => typeof c === 'string' && c);
  if (!list.length) return {};

  try {
    const res = await Axios.get(stockDataUrl, {
      params: { q: list.join(',') },
      responseType: 'arraybuffer',
      timeout: QUOTE_TIMEOUT,
      transformResponse: [
        (data) => {
          if (typeof data === 'string') return data;
          return decode(data, 'GBK');
        },
      ],
    });
    if (!res || res.status >= 400) return {};
    return parseStockNames(res.data);
  } catch (e) {
    Log.error('[腾讯] 批量取股票名称失败: ' + (e instanceof Error ? e.message : String(e)));
    return {};
  }
};

export const searchStockList = async (keyword: string) => {
  Log.info('searchStockList keyword: ', keyword);
  const stockResponse = await Axios.get(searchUrl, {
    params: {
      q: keyword,
    },
  });
  // Log.info('stockResponse: ', stockResponse.data);
  const stockListArray = stockResponse?.data?.data?.stock || [];
  // Log.info('stockListStr: ', stockListArray, keyword);
  const stockList = stockListArray.map((stockItemArr: string[]) => {
    return {
      code: stockItemArr[1].toLowerCase(),
      name: stockItemArr[2],
      market: stockItemArr[0],
      abbreviation: stockItemArr[3],
    };
  });
  Log.info('stockList: ', stockList, keyword);
  return stockList;
};

export const getTencentHKStockData = async (codes: string[]) => {
  // Log.info('before getStockData codes: ', codes);
  const stockDataResponse = await Axios.get(stockDataUrl, {
    responseType: 'arraybuffer',
    params: {
      q: codes.map((code) => `r_${code}`).join(','),
      fmt: 'json',
    },
    transformResponse: [
      (data) => {
        const body = decode(data, 'GBK');
        return JSON.parse(body);
      },
    ],
  });

  const stockDataList = codes.map((code: string) => {
    let codeConfiged = code;
    if (codeConfiged.startsWith('hk')) {
      codeConfiged = 'hk' + codeConfiged.substring(2).toLocaleLowerCase(); // 处理大小写，否则会造成删除不了
    } else {
      codeConfiged = codeConfiged.toLowerCase();
    }
    const rCode = `r_${code}`;
    const stockItemArr = stockDataResponse.data[rCode];
    if (!stockItemArr) {
      return {
        code: codeConfiged,
        name: 'NODATA',
      };
    }
    return {
      code: codeConfiged,
      name: stockItemArr[1],
      price: stockItemArr[3],
      yestclose: stockItemArr[4],
      open: stockItemArr[5],
      high: stockItemArr[33],
      low: stockItemArr[34],
      volume: stockItemArr[36],
      amount: stockItemArr[37],
      buy1: stockItemArr[9],
      sell1: stockItemArr[19],
      time: stockItemArr[30],
    };
  });
  // Log.info('stockDataList: ', stockDataList, codes);
  return stockDataList;
};
