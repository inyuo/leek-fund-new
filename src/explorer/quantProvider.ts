/**
 * 量价掘金（ljgx）侧边栏树视图 + 贡献点配套命令。
 *
 * 节点编排抽成纯函数 buildQuantNodes(state)（不依赖 vscode 运行时，
 * 单测直接断言节点序列），QuantTreeItem / QuantProvider 在其上做
 * TreeItem 收尾与会话校验、榜单 TTL 缓存：
 * —— 单测经 test/helpers/vscode-mock.js 桩掉 vscode 直接 require 本模块。
 */
import { Event, EventEmitter, TreeDataProvider, TreeItem } from 'vscode';
import {
  DarkBuyItem,
  LjgxSession,
  LjgxStorage,
  checkSession,
  fetchDarkBuy,
  loadSession,
} from '../shared/ljgxData';

/* ---------- 节点编排（纯逻辑，不依赖 vscode 运行时） ---------- */

export type QuantNodeKind = 'login' | 'user' | 'darkHeader' | 'darkRow' | 'panel';
export type QuantPanelTab = 'north' | 'index' | 'cjl';

/** panel 节点载荷：量化面板 tab 入口 */
export interface QuantPanelPayload {
  tab: QuantPanelTab;
}

/** 节点规格：QuantTreeItem 的 vscode 无关形态（command 为 plain 命令描述） */
export interface QuantNodeSpec {
  kind: QuantNodeKind;
  label: string;
  description?: string;
  tooltip?: string;
  command?: { title: string; command: string; arguments?: any[] };
  payload?: DarkBuyItem | QuantPanelPayload;
}

/** buildQuantNodes 输入状态：由 provider 从缓存归一得出 */
export interface QuantState {
  session: LjgxSession | null;
  sessionValid: boolean;
  darkBuy: { title: string; list: DarkBuyItem[] } | null;
  darkBuyFailed: boolean;
}

const LOGIN_LABEL = '微信扫码登录';
const EMPTY_LIST_LABEL = '暂无榜单数据';
const FAILED_LIST_LABEL = '榜单加载失败（点击重试）';

const PANEL_LABELS: { [tab in QuantPanelTab]: string } = {
  cjl: '量价分层',
  north: '北向资金',
  index: '大盘指数',
};

/**
 * 节点编排（pure）：
 * - 未登录（session 无效）→ [login, panel(north), panel(index)]（北向/大盘免登录）；
 * - 已登录 → [user, darkHeader, ...darkRows, panel(cjl), panel(north), panel(index)]；
 * - 榜单接口失败 → 「榜单加载失败（点击重试）」占位（挂 refreshQuant 命令）；
 * - 榜单变空 → 「暂无榜单数据」占位。
 */
export function buildQuantNodes(state: QuantState): QuantNodeSpec[] {
  if (!state.sessionValid || !state.session) {
    return [loginSpec(), panelSpec('north'), panelSpec('index')];
  }
  return [
    userSpec(state.session),
    ...darkSpecs(state.darkBuy, state.darkBuyFailed),
    panelSpec('cjl'),
    panelSpec('north'),
    panelSpec('index'),
  ];
}

function loginSpec(): QuantNodeSpec {
  return {
    kind: 'login',
    label: LOGIN_LABEL,
    command: { title: '微信扫码登录', command: 'leek-fund.quantLogin' },
  };
}

/** user 节点：label=userName，tooltip=登录有效期（overdueTime 为 unix 秒） */
function userSpec(session: LjgxSession): QuantNodeSpec {
  return {
    kind: 'user',
    label: session.userName || '已登录',
    tooltip: formatExpireTooltip(session.overdueTime),
  };
}

function darkSpecs(darkBuy: QuantState['darkBuy'], darkBuyFailed: boolean): QuantNodeSpec[] {
  if (darkBuyFailed || !darkBuy) {
    return [
      {
        kind: 'darkHeader',
        label: FAILED_LIST_LABEL,
        command: { title: '重新加载暗盘榜单', command: 'leek-fund.refreshQuant' },
      },
    ];
  }
  if (!darkBuy.list.length) {
    return [{ kind: 'darkHeader', label: EMPTY_LIST_LABEL }];
  }
  return [
    { kind: 'darkHeader', label: darkBuy.title || '暗盘买入' },
    ...darkBuy.list.map((item) => darkRowSpec(item)),
  ];
}

