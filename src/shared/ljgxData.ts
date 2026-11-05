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
 * 登录的 SSE 流地址（微信扫码长连接）。
 * 帧载荷 {code, url, status, userId, userName, avatarUrl, rg, sessionId}：
 * status:0 = 等待扫码（url 为二维码图片直链）；status:1 = 已登录（sessionId 有值）。
 */
function buildLoginUrl(did: string): string {
  return `${LJGX_API_BASE}/weixin.login?did=${encodeURIComponent(did)}`;
}

/**
 * 生产 httpStream：axios GET 打开 SSE 流，返回响应流（Node Readable）。
 * 不设 timeout —— SSE 是长连接，设了会在空闲期被 axios 掐断；
 * 断线由流 error/close 事件兜底走静默重连，与 checkSession 的降级惯例一致。
 */
async function defaultHttpStream(url: string): Promise<any> {
  const res = await axios.get(url, { responseType: 'stream' });
  return res.data;
}

/** 统一关流：真 stream 用 destroy，假对象（EventEmitter 等）没有则静默跳过 */
function destroyStream(stream: any): void {
  if (!stream) return;
  try {
    if (typeof stream.destroy === 'function') stream.destroy();
    else if (typeof stream.close === 'function') stream.close();
  } catch (e) {
    console.error('[LJGX] 关闭登录流失败', errMsg(e));
  }
}

export interface LjgxLoginHandlers {
  /** 等待扫码：url 为二维码图片直链，raw 为整帧 JSON */
  onQrcode(url: string, raw: any): void;
  /** 已登录：组装好的会话（已落库） */
  onLogin(session: LjgxSession): void;
}

export interface LjgxLoginDeps {
  /** 测试注入假流；默认 axios GET responseType:'stream' */
  httpStream?: (url: string) => any;
  /** 默认由调用方传 createVscodeStorage(context.globalState) */
  store?: LjgxStorage;
}

/**
 * 登录监听器：SSE 长连接 + 断线重连。
 *
 * 流程：GET /weixin.login?did=<did> → 持有跨 chunk 残行 rest，chunk 到达时
 * 拼接后经 extractSseEvents 解析 → 逐帧 JSON 分发：
 * - status:1 → 组装 LjgxSession（openId←userId，overdueTime 先置 0 等首查补齐）
 *   落库并回调 onLogin，然后自动停止（不再重连、不再回调）；
 * - 其余帧 → 回调 onQrcode(raw.url, raw)。
 * 网络断开（end/close/error，含 httpStream 同步抛错与 Promise reject）→ 静默
 * 节流 1s 后重连，一直重试、绝不抛错；重连不清已存在的会话 —— 清库只由
 * checkSession 的业务信号（relogin:true）触发（任务 1 裁定延伸）。
 * stop() 关当前流并停重连；onLogin 后与 stop 后到达的帧一律忽略。
 * deps.httpStream 供测试注入假流（EventEmitter 模拟 data/end/error）。
 */
