/**
 * 量价掘金主面板（Task 7）：三个 canvas Tab（量价分层 / 北向资金 / 大盘指数）。
 *
 * 懒加载：init 只拉当前 tab 对应的数据（cjl → fetchShareCjl 登录接口、
 * north/index → 免登录接口），其余字段推 null；Tab 切换消息推对应数据，
 * refresh 重拉当前 tab。数据为空时由模板渲染占位/未登录引导。
 *
 * 交互契约：
 * - 宿主 → 模板：`{type:'init', data:{tab, cjl, north, index,
 *   cjlUnlogged, updatedAt}}`（cjlUnlogged 仅 tab==='cjl' 且未登录时为 true，
 *   模板据此区分「未登录引导」与「接口失败占位」）；
 * - 模板 → 宿主：ready / refresh（重拉当前 tab）/ selectTab{tab}（切 tab）、
 *   openLogin → 宿主调 quantLogin() 打开微信扫码登录面板。
 *
 * 惯例沿用 stockFundFlow / quantLogin：attached Set 防复用面板重复挂监听、
 * 失败静默不抛错、console.error 只打 message。
 */
import { ViewColumn } from 'vscode';
import ReusedWebviewPanel from './ReusedWebviewPanel';
import { getTemplateFileContent } from '../shared/utils';
import {
  LjgxStorage,
  fetchIndexSpark,
  fetchNorthFundTrends,
  fetchShareCjl,
  loadSession,
} from '../shared/ljgxData';
import { quantLogin } from './quantLogin';

const VIEW_TYPE = 'leek-fund.quant';
const TITLE = '量价掘金';
const TEMPLATE = 'quant.html';

type QuantTab = 'cjl' | 'north' | 'index';

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

/** 存储注入（registerQuant 调用）——保持 quantPanel() 签名只有 tab/code */
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

/**
 * 推送当前 tab 的 init 数据。懒加载：只拉 tab 对应接口，其余字段恒 null；
 * 各 fetch 函数自带失败 → null 降级，这里再兜一层 catch 保证不抛错。
 */
async function pushInit(panel: any, tab: QuantTab): Promise<void> {
  let cjl: any = null;
  let north: any = null;
  let index: any = null;
  let cjlUnlogged = false;

  try {
    if (tab === 'cjl') {
      // 未登录不发请求（fetchShareCjl 内部同样降级），由模板渲染登录引导
      if (!isLogged()) {
        cjl = null;
        cjlUnlogged = true;
      } else {
        cjl = await fetchShareCjl(cjlCodes()).catch(() => null);
      }
    } else if (tab === 'north') {
      north = await fetchNorthFundTrends().catch(() => null);
    } else {
      index = await fetchIndexSpark().catch(() => null);
    }
  } catch (e) {
    console.error('[量价掘金] 拉取面板数据失败', errMsg(e));
    cjl = null;
    north = null;
    index = null;
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
    // 前端脚本就绪 / 手动刷新：重拉当前 tab
    case 'ready':
    case 'refresh':
      void pushInit(panel, currentTab);
      break;
    case 'selectTab': {
      const tab = message.tab;
      if (tab === 'cjl' || tab === 'north' || tab === 'index') {
        currentTab = tab;
        void pushInit(panel, tab);
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
 * @param tab 初始 tab：cjl 量价分层（登录）/ north 北向资金 / index 大盘指数（免登录）
 * @param code 可选个股权代码（tab==='cjl' 时替代默认指数查询集合）
 */
export function quantPanel(tab: 'cjl' | 'north' | 'index', code?: string): void {
  if (tab === 'cjl' || tab === 'north' || tab === 'index') {
    currentTab = tab;
  }
  currentCode = typeof code === 'string' ? code : '';

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
