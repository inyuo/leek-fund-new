/**
 * 量价掘金（ljgx）侧边栏树视图 + 贡献点配套命令。
 *
 * 2026-11-04 精简：树不再展示明盘/暗盘资金榜（原 shares.get_dark_buy），
 * 也不再为每个 tab 单列入口 —— 只保留「登录态节点 + 单个打开量化面板入口」。
 * 入口默认 north（免登录且稳定），面板内 4 个 tab 自行切换。
 *
 * 节点编排抽成纯函数 buildQuantNodes(state)（不依赖 vscode 运行时，
 * 单测直接断言节点序列）；Provider 只保留会话静默校验与 5min TTL。
 */
import { Event, EventEmitter, TreeDataProvider, TreeItem } from 'vscode';
import { LjgxSession, LjgxStorage, checkSession, loadSession } from '../shared/ljgxData';

/* ---------- 节点编排（纯逻辑，不依赖 vscode 运行时） ---------- */

export type QuantNodeKind = 'login' | 'user' | 'panel';

/** 面板内部仍有 4 个 tab；树只通过 north 进入 */
export type QuantPanelTab = 'north' | 'index' | 'cjl' | 'lq';

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
  payload?: QuantPanelPayload;
}

/** buildQuantNodes 输入状态：由 provider 从缓存归一得出 */
export interface QuantState {
  session: LjgxSession | null;
  sessionValid: boolean;
}

const LOGIN_LABEL = '微信扫码登录';
const PANEL_ENTRY_LABEL = '打开量化面板';
/** 唯一入口的默认 tab：北向资金（免登录且稳定） */
const DEFAULT_PANEL_TAB: QuantPanelTab = 'north';

/**
 * 节点编排（pure）：
 * - 未登录（session 无效）→ [login, panel(north)]；
 * - 已登录 → [user, panel(north)]；
 * 榜单与重复 tab 入口已移除，面板内 4 个 tab 自行切换。
 */
export function buildQuantNodes(state: QuantState): QuantNodeSpec[] {
  if (!state.sessionValid || !state.session) {
    return [loginSpec(), panelSpec()];
  }
  return [userSpec(state.session), panelSpec()];
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

function panelSpec(): QuantNodeSpec {
  return {
    kind: 'panel',
    label: PANEL_ENTRY_LABEL,
    command: {
      title: PANEL_ENTRY_LABEL,
      command: 'leek-fund.quantOpen',
      arguments: [{ tab: DEFAULT_PANEL_TAB }],
    },
    payload: { tab: DEFAULT_PANEL_TAB },
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

/* ---------- 登录面板 → 树刷新钩子 ---------- */

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
  readonly payload?: QuantPanelPayload;

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

/** 会话校验（re_login POST）TTL：getChildren 每次重绘都会走 computeState，不能每次都发请求 */
const SESSION_CHECK_TTL_MS = 5 * 60 * 1000;

export interface QuantProviderDeps {
  /** 生产端传 createVscodeStorage(context.globalState)；测试传内存实现 */
  store: LjgxStorage;
  /** 测试注入 mock；生产默认 ljgxData 的 checkSession */
  checkSession?: typeof checkSession;
}

export class QuantProvider implements TreeDataProvider<QuantTreeItem> {
  private _onDidChangeTreeData: EventEmitter<any> = new EventEmitter<any>();
  readonly onDidChangeTreeData: Event<any> = this._onDidChangeTreeData.event;

  private store: LjgxStorage;
  private doCheckSession: typeof checkSession;

  /** 缓存状态：session + checkSession 结果 */
  private session: LjgxSession | null = null;
  private sessionValid = false;
  private sessionCheckTime = 0; // 最近一次 checkSession 时间（成功/失败都刷新）
  private inflight: Promise<void> | null = null;

  constructor(deps: QuantProviderDeps) {
    this.store = deps.store;
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

  /** 刷新命令：重新校验会话 + 重绘（榜单已移除） */
  async refreshData(): Promise<void> {
    this.sessionCheckTime = 0;
    this.inflight = null;
    await this.ensureState();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** 启动静默预热：不 await，校验会话完成后自动重绘 */
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
      this.sessionCheckTime = 0;
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
      return;
    }
    const checked = await this.doCheckSession(this.store);
    this.session = checked;
    this.sessionCheckTime = now;
    // 会话过期（re_login relogin:true 已被 checkSession 清库）→ 未登录态
    this.sessionValid = !!checked;
  }
}

/** 日志只取 message：避免错误对象（含完整 config/request）刷屏 */
function errMsg(e: any): string {
  if (!e) return String(e);
  if (typeof e === 'string') return e;
  return e.message || e.code || String(e);
}