export function startLoginWatch(
  did: string,
  handlers: LjgxLoginHandlers,
  deps?: LjgxLoginDeps
): { stop(): void } {
  const url = buildLoginUrl(did);
  const store = deps && deps.store;
  const getStream = (deps && deps.httpStream) || defaultHttpStream;

  const RECONNECT_DELAY_MS = 1000; // 失败节流，防死循环

  let stopped = false; // 用户显式 stop()
  let done = false; // onLogin 已触发，自动停止
  let timer: any = null; // 待执行的重连
  let current: any = null; // 当前活跃流

  function stop(): void {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    destroyStream(current);
    current = null;
  }

  function scheduleReconnect(): void {
    if (stopped || done || timer) return;
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, RECONNECT_DELAY_MS);
  }

  function dispatchEvent(raw: any): boolean {
    if (raw && raw.status === 1 && typeof raw.sessionId === 'string' && raw.sessionId) {
      const session: LjgxSession = {
        sessionId: raw.sessionId,
        openId: typeof raw.userId === 'string' ? raw.userId : '',
        overdueTime: 0,
        userName: typeof raw.userName === 'string' ? raw.userName : '',
        avatarUrl: typeof raw.avatarUrl === 'string' ? raw.avatarUrl : '',
        did,
      };
      done = true;
      if (store) saveSession(store, session);
      handlers.onLogin(session);
      stop();
      return true;
    }
    // 等待扫码帧；sessionId 缺失的 status:1 视为脏帧，同样按二维码处理
    handlers.onQrcode(raw && raw.url, raw);
    return false;
  }

  function connect(): void {
    if (stopped || done) return;

    // httpStream 同步返回假流 → 同步挂接（保证注入流的事件不丢帧）；
    // 生产 axios 返回 Promise → then 挂接、catch 走断线重连。
    let result: any;
    try {
      result = getStream(url);
    } catch (e) {
      console.error('[LJGX] 登录流建立失败，稍后重连', errMsg(e));
      scheduleReconnect();
      return;
    }
    if (result && typeof result.then === 'function') {
      result.then(attachStream).catch((e: any) => {
        console.error('[LJGX] 登录流建立失败，稍后重连', errMsg(e));
        scheduleReconnect();
      });
      return;
    }
    attachStream(result);
  }

  function attachStream(stream: any): void {
    if (stopped || done) {
      // stop/onLogin 抢先发生：直接丢弃已建立的连接
      destroyStream(stream);
      return;
    }
    current = stream;

    let rest = ''; // 跨 chunk 残行缓冲（extractSseEvents 是纯函数，调用方持有）
    stream.on('data', (chunk: any) => {
      if (stopped || done) return;
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      const parsed = extractSseEvents(rest + text);
      rest = parsed.rest;
      for (const event of parsed.events) {
        let raw: any = null;
        try {
          raw = JSON.parse(event);
        } catch (e) {
          // 解析失败帧（任务裁定）：静默忽略，不断流不重连
          console.error('[LJGX] 登录帧 JSON 解析失败，忽略该帧', errMsg(e));
          continue;
        }
        if (dispatchEvent(raw)) return; // 已登录 → 自动停
      }
    });

    // 端上断流：end / close / error 任一即静默重连（可能多次触发，靠 timer 幂等）
    stream.on('end', scheduleReconnect);
    stream.on('close', scheduleReconnect);
    stream.on('error', (e: any) => {
      console.error('[LJGX] 登录流断开，稍后重连', errMsg(e));
      scheduleReconnect();
    });
  }

  connect();
  return { stop };
}

/**
 * 授权数据接口公共降级层：带 user-token 的 POST 封装（任务 3 裁定惯例：
 * 网络 / HTTP / 响应不可解析失败 → null 且不清会话；state:false 且 code:1018
 * （会话失效）→ markExpired(store)（默认 clearSession）+ null）。
 */
export interface LjgxFetchDeps {
  /** 测试注入假 axios；生产默认 require 的 axios */
  axios?: typeof axios;
  /** 生产侧传 createVscodeStorage(context.globalState) */
  store?: LjgxStorage;
  /** 会话失效钩子，默认 clearSession（Memento.update(key, undefined) 删 key） */
  markExpired?: (store: LjgxStorage) => void;
}

/**
 * 统一 POST：路径拼 LJGX_API_BASE、user-token header、timeout 30s、
 * validateStatus 恒 true（HTTP >= 400 归一为 null，不让 axios 抛）。
 * 返回 data.data 载荷（不可解析为 null），调用方只做字段归一化。
 */
export async function ljgxPostAuth(
  path: string,
  body: Record<string, any>,
  deps?: LjgxFetchDeps
): Promise<any> {
  const store = deps && deps.store;
  const session = store ? loadSession(store) : null;
  if (!session || !store) return null; // 未登录无凭据，直接降级（不发请求）

  const client = (deps && deps.axios) || axios;
  try {
    const res = await client.post(`${LJGX_API_BASE}/${path}`, body, {
      headers: {
        'Content-Type': 'application/json',
        'user-token': session.sessionId,
      },
      timeout: LJGX_TIMEOUT,
      validateStatus: () => true,
    });

    if (!res || res.status >= 400) {
      console.error('[LJGX]', path, 'HTTP error', res && res.status, res && res.statusText);
      return null;
    }

    const data = res.data;
    // 会话失效的业务信号：清库（经 markExpired 钩子，默认 clearSession）
    if (data && data.state === false && data.code === 1018) {
      console.error('[LJGX]', path, '会话失效（code:1018），清除会话');
      const markExpired = (deps && deps.markExpired) || clearSession;
      markExpired(store);
      return null;
    }
    if (!data || data.state !== true || !data.data) {
      console.error('[LJGX]', path, '响应不可解析（state!==true）');
      return null;
    }
    return data.data;
  } catch (e) {
    console.error('[LJGX]', path, '请求失败', errMsg(e));
    return null;
  }
}

/** 数字收敛：仅保留有限数字（剔除 null/NaN/Infinity/字符串） */
function validNumber(v: any): boolean {
  return typeof v === 'number' && isFinite(v);
}

/** 暗盘榜单条目归一化字段（解析容错：缺失字段一律空串） */
export interface DarkBuyItem {
  code: string;
  name: string;
  td1: string;
  td2: string;
  color1: string;
  color2: string;
  url: string;
  ext: string;
}

