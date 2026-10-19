/**
 * 资讯降级数据源：xxjwxc（复利备忘录）财经头条。
 *
 * 韭研公社社区流是资讯主源，但其接口响应极不稳定（实测 0.7s~25.7s 波动，
 * 15s 超时经常触发）。当主源超时或返回空时，用头条标题兜底，
 * 避免资讯视图整片空白。
 *
 * 头条只有标题、没有原文链接与时间戳，因此条目降级为「快讯」样式：
 * url 指向 xxjwxc 资讯页，timeLabel 固定为「快讯」。
 */
import { JYGNewsItem } from './jygNews';

/** 头条无独立原文链接，点击跳到 xxjwxc 的资讯页 */
const HEADLINE_FALLBACK_URL = 'https://www.xxjwxc.cn/webshares/#/pages/news/news';
const MAX_TITLE_LENGTH = 120;
const SOURCE_TAG = 'xxjwxc-headline';

/**
 * 把头条标题数组转换成资讯树节点数据（与韭研条目同构，可直接复用树渲染）。
 * 空标题跳过，按 limit 截断，id 在同一批内唯一。
 */
export function buildHeadlineNewsItems(titles: any, limit = 50): JYGNewsItem[] {
  if (!Array.isArray(titles)) return [];

  const safeLimit = Math.max(0, limit);
  const items: JYGNewsItem[] = [];
  for (let i = 0; i < titles.length && items.length < safeLimit; i++) {
    const raw = titles[i];
    if (typeof raw !== 'string') continue;

    const title = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
    if (!title) continue;

    items.push({
      id: `${SOURCE_TAG}-${items.length}`,
      url: HEADLINE_FALLBACK_URL,
      time: 0,
      timeLabel: '快讯',
      title,
      summary: '',
      stocksLabel: '',
    });
  }
  return items;
}

export default { buildHeadlineNewsItems };