/** darkRow：点击经 leek-fund.stockFundFlowForStock 打开该股资金动态（handler 从 args[0].id 取 code） */
function darkRowSpec(item: DarkBuyItem): QuantNodeSpec {
  return {
    kind: 'darkRow',
    label: item.name || item.code,
    description: [item.td1, item.td2].filter(Boolean).join(' '),
    command: {
      title: '查看该股资金动态',
      command: 'leek-fund.stockFundFlowForStock',
      arguments: [{ id: item.code }],
    },
    payload: item,
  };
}

function panelSpec(tab: QuantPanelTab): QuantNodeSpec {
  const label = PANEL_LABELS[tab];
  return {
    kind: 'panel',
    label,
    command: { title: label, command: 'leek-fund.quantOpen', arguments: [{ tab }] },
    payload: { tab },
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** overdueTime（unix 秒）→ `登录有效期至 yyyy-MM-dd HH:mm`；非法值给未知提示 */
function formatExpireTooltip(overdueTime: number): string {
  if (typeof overdueTime === 'number' && overdueTime > 0) {
    const d = new Date(overdueTime * 1000);
    if (!isNaN(d.getTime())) {
      return (
        `登录有效期至 ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
        `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
      );
    }
  }
  return '登录有效期：未知';
}

/* ---------- 登录面板 → 树刷新钩子（Task 6） ---------- */

/** registerQuant 注册的 provider 引用；登录面板登录成功后经此回调 refresh */
let refreshTarget: { refresh(): void } | null = null;

/** 注册 provider 引用（registerQuant 在命令注册时调用） */
export function registerQuantProviderForRefresh(provider: { refresh(): void }): void {
  refreshTarget = provider;
}

/** 登录面板内部使用：触发侧边栏「掘金」树重绘（未注册时静默跳过） */
export function refreshQuantTree(): void {
  if (!refreshTarget) return;
  try {
    refreshTarget.refresh();
  } catch (e) {
    console.error('[LJGX] 刷新掘金树失败', errMsg(e));
  }
}

/* ---------- TreeItem / Provider（VS Code 层） ---------- */

export class QuantTreeItem extends TreeItem {
  readonly kind: QuantNodeKind;
  readonly payload?: DarkBuyItem | QuantPanelPayload;

  constructor(spec: QuantNodeSpec) {
    super(spec.label);
    this.kind = spec.kind;
    this.payload = spec.payload;
    if (spec.description) {
      this.description = spec.description;
    }
    if (spec.tooltip) {
      this.tooltip = spec.tooltip;
    }
    if (spec.command) {
      this.command = spec.command;
    }
    this.contextValue = spec.kind;
  }
}

/** 暗盘榜单缓存 TTL（当日 + 30 分钟，跨天失效） */
const DARK_TTL_MS = 30 * 60 * 1000;

/** 会话校验（re_login POST）TTL：getChildren 每次重绘都会走 computeState，不能每次都发请求 */
const SESSION_CHECK_TTL_MS = 5 * 60 * 1000;

export interface QuantProviderDeps {
  /** 生产端传 createVscodeStorage(context.globalState)；测试传内存实现 */
  store: LjgxStorage;
  /** 测试注入 mock；生产默认 ljgxData 的 fetchDarkBuy */
  fetchDarkBuy?: typeof fetchDarkBuy;
  /** 测试注入 mock；生产默认 ljgxData 的 checkSession */
  checkSession?: typeof checkSession;
}

export class QuantProvider implements TreeDataProvider<QuantTreeItem> {
  private _onDidChangeTreeData: EventEmitter<any> = new EventEmitter<any>();
  readonly onDidChangeTreeData: Event<any> = this._onDidChangeTreeData.event;

  private store: LjgxStorage;
  private doFetchDarkBuy: typeof fetchDarkBuy;
  private doCheckSession: typeof checkSession;

  /** 缓存状态：session + checkSession 结果、榜单（当日 + 30min TTL） */
  private session: LjgxSession | null = null;
  private sessionValid = false;
  private sessionCheckTime = 0; // 最近一次 checkSession 时间（成功/失败都刷新）
  private darkBuy: { title: string; list: DarkBuyItem[] } | null = null;
  private darkBuyFailed = false;
  private darkBuyTime = 0;
  private inflight: Promise<void> | null = null;

  constructor(deps: QuantProviderDeps) {
    this.store = deps.store;
    this.doFetchDarkBuy = deps.fetchDarkBuy || fetchDarkBuy;
    this.doCheckSession = deps.checkSession || checkSession;
  }

  /* Implement */
  getTreeItem(element: QuantTreeItem): TreeItem {
    return element;
  }

  getParent(): QuantTreeItem | null {
    return null;
  }

  /** 重绘（不重拉数据）：配置变更等场景 */
  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /** 刷新命令：清榜单缓存重新拉取 + 触发重绘 */
  async refreshData(): Promise<void> {
    this.darkBuy = null;
    this.darkBuyFailed = false;
    this.darkBuyTime = 0;
    this.inflight = null;
    await this.ensureState();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** 启动静默预热：不 await，校验会话并拉一次榜单，完成后自动重绘 */
  preload(): void {
    this.ensureState()
      .catch(() => undefined)
      .then(() => this._onDidChangeTreeData.fire(undefined));
  }

  async getChildren(): Promise<QuantTreeItem[]> {
    await this.ensureState();
    return buildQuantNodes(this.buildState()).map((spec) => new QuantTreeItem(spec));
  }

  private buildState(): QuantState {
    return {
      session: this.session,
      sessionValid: this.sessionValid,
      darkBuy: this.darkBuy,
      darkBuyFailed: this.darkBuyFailed,
    };
  }

  private async ensureState(): Promise<void> {
    if (this.inflight) {
      return this.inflight;
    }
    this.inflight = this.computeState().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async computeState(): Promise<void> {
    const session = loadSession(this.store);
    if (!session) {
      this.session = null;
      this.sessionValid = false;
      this.darkBuy = null;
      this.darkBuyFailed = false;
      this.darkBuyTime = 0;
      return;
    }

    // 静默校验登录态（网络失败时 checkSession 保留会话原样返回，不清库）；
    // 5min TTL 内直接沿用上次校验结果，避免 getChildren 重绘频繁打 re_login
    const now = Date.now();
    if (
      this.sessionValid &&
      this.session &&
      now - this.sessionCheckTime < SESSION_CHECK_TTL_MS
    ) {
      // TTL 内：沿用缓存会话
    } else {
      const checked = await this.doCheckSession(this.store);
      this.session = checked;
      this.sessionCheckTime = now; // 成功/失败（过期清库、网络降级）都刷新
      if (!checked) {
        // 会话过期（re_login relogin:true 已被 checkSession 清库）→ 未登录态
        this.sessionValid = false;
        this.darkBuy = null;
        this.darkBuyFailed = false;
        this.darkBuyTime = 0;
        return;
      }
    }
    this.sessionValid = true;

    // 榜单缓存：当日 + 30 分钟 TTL（复用上方 now）
    if (
      this.darkBuy &&
      this.darkBuyTime > 0 &&
      now - this.darkBuyTime < DARK_TTL_MS &&
      isSameDay(now, this.darkBuyTime)
    ) {
      return;
    }
    const data = await this.doFetchDarkBuy(2, 'all', { store: this.store });
    if (data) {
      this.darkBuy = { title: data.title, list: data.list };
      this.darkBuyFailed = false;
    } else {
      this.darkBuy = null;
      this.darkBuyFailed = true;
    }
    this.darkBuyTime = now;
  }
}

function isSameDay(a: number, b: number): boolean {
  const d1 = new Date(a);
  const d2 = new Date(b);
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
}

/** 日志只取 message：避免错误对象（含完整 config/request）刷屏 */
function errMsg(e: any): string {
  if (!e) return String(e);
  if (typeof e === 'string') return e;
  return e.message || e.code || String(e);
}