/** 字符串收敛：非字符串一律空串 */
function str(v: any): string {
  return typeof v === 'string' ? v : '';
}

/**
 * 暗盘榜单：POST /shares.get_dark_buy，body {days, tag}（默认 days=2, tag='all'）。
 * 成功 data.data = {title:<日期字符串>, vaild, thList, list:[...]}，此处只保留
 * title 与归一化后的 list（DarkBuyItem）。失败策略见 ljgxPostAuth。
 */
export async function fetchDarkBuy(
  days = 2,
  tag = 'all',
  deps?: LjgxFetchDeps
): Promise<{ title: string; list: DarkBuyItem[] } | null> {
  const payload = await ljgxPostAuth('shares.get_dark_buy', { days, tag }, deps);
  if (!payload) return null;

  const rawList = Array.isArray(payload.list) ? payload.list : [];
  const list: DarkBuyItem[] = rawList.map((it: any) => ({
    code: str(it && it.code),
    name: str(it && it.name),
    td1: str(it && it.td1),
    td2: str(it && it.td2),
    color1: str(it && it.color1),
    color2: str(it && it.color2),
    url: str(it && it.url),
    ext: str(it && it.ext),
  }));
  return { title: str(payload.title), list };
}

/**
 * 量价分层（成交量接口）：POST /analy.get_share_cjl，body {codes:[...]}。
 * 成功 data.data = {tm:<日期>, price:<数值数组，可能含 null 元素>, ...}，
 * 此处只保留 tm 与过滤后的 price（剔除非有限数字）。失败策略同上。
 */
