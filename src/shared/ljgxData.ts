/**
 * ljgx（xxjwxc「量价掘金」）数据源客户端 —— 数据层核心。
 *
 * 会话凭据存 VS Code `globalState`（Memento），经 `LjgxStorage` 接口注入：
 * 生产侧用 `createVscodeStorage(context)`，测试用内存 Map 实现。
 * 接口契约见 docs/superpowers/specs/quant-gold-digger.md（2026-11-04 实测验证）。
 *
 * 惯例沿用 xxjwxcData：所有函数失败一律返回 null / 降级值，绝不抛异常；
 * console.error 只打 message，不打完整 axios 错误对象。
 */
import axios from 'axios';

const LJGX_API_BASE = 'https://www.xxjwxc.cn/shares/api/v1';
const LJGX_TIMEOUT = 30000;

/** 凭据与设备号统一 key（globalState/Memento） */
const SESSION_KEY = 'leek-fund.ljgxSession';
const DEVICE_KEY = 'leek-fund.ljgxDeviceId';

/** 日志只取 message：axios 错误对象带完整 config/request/response，直接打会刷屏 */
function errMsg(e: any): string {
  if (!e) return String(e);
  if (typeof e === 'string') return e;
  return e.message || e.code || String(e);
}

/** 存储抽象：get 读值、update 写值（Thenable 同 Memento），测试可注入内存实现 */
export interface LjgxStorage {
  get(key: string): any;
  update(key: string, value: any): Thenable<void>;
}

/**
 * 生产实现：包一层全局状态（context.globalState）。
 * 只做透传 —— 不在此引入 vscode 依赖，保持本模块可在单测环境直接 require。
 */
export function createVscodeStorage(globalState: LjgxStorage): LjgxStorage {
  return {
    get: (key: string) => globalState.get(key),
    update: (key: string, value: any) => globalState.update(key, value),
  };
}

/** 微信扫码登录后的会话凭据（overdueTime 为 unix 秒） */
export interface LjgxSession {
  sessionId: string;
  openId: string;
  overdueTime: number;
  userName: string;
  avatarUrl: string;
  did: string;
}

/**
 * 读取设备号；无则生成 `LEEK_<时间戳36进制>_<随机码>` 并固化到 store。
 * 同一环境多次调用必须返回同一个值（服务端以 did 关联登录会话）。
 */
export function getDeviceId(store: LjgxStorage): string {
  const existing = store.get(DEVICE_KEY);
  if (typeof existing === 'string' && existing) return existing;

  const ts36 = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  const id = `LEEK_${ts36}_${rand}`;
  store.update(DEVICE_KEY, id);
  return id;
}

/** 读取会话；缺 sessionId / 脏数据一律视为未登录返回 null */
export function loadSession(store: LjgxStorage): LjgxSession | null {
  const raw = store.get(SESSION_KEY);
  if (!raw || typeof raw !== 'object' || typeof (raw as LjgxSession).sessionId !== 'string') {
    return null;
  }
  return raw as LjgxSession;
}

/** session 落库（Memento.update 返回 Thenable，存储失败静默） */
export function saveSession(store: LjgxStorage, session: LjgxSession): void {
  store.update(SESSION_KEY, session);
}

/** 清除会话（Memento.update 传 undefined 即删 key） */
export function clearSession(store: LjgxStorage): void {
  store.update(SESSION_KEY, undefined);
}

/**
 * 解析 SSE 累计文本：输出完整事件的 data 载荷数组（不含 `data:` 前缀、按行
 * trim）与残行 rest。事件以 `空行`（\n\n）为边界，只有边界之前的块才算完整；
 * `event:` 行、注释行（:开头）忽略；最后一块未终止 → 整体留在 rest。
 *
 * 调用方（登录监听器）持有 rest：下一 chunk 到达时拼在文本最前面再调本函数。
 * 这是纯函数、无内部缓冲 —— 分片重组逻辑由测试钉住（network chunk 可能切半行）。
 */
export function extractSseEvents(text: string): { events: string[]; rest: string } {
  const events: string[] = [];
  const parts = String(text || '').split('\n\n');
  const rest = parts.pop() || '';

  for (const block of parts) {
    for (const line of block.split('\n')) {
      const t = line.trim();
      if (t.indexOf('data:') === 0) {
        events.push(t.slice(5).trim());
      }
      // 其余行（event: / 注释 / 空行）按 SSE 约定忽略
    }
  }
  return { events, rest };
}

/**
 * 启动时静默校验登录态：POST /weixin.re_login（header user-token: sessionId）。
 * 只在业务明确信号时清会话：响应成功且 `relogin:true`（会话过期）→ 清库返回 null；
 * 响应成功且 `relogin:false` → 用响应里的 overdueTime/nickName/avatarURL 刷新本地
 * 会话并返回最新 session。
 * 网络失败 / HTTP 非 200 / 响应不可解析（state!==true）→ 失败静默降级：保留现有
 * 会话原样返回，不清库（与所有数据层函数「失败不抛错」惯例一致）。
 * deps.axios 仅供测试注入，生产默认 require 的 axios。
 */
export async function checkSession(
  store: LjgxStorage,
  deps?: { axios?: typeof axios }
): Promise<LjgxSession | null> {
  const session = loadSession(store);
  if (!session) return null;

  const client = (deps && deps.axios) || axios;
  try {
    const res = await client.post(`${LJGX_API_BASE}/weixin.re_login`, {}, {
      headers: {
        'Content-Type': 'application/json',
        'user-token': session.sessionId,
      },
      timeout: LJGX_TIMEOUT,
      validateStatus: () => true,
    });

    if (!res || res.status >= 400) {
      console.error('[LJGX] re_login HTTP error', res && res.status, res && res.statusText);
      return session;
    }

    // 外层 {state, error, data} 包装；re_login 载荷字段名与存储结构不同：
    // nickName→userName、avatarURL→avatarUrl、overdueTime 为 unix 秒
    const data = res.data && res.data.state === true ? res.data.data : null;
    if (!data) {
      console.error('[LJGX] re_login 响应不可解析（state!==true）');
      return session;
    }
    if (data.relogin !== false) {
      console.error('[LJGX] 会话过期（re_login relogin:true），清库回未登录态');
      clearSession(store);
      return null;
    }

    session.overdueTime =
      typeof data.overdueTime === 'number' ? data.overdueTime : session.overdueTime;
    if (typeof data.openId === 'string' && data.openId) session.openId = data.openId;
    if (typeof data.nickName === 'string' && data.nickName) session.userName = data.nickName;
    if (typeof data.avatarURL === 'string' && data.avatarURL) session.avatarUrl = data.avatarURL;
    saveSession(store, session);
    return session;
  } catch (e) {
    console.error('[LJGX] re_login 请求失败', errMsg(e));
    // 网络失败≠会话失效（业务信号），保守保留现有会话
    return session;
  }
}
