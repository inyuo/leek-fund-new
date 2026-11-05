/**
 * 量价掘金主面板：三个 canvas Tab（量价分层 / 北向资金 / 大盘指数）
 * + 第 4 个 DOM 表格 Tab（策略选股，官网 pages/lq/lq 的 9 类策略）。
 *
 * 懒加载：init 只拉当前 tab 对应的数据（cjl → fetchShareCjl、north/index →
 * 免登录接口、lq → fetchLqList），其余字段推 null；Tab 切换消息推对应数据，
 * refresh 重拉当前 tab（并清当前策略缓存）。数据为空时由模板渲染占位/引导。
 *
 * 交互契约：
 * - 宿主 → 模板：`{type:'init', data:{tab, cjl, north, index, lq,
 *   cjlUnlogged, lqUnlogged, lqTags, lqDays, updatedAt}}`；未登录标记仅对应
 *   tab 为 true，模板据此区分「未登录引导」与「接口失败占位」。
 * - 模板 → 宿主：ready / refresh / selectTab{tab} / selectLqTag{tag} /
 *   selectLqDays{days} / openStock{code} / openLogin。
 *
 * 惯例沿用 stockFundFlow / quantLogin：attached Set 防复用面板重复挂监听、
 * 失败静默不抛错、console.error 只打 message。
 */
import { commands, ViewColumn } from 'vscode';
import ReusedWebviewPanel from './ReusedWebviewPanel';
import { getTemplateFileContent } from '../shared/utils';
import {
  LjgxStorage,
  fetchIndexSpark,
  fetchNorthFundTrends,
  fetchShareCjl,
  loadSession,
} from '../shared/ljgxData';
import { LQ_DAYS, LQ_TAGS, LqResult, fetchLqList } from '../shared/lqData';
import { quantLogin } from './quantLogin';

const VIEW_TYPE = 'leek-fund.quant';
const TITLE = '量价掘金';
const TEMPLATE = 'quant.html';

type QuantTab = 'cjl' | 'north' | 'index' | 'lq';

/** 策略选股缓存 TTL（服务端日频数据）与按 tag+days 分键的缓存/在途请求 */
const LQ_TTL_MS = 30 * 60 * 1000;
const lqCache = new Map<string, { time: number; data: LqResult | null }>();
const lqInflight = new Map<string, Promise<LqResult | null>>();

/** 量价分层接口默认查询集合：上证指数 + 深证成指（分层累计分布，登录接口） */
const CJL_CODES = ['sh000001', 'sz399001'];

/** 日志只取 message：避免错误对象（含完整 config/request）刷屏 */
function errMsg(e: any): string {
  if (!e) return String(e);
  if (typeof e === 'string') return e;
  return e.message || e.code || String(e);
}

/**
 * viewType → 是否已挂消息监听。
 * ReusedWebviewPanel 复用同一 panel，重复挂监听会导致同一条消息处理多次；
 * panel dispose 后移除标记。
 */
const attached = new Set<string>();

/** 存储引用：registerQuant 命令处理器内经 initQuantPanel 注入（判断 cjl 登录态用） */
let panelStore: LjgxStorage | null = null;

/** 当前展示 tab（复用面板时切换 tab 不重建窗口） */
let currentTab: QuantTab = 'north';

/** 可选个股权代码（命令带 code 参数时覆盖量价分层的默认查询集合） */
let currentCode = '';

/** 策略选股当前 tag / 天数（chips 切换后重拉，复用面板时保持） */
let currentLqTag = 'ztb';
let currentLqDays = 1;

/** 存储注入（registerQuant 调用）——保持 quantPanel() 只依赖 tab/code/tag 参数 */
export function initQuantPanel(store: LjgxStorage): void {
  panelStore = store;
}

/** 量价分层查询集合：命令参数带 code 时查个股，否则查两大指数 */
function cjlCodes(): string[] {
  return currentCode ? [currentCode] : CJL_CODES;
}

/** 是否已登录（loadSession 有效会话；读取异常视为未登录，不抛错） */
function isLogged(): boolean {
  const store = panelStore;
  if (!store) return false;
  try {
    return loadSession(store) !== null;
  } catch (e) {
    console.error('[量价掘金] 读取会话失败', errMsg(e));
    return false;
  }
}

/** 策略选股缓存 key：tag + 天数 */
function lqKey(tag: string, days: number): string {
  return `${tag}:${days}`;
}

/** 清缓存：refresh 清当前组合，登录态变化时全清 */
function clearLqCache(all = false): void {
  if (all) {
    lqCache.clear();
    return;
  }
  lqCache.delete(lqKey(currentLqTag, currentLqDays));
}

/**
 * 按 tag+days 拉策略榜单：30min TTL 命中即复用，同 key 在途请求合并。
 * 失败一律 null（fetchLqList 内部已降级），模板据此渲染失败占位。
 */
async function loadLq(tag: string, days: number): Promise<LqResult | null> {
  const key = lqKey(tag, days);
  const hit = lqCache.get(key);
  if (hit && Date.now() - hit.time < LQ_TTL_MS) return hit.data;

  const flying = lqInflight.get(key);
  if (flying) return flying;

  const task = fetchLqList(tag, days, { store: panelStore || undefined })
    .catch(() => null)
    .then((data) => {
      lqCache.set(key, { time: Date.now(), data });
      lqInflight.delete(key);
      return data;
    });
  lqInflight.set(key, task);
  return task;
}

