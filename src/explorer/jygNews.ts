/**
 * 资讯模块数据源：韭研公社社区流（/article/community，全市场文章，时间倒序）。
 *
 * 原「雪球用户动态」视图因雪球接口需 cookie 且已不可用而废弃；
 * 金十快讯 WebSocket 老协议实测已失效（服务端只回心跳、不再下发快讯），
 * 故改用实测可用的韭研公社社区文章流。
 */
const JYG_ARTICLE_BASE = 'https://www.jiuyangongshe.com/a/';

export interface JYGNewsItem {
  id: string;
  url: string;
  time: number;
  timeLabel: string;
  title: string;
  summary: string;
  /** 关联股票名称，用于树节点右侧展示 */
  stocksLabel: string;
  /** 登录后按官网来源分组时的来源标识；未登录/降级条目为空 */
  source?: string;
}

/** 去掉 HTML 标签、实体，压缩为单行摘要 */
function stripHtml(html: string): string {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    // 实体可能省略结尾分号（接口实测有 "排队&nbsp等" 这类写法）
    .replace(/&nbsp;?/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 时间展示：接口返回东八区时间 "2026-10-12 10:05:03"。
 * 直接截取字符串，避免时区换算带来的展示偏差。
 */
function formatTime(createTime: string): { timeLabel: string; time: number } {
  const raw = String(createTime || '').trim();
  const m = raw.match(/^\d{4}-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
  if (!m) {
    const parsed = Date.parse(raw.replace(' ', 'T') + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? '' : '+08:00'));
    if (Number.isNaN(parsed)) {
      return { timeLabel: '', time: 0 };
    }
    const d = new Date(parsed);
    const pad = (n: number) => String(n).padStart(2, '0');
    return {
      timeLabel: `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
      time: parsed,
    };
  }
  const ms = Date.parse(`${raw.slice(0, 10)}T${raw.slice(11, 19)}+08:00`);
  return { timeLabel: `${m[1]}-${m[2]} ${m[3]}:${m[4]}`, time: Number.isNaN(ms) ? 0 : ms };
}

/** 关联股票名称，最多展示 3 个，多余折叠为 +N */
function formatStocks(stockList: any[]): string {
  const names = (Array.isArray(stockList) ? stockList : [])
    .map((s) => (s && String(s.name || '').trim()) || '')
    .filter(Boolean);
  if (names.length <= 3) {
    return names.join(' ');
  }
  return `${names.slice(0, 3).join(' ')} +${names.length - 3}`;
}

export function buildJYGNewsItems(rawList: any[], limit = 100): JYGNewsItem[] {
  const items: JYGNewsItem[] = [];
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    if (items.length >= limit) break;
    if (!raw || raw.is_top) continue;

    const id = String(raw.article_id || '').trim();
    if (!id) continue;

    const { timeLabel, time } = formatTime(raw.create_time);
    items.push({
      id,
      url: `${JYG_ARTICLE_BASE}${id}`,
      time,
      timeLabel,
      title: stripHtml(raw.title) || '无标题',
      summary: stripHtml(raw.content),
      stocksLabel: formatStocks(raw.stock_list),
    });
  }
  return items;
}
