/**
 * 量价掘金「微信扫码登录」面板（Task 6）。
 *
 * 经 startLoginWatch（SSE 长连接，模块级单例）截获微信扫码登录态：
 * - loadSession 无效时先推 `{type:'qrcode', data:{did}}`（准备中占位）并启动监听；
 * - SSE onQrcode(url) → `{type:'qrcode', data:{url}}`；
 * - SSE onLogin(session) → `{type:'success', data}` + stop + 刷新侧边栏树
 *   （provider 引用经 registerQuantProviderForRefresh 注册）。
 *
 * 惯例沿用 stockFundFlow：attached Set 防复用面板重复挂监听、
 * 失败静默不抛错、console.error 只打 message。
 */
import { ViewColumn } from 'vscode';
import ReusedWebviewPanel from './ReusedWebviewPanel';
import { getTemplateFileContent } from '../shared/utils';
import {
  LjgxSession,
  LjgxStorage,
  getDeviceId,
  loadSession,
  startLoginWatch,
} from '../shared/ljgxData';
import { refreshQuantTree } from '../explorer/quantProvider';

const VIEW_TYPE = 'leek-fund.quantLogin';
const TITLE = '微信扫码登录';

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

/** 存储引用：registerQuant 命令处理器内经 initQuantLogin 注入 */
let loginStore: LjgxStorage | null = null;

/** 存储注入（registerQuant 调用）——保持 quantLogin() 无参签名 */
export function initQuantLogin(store: LjgxStorage): void {
  loginStore = store;
}

/** 模块级登录监听单例：持有 startLoginWatch 的 stop，重复 ready 不重复连接 */
let watchStop: (() => void) | null = null;
/** 最近一次 SSE 收到的二维码图 url：复用面板时免等待回放 */
let lastQrcodeUrl = '';

function isWatching(): boolean {
  return watchStop !== null;
}

function stopWatch(): void {
  const stop = watchStop;
  watchStop = null;
  if (!stop) return;
  try {
    stop();
  } catch (e) {
    console.error('[LJGX] 停止登录监听失败', errMsg(e));
  }
}

async function post(panel: any, type: string, data: any): Promise<void> {
  try {
    await panel.webview.postMessage({ type, data });
  } catch (e) {
    console.error('[LJGX] 推送登录面板消息失败', errMsg(e));
  }
}

/** 读取设备号（getDeviceId 会生成并固化 did，存储更新失败静默） */
function resolveDid(store: LjgxStorage): string {
  try {
    return getDeviceId(store);
  } catch (e) {
    console.error('[LJGX] 读取设备号失败', errMsg(e));
    return '';
  }
}

function startWatch(panel: any, store: LjgxStorage): void {
  if (watchStop) return; // 已在监听（含断线重连中），不重复连接

  try {
    const did = resolveDid(store);
    if (!did) return;

    const watch = startLoginWatch(
      did,
      {
        onQrcode: (url: string) => {
          lastQrcodeUrl = typeof url === 'string' ? url : '';
          if (lastQrcodeUrl) void post(panel, 'qrcode', { url: lastQrcodeUrl });
        },
        onLogin: (session: LjgxSession) => {
          stopWatch();
          lastQrcodeUrl = '';
          void post(panel, 'success', session);
          // 登录态变化 → 侧边栏「掘金」树从扫码入口切成用户 + 榜单
          refreshQuantTree();
        },
      },
      { store } // startLoginWatch 自行 saveSession 落库
    );
    watchStop = () => watch.stop();
  } catch (e) {
    console.error('[LJGX] 登录监听启动失败', errMsg(e));
    watchStop = null;
  }
}

/** ready / cancel 共用：已登录直接回放登录态，否则下发二维码并保障监听运行 */
async function handleReady(panel: any): Promise<void> {
  const store = loginStore;
  if (!store) {
    await post(panel, 'error', '登录组件未初始化，请重启 VS Code 后重试');
    return;
  }

  let session: LjgxSession | null = null;
  try {
    session = loadSession(store);
  } catch (e) {
    console.error('[LJGX] 读取会话失败', errMsg(e));
  }
  if (session && session.sessionId) {
    await post(panel, 'session', session);
    return;
  }

  const did = resolveDid(store);
  if (!did) return;

  if (isWatching()) {
    // 复用面板重复 ready：不重复连接，回放最近二维码（无则保持准备中占位）
    if (lastQrcodeUrl) {
      await post(panel, 'qrcode', { url: lastQrcodeUrl });
    } else {
      await post(panel, 'qrcode', { did });
    }
    return;
  }

  // 先推准备中占位（SSE 首帧未到时无二维码图 url），再启动长连接
  await post(panel, 'qrcode', { did });
  startWatch(panel, store);
}

function handleMessage(panel: any, message: any): void {
  const command = message && typeof message.command === 'string' ? message.command : '';
  switch (command) {
    case 'ready':
      void handleReady(panel);
      break;
    case 'cancel': // 手动重试：掐掉当前监听重连
      stopWatch();
      lastQrcodeUrl = '';
      void handleReady(panel);
      break;
    default:
      break;
  }
}

/**
 * 打开「微信扫码登录」窗口（无需登录即可打开）。
 */
export function quantLogin(): void {
  const panel = ReusedWebviewPanel.create(VIEW_TYPE, TITLE, ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });

  if (attached.has(VIEW_TYPE)) {
    // 复用已存在的面板：脚本仍在运行，主动重推一次登录态/二维码
    void handleReady(panel);
    return;
  }

  attached.add(VIEW_TYPE);
  panel.onDidDispose(() => {
    attached.delete(VIEW_TYPE);
    stopWatch();
    lastQrcodeUrl = '';
  });
  panel.webview.onDidReceiveMessage((message: any) => handleMessage(panel, message));
  panel.webview.html = getTemplateFileContent('quant-login.html', panel.webview);
}

export default quantLogin;