/**
 * 推送当前 tab 的 init 数据。懒加载：只拉 tab 对应接口，其余字段恒 null；
 * 各 fetch 函数自带失败 → null 降级，这里再兜一层 catch 保证不抛错。
 */
async function pushInit(panel: any, tab: QuantTab): Promise<void> {
  let cjl: any = null;
  let north: any = null;
  let index: any = null;
  let lq: any = null;
  let cjlUnlogged = false;
  let lqUnlogged = false;

  try {
    if (tab === 'cjl') {
      // 未登录不发请求（fetchShareCjl 内部同样降级），由模板渲染登录引导
      if (!isLogged()) {
        cjlUnlogged = true;
      } else {
        cjl = await fetchShareCjl(cjlCodes(), { store: panelStore || undefined }).catch(() => null);
      }
    } else if (tab === 'north') {
      north = await fetchNorthFundTrends().catch(() => null);
    } else if (tab === 'index') {
      index = await fetchIndexSpark().catch(() => null);
    } else if (tab === 'lq') {
      // 未登录不发请求（fetchLqList 内部同样降级），模板渲染登录引导
      if (!isLogged()) {
        lqUnlogged = true;
      } else {
        const result = await loadLq(currentLqTag, currentLqDays);
        lq = result
          ? Object.assign({}, result, { tag: currentLqTag, days: currentLqDays })
          : null;
      }
    }
  } catch (e) {
    console.error('[量价掘金] 拉取面板数据失败', errMsg(e));
    cjl = null;
    north = null;
    index = null;
    lq = null;
  }

  try {
    await panel.webview.postMessage({
      type: 'init',
      data: {
        tab,
        cjl,
        north,
        index,
        cjlUnlogged,
        lq,
        lqUnlogged,
        lqTags: LQ_TAGS,
        lqDays: LQ_DAYS,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error('[量价掘金] 推送面板数据失败', errMsg(e));
  }
}

function handleMessage(panel: any, message: any): void {
  if (!message || typeof message.command !== 'string') return;

  switch (message.command) {
    // 前端脚本就绪：按当前 tab 懒加载（策略缓存命中不发请求）
    case 'ready':
      void pushInit(panel, currentTab);
      break;
    // 手动刷新：清当前策略组合缓存后重拉
    case 'refresh':
      clearLqCache();
      void pushInit(panel, currentTab);
      break;
    case 'selectTab': {
      const tab = message.tab;
      if (tab === 'cjl' || tab === 'north' || tab === 'index' || tab === 'lq') {
        currentTab = tab;
        void pushInit(panel, tab);
      }
      break;
    }
    case 'selectLqTag': {
      const tag = message.tag;
      if (typeof tag === 'string' && LQ_TAGS.some((t) => t.tag === tag)) {
        currentTab = 'lq';
        currentLqTag = tag;
        void pushInit(panel, 'lq');
      }
      break;
    }
    case 'selectLqDays': {
      const days = Number(message.days);
      if (LQ_DAYS.some((d) => d.num === days)) {
        currentTab = 'lq';
        currentLqDays = days;
        void pushInit(panel, 'lq');
      }
      break;
    }
    // 策略选股行「资金动态」→ 复用暗盘榜的个股命令
    case 'openStock': {
      const code = typeof message.code === 'string' ? message.code : '';
      if (!code) break;
      try {
        void commands.executeCommand('leek-fund.stockFundFlowForStock', { id: code });
      } catch (e) {
        console.error('[量价掘金] 打开个股资金动态失败', errMsg(e));
      }
      break;
    }
    // 未登录引导 → 打开微信扫码登录面板（registerQuant 已注入登录存储引用）
    case 'openLogin':
      try {
        quantLogin();
      } catch (e) {
        console.error('[量价掘金] 打开登录面板失败', errMsg(e));
      }
      break;
    default:
      break;
  }
}

/**
 * 打开「量价掘金」量化图表面板。
 * @param tab 初始 tab：cjl 量价分层 / north 北向资金 / index 大盘指数 /
 *   lq 策略选股（后三类中 lq 需登录，north/index 免登录）
 * @param code 可选个股权代码（tab==='cjl' 时替代默认指数查询集合）
 * @param tag 可选策略 tag（tab==='lq' 时定位到某一类，默认 ztb 涨停）
 */
export function quantPanel(tab: QuantTab, code?: string, tag?: string): void {
  if (tab === 'cjl' || tab === 'north' || tab === 'index' || tab === 'lq') {
    currentTab = tab;
  }
  currentCode = typeof code === 'string' ? code : '';
  if (typeof tag === 'string' && LQ_TAGS.some((t) => t.tag === tag)) {
    currentLqTag = tag;
  }

  const panel = ReusedWebviewPanel.create(VIEW_TYPE, TITLE, ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });

  if (attached.has(VIEW_TYPE)) {
    // 复用已存在的面板：脚本仍在运行，主动按当前 tab 重推一次即可
    void pushInit(panel, currentTab);
    return;
  }

  attached.add(VIEW_TYPE);
  panel.onDidDispose(() => attached.delete(VIEW_TYPE));
  panel.webview.onDidReceiveMessage((message: any) => handleMessage(panel, message));
  panel.webview.html = getTemplateFileContent(TEMPLATE, panel.webview);
}

export default quantPanel;
