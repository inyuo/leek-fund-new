import { ViewColumn, workspace } from 'vscode';
import ReusedWebviewPanel from './ReusedWebviewPanel';
import { getTemplateFileContent } from '../shared/utils';
import { loadStockFundRows, loadIndustryRows, loadStockDetail } from '../shared/fundFlowData';
import { LjgxStorage } from '../shared/ljgxData';

const VIEW_TYPE = 'leek-fund.stockFundFlow';
const TITLE = '资金动态';

/** 日志只取 message：避免 axios 错误对象（含完整 config/request）刷屏输出面板 */
function errMsg(e: any): string {
  if (!e) return String(e);
  if (typeof e === 'string') return e;
  return e.message || e.code || String(e);
}

/**
 * viewType → 是否已挂消息监听。
 * ReusedWebviewPanel 用面板池复用同一 panel，若每次开窗都挂一次监听，
 * 同一条消息会被处理多次（重复请求 + 重复渲染）。panel dispose 后移除标记。
 */
const attached = new Set<string>();

/**
 * 待选中的初始代码。
 * 前端脚本就绪前 postMessage 会丢消息，因此把它挂到 init 数据里下发，
 * 由前端在渲染列表时选中（支持"自选股右键 → 查看该股资金动态"直达）。
 */
let pendingInitialCode = '';

/**
 * 登录态存储：个股资金三块表格（analy.get_sp）需要 user-token。
 * 由命令注册处注入，与 initQuantPanel 同一来源（context.globalState）。
 */
let panelStore: LjgxStorage | null = null;

export function initStockFundFlow(store: LjgxStorage): void {
  panelStore = store;
}

/** 自选股列表来自本地配置，不依赖任何外部接口 */
function readWatchlist(): string[] {
  try {
    const raw = workspace.getConfiguration('leek-fund').get('stocks');
    if (!Array.isArray(raw)) return [];
    return raw.filter((code) => typeof code === 'string' && code.length > 0);
  } catch (e) {
    console.error('[资金动态] 读取自选股配置失败', errMsg(e));
    return [];
  }
}

/** 推送列表数据（粒度 A 自选股净流入 + 粒度 D 行业排名） */
async function pushInit(panel: any, initialCode?: string): Promise<void> {
  const codes = readWatchlist();
  const pair = await Promise.all([
    loadStockFundRows(codes).catch((e) => {
      console.error('[资金动态] 取自选股资金流失败', errMsg(e));
      return [];
    }),
    loadIndustryRows().catch((e) => {
      console.error('[资金动态] 取行业资金流失败', errMsg(e));
      return [];
    }),
  ]);

  try {
    await panel.webview.postMessage({
      type: 'init',
      data: {
        stocks: pair[0],
        industry: pair[1],
        total: codes.length,
        initialCode: typeof initialCode === 'string' ? initialCode : '',
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error('[资金动态] 推送列表数据失败', errMsg(e));
  }
}

/** 推送选中股详情（分时曲线 + 所属板块 + 第三方分析 + 资金三块表格） */
async function pushDetail(panel: any, code: string): Promise<void> {
  const detail = await loadStockDetail(code, { store: panelStore || undefined }).catch((e) => {
    console.error('[资金动态] 取个股详情失败', errMsg(e));
    return {
      code,
      name: '',
      price: 0,
      percent: 0,
      mainFlow: null,
      analysis: [],
      sectors: [],
      fundTables: [],
    };
  });

  try {
    await panel.webview.postMessage({ type: 'detail', data: detail });
  } catch (e) {
    console.error('[资金动态] 推送个股详情失败', errMsg(e));
  }
}

function handleMessage(panel: any, message: any): void {
  if (!message || typeof message.command !== 'string') return;

  switch (message.command) {
    // 前端脚本就绪：主动拉一次（postMessage 在页面未加载完成时会丢消息）
    case 'ready':
    case 'refresh': {
      const code = pendingInitialCode;
      pendingInitialCode = '';
      void pushInit(panel, code);
      break;
    }
    case 'select':
      if (message.code && typeof message.code === 'string') {
        void pushDetail(panel, message.code);
      }
      break;
    default:
      break;
  }
}

/**
 * 打开「资金动态」窗口。
 * @param initialCode 可选：直接选中该股（自选股右键入口），
 *                    不传则沿用上次选中的股票
 */
export function stockFundFlow(initialCode?: string): void {
  if (initialCode && typeof initialCode === 'string') {
    pendingInitialCode = initialCode;
  }

  const panel = ReusedWebviewPanel.create(VIEW_TYPE, TITLE, ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });

  if (attached.has(VIEW_TYPE)) {
    // 复用已存在的面板：脚本仍在运行，主动重推一次即可
    const code = pendingInitialCode;
    pendingInitialCode = '';
    void pushInit(panel, code);
    if (code) void pushDetail(panel, code);
    return;
  }

  attached.add(VIEW_TYPE);
  panel.onDidDispose(() => attached.delete(VIEW_TYPE));
  panel.webview.onDidReceiveMessage((message: any) => handleMessage(panel, message));
  panel.webview.html = getTemplateFileContent('stock-fund-flow.html', panel.webview);
}

export default stockFundFlow;