export async function fetchShareCjl(
  codes: string[],
  deps?: LjgxFetchDeps
): Promise<{ tm: string; price: number[] } | null> {
  const body = { codes: Array.isArray(codes) ? codes : [] };
  const payload = await ljgxPostAuth('analy.get_share_cjl', body, deps);
  if (!payload) return null;
  if (!Array.isArray(payload.price)) {
    console.error('[LJGX] analy.get_share_cjl 载荷不可解析（price 非数组）');
    return null;
  }
  return {
    tm: str(payload.tm),
    price: payload.price.filter(validNumber),
  };
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

/** ---------- 免登录数据接口（任务 4：北向资金分时 / 大盘指数）---------- */

/* 免登录接口不走 xxjwxc 登录态，直连东财 push2 与腾讯 proxy；东财 push2 有
 * IP 频率风控前科（见 emMoneyFlow.ts），浏览器 UA/Referer 与 15s 超时沿用其
 * 惯例。失败一律返回 null，绝不抛异常。 */

const EM_KAMT_URL =
  'https://push2.eastmoney.com/api/qt/kamt.rtmin/get' +
  '?fields1=f1,f2,f3,f4&fields2=f51,f52,f54,f56&ut=b2884a393a59ad64002292a3e90d46a5';
const QQ_INDEX_URL = 'https://proxy.finance.qq.com/cgi/cgi-bin/market/hs/index?scenes=6';

const FREE_TIMEOUT = 15000;
const FREE_HEADERS = {
  Referer: 'https://quote.eastmoney.com/',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};

/**
 * 数字收敛：数字直取，数字字符串转数；空串/`-`/非数字返回 NaN。
 * 东财分时样本未到时刻用 `-` 占位、腾讯分时条目为 "0930 价格 量" 空格串，
 * 统一经此处过滤。
 */
function strNumber(v: any): number {
  if (validNumber(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return isFinite(n) ? n : NaN;
  }
  return NaN;
}

/** 北向资金分时（kamt.rtmin s2n）归一化结果：三数组按下标对齐 */
export interface NorthFundTrends {
  times: string[];
  hgtNet: number[];
  szgtNet: number[];
}

/**
 * 解析东财 kamt.rtmin 载荷（纯函数）。
 *
 * data.s2n 是『时间,沪股通净流入,深股通净流入,合计』字符串数组（fields2 顺序
 * f51,f52,f54,f56），如 "9:30,5.10,6.20,11.30"；未到样本为 "10:56,-,-,-"。
 * 归一化：`-`/空串/非数字样本整行剔除，保证三数组严格对齐；无任何有效样本
 * （s2n 缺失、非数组或全空）返回 null。
 */
export function parseNorthFundTrends(payload: any): NorthFundTrends | null {
  const s2n = payload && payload.data && payload.data.s2n;
  if (!Array.isArray(s2n)) return null;

  const times: string[] = [];
  const hgtNet: number[] = [];
  const szgtNet: number[] = [];
  for (const row of s2n) {
    const parts = String(row || '').split(',');
    const hgt = strNumber(parts[1]);
    const szgt = strNumber(parts[2]);
    if (!isFinite(hgt) || !isFinite(szgt)) continue;
    times.push(String(parts[0] || '').trim());
    hgtNet.push(hgt);
    szgtNet.push(szgt);
  }
  if (!times.length) return null;
  return { times, hgtNet, szgtNet };
}

/**
 * 北向资金分时净流入（免登录，东财 kamt.rtmin）。
 * deps.axios 仅供测试注入；网络/HTTP/响应不可解析失败 → null 不抛。
 */
export async function fetchNorthFundTrends(
  deps?: { axios?: typeof axios }
): Promise<NorthFundTrends | null> {
  const client = (deps && deps.axios) || axios;
  try {
    const res = await client.get(EM_KAMT_URL, {
      headers: FREE_HEADERS,
      timeout: FREE_TIMEOUT,
      validateStatus: () => true,
    });
    if (!res || res.status >= 400) {
      console.error('[LJGX] kamt.rtmin HTTP error', res && res.status);
      return null;
    }
    return parseNorthFundTrends(res.data);
  } catch (e) {
    console.error('[LJGX] kamt.rtmin 请求失败', errMsg(e));
    return null;
  }
}

/** 大盘指数 spark 条目：分时价格序列 + 最新涨跌幅 */
export interface IndexSparkItem {
  code: string;
  name: string;
  price: number[];
  percent: number;
}

/** 腾讯分时样本 "0930 3605.39 5145513" → 价格段（第二段，非数字 NaN） */
function minuteRowPrice(row: any): number {
  const parts = typeof row === 'string' ? String(row).trim().split(/\s+/) : [];
  return parts.length > 1 ? strNumber(parts[1]) : NaN;
}

/** 条目涨跌幅：percent/zdf/Zdf 字段优先，缺失则由 pre（昨收）与最新价推导 */
function resolvePercent(it: any, lastPrice: number): number {
  for (const key of ['percent', 'zdf', 'Zdf']) {
    const n = strNumber(it[key]);
    if (isFinite(n)) return n;
  }
  const pre = strNumber(it.pre);
  if (isFinite(pre) && pre !== 0 && isFinite(lastPrice)) {
    return ((lastPrice - pre) / pre) * 100;
  }
  return NaN;
}

/**
 * 解析腾讯 hs/index 载荷（纯函数）。
 *
 * 实测（2026-11-04）scenes=6 响应无 esllt_list；等价数组为 data.minute_set
 * （对象值形态，条目 {code, pre, data:["0930 3605.39 …", …]}，无 name 字段）。
 * 防御式兼容：优先取 data.esllt_list（数组形态），否则取 minute_set 的值；
 * 条目 code 兼容 Symbol、name 兼容 Name，percent 兼容 zdf/Zdf 字段。
 * 只保留 price 序列非空且 percent 可解析的条目；整体解析不出返回 null。
 */
export function parseIndexSpark(payload: any): IndexSparkItem[] | null {
  const data = payload && payload.data;
  if (!data || typeof data !== 'object') return null;

  let items: any[] | null = null;
  if (Array.isArray(data.esllt_list)) items = data.esllt_list;
  else if (data.minute_set && typeof data.minute_set === 'object') {
    items = Object.keys(data.minute_set).map((k) => data.minute_set[k]);
  }
  if (!items) return null;

  const out: IndexSparkItem[] = [];
  for (const it of items || []) {
    if (!it || typeof it !== 'object') continue;
    const price = Array.isArray(it.price)
      ? it.price.filter(validNumber)
      : Array.isArray(it.data)
      ? it.data.map(minuteRowPrice).filter(isFinite)
      : [];
    if (!price.length) continue;

    const percent = resolvePercent(it, price[price.length - 1]);
    if (!isFinite(percent)) continue;
    out.push({
      code: str(it.code) || str(it.Symbol) || str(it.symbol),
      name: str(it.name) || str(it.Name),
      price,
      percent,
    });
  }
  return out.length ? out : null;
}

/**
 * 大盘指数 spark（免登录，腾讯 CGI hs/index）。
 * deps.axios 仅供测试注入；网络/HTTP/响应不可解析失败 → null 不抛。
 */
export async function fetchIndexSpark(
  deps?: { axios?: typeof axios }
): Promise<IndexSparkItem[] | null> {
  const client = (deps && deps.axios) || axios;
  try {
    const res = await client.get(QQ_INDEX_URL, {
      headers: FREE_HEADERS,
      timeout: FREE_TIMEOUT,
      validateStatus: () => true,
    });
    if (!res || res.status >= 400) {
      console.error('[LJGX] qq hs/index HTTP error', res && res.status);
      return null;
    }
    return parseIndexSpark(res.data);
  } catch (e) {
    console.error('[LJGX] qq hs/index 请求失败', errMsg(e));
    return null;
  }
}
