# 量价掘金（ljgx）集成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 leek-fund 插件中集成 xxjwxc「量价掘金」：微信扫码登录（自绘二维码 + SSE 自动截获 sessionId）→ 侧边栏暗盘榜单树视图 + 量价分层/北向资金/大盘三个 canvas 面板图。

**Architecture:** 数据层 `src/shared/ljgxData.ts`（会话存储、SSE 登录监听、全部数据接口，失败静默降级）→ 树视图 `src/explorer/quantProvider.ts` + 两个 Webview 面板（`template/quant.html`、`template/quant-login.html` + `src/webview/*`，postMessage 注入数据，canvas 自绘，沿用 stock-fund-flow 模式）。

**Tech Stack:** TypeScript / axios（stream 方式解析 SSE）/ VS Code TreeView + ReusedWebviewPanel / mocha + 断言库（现有 `test/*.test.js` 基线）。

**Spec:** `docs/superpowers/specs/quant-gold-digger.md`（含已实测验证的接口契约，实现时以 spec 契约为准）

## Global Constraints

- 所有 xxjwxc/东财/腾讯请求失败一律返回 null/空/降级值，**不抛异常**；console.error 只打 message。
- session 凭据存 `context.globalState`（Memento），key 统一 `leek-fund.ljgxSession`、`leek-fund.ljgxDeviceId`；存储操作经 `LjgxStorage` 接口注入（`{get(key), update(key,value)}`），生产实现包 `vscode`，测试用内存 Map。
- base 地址 `https://www.xxjwxc.cn/shares/api/v1`；授权请求 header `user-token: <sessionId>`；响应 `{state:false, code:1018}` = 会话失效 → 触发清 session。
- src 内禁用元组 `[T, U?]` 语法（@typescript-eslint/parser@2.34.0 不支持）。
- 不新增 npm 依赖（不引 eventsource、echarts）。
- 测试命令 `yarn test:unit`（tsc 编译 + mocha test/**）；验证基线 tsc 0 error / eslint 0 error ≤5 warning / 103 passing 全绿。
- 版本号与打包走 `yarn package`（`scripts/package.js`，版本 `1.0.YYYYMMDDHHmmss`），不改 package.json 版本字段。

## Review Focus

1. **SSE 数据包分片/断流**：网络 chunk 可能把一行 `data:{...}` 切成两半 —— `extractSseEvents` 必须缓存不完整行（跨 chunk 拼接），直到遇 `\n\n` 事件边界才算完整事件。→ Task 1 Step 1 的分片测试钉住。
2. **会话过期/disconnect 后数据请求**：sessionId 被 `1018` 判定失效时，数据接口返回 null 且树视图回退未登录态，不能对 null 数据崩溃。→ Task 3 与 Task 5 的 1018 测试钉住。
3. **同 did 重连补状态**：登录监听器断线重连后首帧就是 `status:1`，必须照常入库（不能假设首帧永远是 status:0）。→ Task 2 测试钉住。
4. **非交易时段/空数据**：暗盘榜单 `list` 可能为空、量价 `price` 可能含 null 元素（之前实测出现过）—— 树视图空榜单显示占位节点、面板 canvas 对 null 跳过。→ Task 7 模板测试钉住。
5. **登录面板二次打开**：重复打开登录窗口时不得重复挂消息监听（复用 `attached` Set 模式）。→ Task 6 步骤 5 钉住。

---

### Task 1: 数据层核心 —— SSE 解析纯函数 + 会话存储

**Files:**
- Create: `src/shared/ljgxData.ts`
- Test: `test/ljgxData.test.js`

**Interfaces:**
- Consumes: `vscode`（仅生产侧）；axios。
- Produces（后续任务依赖的确切 API）:
  - `extractSseEvents(text: string): { events: string[]; rest: string }` —— 输入累计文本，输出完整事件 data 载荷数组（不含 `data:` 前缀、按行 trim）与残行。
  - `type LjgxSession = { sessionId: string; openId: string; overdueTime: number; userName: string; avatarUrl: string; did: string }`
  - `type LjgxStorage = { get(key: string): any; update(key: string, value: any): Thenable<void> }`
  - `getDeviceId(store: LjgxStorage): string`（无则生成 `LEEK_<ts36>_<rand>` 并固化）
  - `loadSession(store: LjgxStorage): LjgxSession | null`、`saveSession(store, s)`、`clearSession(store)`（接受 `RlCheckResult` 惯例见 Task 3）
  - `checkSession(store): Promise<LjgxSession | null>` —— re_login 校验，失败/`relogin:true` 清库并返回 null，成功刷新 overdueTime 后返回最新 session。

- [ ] **Step 1: 写失败测试**（test/ljgxData.test.js）

```js
// 1. extractSseEvents: 完整两帧处理
const { events, rest } = extractSseEvents('data:{"status":0}\n\ndata:{"status":1}\n\n');
assert.deepStrictEqual(events, ['{"status":0}', '{"status":1}']);
assert.strictEqual(rest, '');
// 2. 分片：半行缓存，rest 持有未消费文本
const a = extractSseEvents('data:{"url":"xx');
assert.deepStrictEqual(a.events, []);
assert.ok(a.rest !== '');
```

测试用例清单（每条一个行为）：
- `extractSseEvents 返回完整事件数组并清除已消费文本`
- `extractSseEvents 把不完整的行留在 rest`
- `extractSseEvents 组合 rest + 新 chunk 能恢复完整事件`
- `extractSseEvents 忽略 event: 行与注释行`
- `getDeviceId 首次生成并持久化、二次读取不变且格式为 /^LEEK_\w+_\w+$/`
- `saveSession/loadSession/clearSession 往返一致（内存 store）`
- `checkSession 带真实响应载荷（用户已验证格式）返回 null`（注入 axios mock，本任务统一用 `mockAxios` 注入 axios 模块导出——实现里 axios 经 `deps.axios` 可选注入，默认 require('axios')）

- [ ] **Step 2: 运行确认失败**：`yarn test:unit 2>&1 | grep ljgx` → FAIL with "extractSseEvents is not defined / ljgxData 模块未找到"。

- [ ] **Step 3: 实现最小代码**（仅 Task 1 列出的函数；`_cache` 为模块级跨调用缓冲）

实现顺序：`extractSseEvents`（纯函数：拆事件块、取 `data:` 行）→ `LjgxStorage` 生产实现 `createVscodeStorage()` → deviceId/session 存取 → `checkSession(store, deps?)`（`re_login` POST，header `user-token`，`data.relogin === false` 时刷新 `overdueTime` 并落库）。

- [ ] **Step 4: 运行确认通过**：`yarn test:unit 2>&1 | tail -5` → 本文件用例全 PASS，其余基线不受影响。

- [ ] **Step 5: Commit**：`git add src/shared/ljgxData.ts test/ljgxData.test.js && git commit -m "feat: ljgx 数据层核心（SSE 解析 + 会话存储）"`

### Task 2: 登录监听器（SSE 长连接）

**Files:**
- Modify: `src/shared/ljgxData.ts`
- Test: `test/ljgxData.test.js`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `extractSseEvents`、`saveSession`、`LjgxStorage`。
- Produces:
  - `startLoginWatch(did: string, handlers: { onQrcode(url: string, raw: any): void; onLogin(s: LjgxSession): void; }, deps?: { httpStream?: (url: string) => any; store?: LjgxStorage }): { stop(): void }` —— 生产 `httpStream` 用 axios GET `?did=<did>` `responseType:'stream'`；收到 data 帧 JSON：`status:1` → 组装 LjgxSession `{sessionId: raw.sessionId, openId: raw.userId, overdueTime: 0, userName, avatarUrl: raw.avatarUrl, did}` 落库并回调 onLogin 后自动停止；否则回调 onQrcode(raw.url)；流断开静默重连（一直重试）；`stop()` 关闭流并停重连。
  - 重连节流：失败后 1s 再试（防死循环）。

- [ ] **Step 1: 写失败测试**
  - `首帧 status:0 回调 onQrcode 且不落库`
  - `首帧直接 status:1（重连补状态场景）落库并回调 onLogin 后停`
  - `流断开后重连：注入假 httpStream 第二次成功，onLogin 正常触发`
  - `stop() 后不再重连也不再回调`
- [ ] **Step 2: 确认失败**（grep ljgxData 相关 FAIL）。
- [ ] **Step 3: 最小实现**（`createLoginWatch` 内部：EventEmitter 拼接 chunk → extractSseEvents → dispatch）。
- [ ] **Step 4: 确认通过 + 全基线绿**。
- [ ] **Step 5: Commit**：`git commit -m "feat: ljgx 登录监听器（SSE 长连接 + 断线重连）"`

### Task 3: 授权数据接口（暗盘榜单 / 量价分层）

**Files:**
- Modify: `src/shared/ljgxData.ts`
- Test: `test/ljgxData.test.js`（追加用例）

**Interfaces:**
- Consumes: Task 1 存取函数。
- Produces:
  - `type DarkBuyItem = { code: string; name: string; td1: string; td2: string; color1: string; color2: string; url: string; ext: string }`
  - `fetchDarkBuy(days = 2, tag = 'all', deps?: { axios; store; markExpired }): Promise<{ title: string; list: DarkBuyItem[] } | null>`
    - 带 `user-token` header；`data.state === false && data.code === 1018` → 调 `markExpired(store)`（= clearSession）返回 null；HTTP/网络失败返回 null。
    - 解析容错：`td1/td2/color1/color2/url/ext` 缺失用空串。
  - `fetchShareCjl(codes: string[], deps?): Promise<{ tm: string; price: number[] } | null>`（同错误策略；price 元素非数字剔除；`tm` 取 data.tm）。

- [ ] **Step 1: 失败测试**
  - `fetchDarkBuy 正常载荷 → 归一化数组 + title`
  - `fetchDarkBuy state:false code:1018 → 返回 null 且 clearSession 被调用（内存 store 验证）`
  - `fetchDarkBuy 网络异常 → null 不抛`
  - `fetchShareCjl 正常载荷与 price 过滤（含 null 元素场景）`
- [ ] **Step 2: 确认失败**。
- [ ] **Step 3: 最小实现**（axios POST 封装 xxjPostAuth(path, body, {sessionId})：统一 headers/timeout 30s/validateStatus true）。
- [ ] **Step 4: 确认通过 + 全基线绿**。
- [ ] **Step 5: Commit**：`git commit -m "feat: ljgx 授权数据接口（get_dark_buy / get_share_cjl + 1018 降级）"`

### Task 4: 免登录数据接口（北向资金 / 大盘）

**Files:**
- Modify: `src/shared/ljgxData.ts`
- Test: `test/ljgxData.test.js`（追加用例）

**Interfaces:**
- Consumes: axios（直连东财/腾讯）。
- Produces:
  - `fetchNorthFundTrends(deps?): Promise<{ times: string[]; hgtNet: number[]; szgtNet: number[] } | null>` —— 东财 `https://push2.eastmoney.com/api/qt/kamt.rtmin/get?fields1=f1,f2,f3,f4&fields2=f51,f52,f54,f56&ut=b2884a393a59ad64002292a3e90d46a5`；解析容错（s2n 逗号分隔归一化；字段缺失/空返回 null）。
  - `fetchIndexSpark(deps?): Promise<{ code: string; name: string; price: number[]; percent: number }[]>` —— 腾讯 `https://proxy.finance.qq.com/cgi/cgi-bin/market/hs/index?scenes=6`；容错同上。

- [ ] **Step 1: 失败测试**（两接口：正常解析 + 字段缺失返回 null；axios 注入 mock）。
- [ ] **Step 2: 确认失败**。
- [ ] **Step 3: 最小实现**。
- [ ] **Step 4: 确认通过 + 全基线绿**。
- [ ] **Step 5: Commit**：`git commit -m "feat: ljgx 免登录接口（北向资金分时 / 大盘指数）"`

### Task 5: 侧边栏树视图 + 贡献点注册

**Files:**
- Create: `src/explorer/quantProvider.ts`
- Modify: `package.json`（contributes.views / activationEvents / commands / menus）、`src/extension.ts`（注册）、`src/registerCommand.ts`（命令绑定）
- Test: `test/quantTree.test.js`

**Interfaces:**
- Consumes: Task 1~4 全部导出；现有 `stockFundFlow(code)`（`src/webview/stockFundFlow.ts`）经 `leek-fund.stockFundFlowForStock` 命令。
- Produces:
  - `class QuantTreeItem extends TreeItem`（字段：`kind: 'login'|'user'|'darkHeader'|'darkRow'|'panel'`，`payload?: DarkBuyItem | {tab: 'north'|'index'|'cjl'}`；构造函数设 label/description/tooltip/command/contextValue）
  - `class QuantProvider implements TreeDataProvider<QuantTreeItem>`：`constructor(getChildren deps)`；`getChildren()` 逻辑:
    - session 无效 → `[login 节点, panel(north), panel(index)]`
    - session 有效 → `[user 节点(label=userName, tooltip=有效期 yyyy-MM-dd HH:mm), darkHeader(展开 list), ...darkRows, panel('cjl'), panel('north'), panel('index')]`
    - 榜单变空 → 占位节点「暂无榜单数据」；接口失败 → 占位节点「榜单加载失败（点击重试）」挂 refresh 命令
  - `quantProvider.refresh()` 触发 `onDidChangeTreeData.fire()`
  - package.json 贡献点：views `{"id":"leekFundView.quant","name":"掘金"}`（leekFundMenu 内、settings 前）；activationEvents 加 `onView:leekFundView.quant`；commands：`leek-fund.quantLogin`（打开登录面板）、`leek-fund.quantOpen`（args tab 打开量化面板）、`leek-fund.refreshQuant`；menus：view/title（view == leekFundView.quant）→ refreshQuant 按钮与 darkRow 点击。darkRow 点击 command `leek-fund.stockFundFlowForStock`，arguments `[payload]`（复用现有 target.id 解析，payload 形如 `{id: code}`）。
  - extension.ts：`window.createTreeView('leekFundView.quant', {treeDataProvider: quantProvider})`；`registerQuant()`（registerCommand.ts 内新函数）绑定三个命令与启动时静默 `checkSession`（不 await）。

- [ ] **Step 1: 失败测试**（quantTree.test.js，用 mocha + node 断言；TreeItem 从 `out/` 编译产物 require）
  - `未登录 → 节点序列 = [login, panel(north), panel(index)]`
  - `已登录 + 榜单 2 行 → 序列 = [user, darkHeader, row1, row2, panel(cjl), panel(north), panel(index)]`，darkRow.command.arguments[0].id == code
  - `用户节点 tooltip 含 overdueTime 的日期文本`
  - `fetchDarkBuy 返回 null → 榜单位置为加载失败占位节点`
- [ ] **Step 2: 确认失败**（out/explorer/quantProvider 尚不存在 require 报错）。
- [ ] **Step 3: 实现**（quantProvider.ts + package.json 贡献点 + 注册代码一起最小落地）。
- [ ] **Step 4: 确认通过**：`yarn test:unit` 全绿；`grep leekFundView.quant package.json` 存在；tsc/eslint 0 error。
- [ ] **Step 5: Commit**：`git commit -m "feat: 量价掘金侧边栏树视图（登录态/暗盘榜单/面板入口）"`

### Task 6: 登录二维码面板

**Files:**
- Create: `template/quant-login.html`、`src/webview/quantLogin.ts`
- Modify: `src/registerCommand.ts`（`leek-fund.quantLogin` 绑定本模块导出）
- Test: `test/quantLoginView.test.js`（沿用 `test/helpers/webview-dom.js` 伪 DOM 基线执行模板内联脚本）

**Interfaces:**
- Consumes: Task 2 的 `startLoginWatch`、Task 5 的存储；`ReusedWebviewPanel.create`（现有 `src/webview/ReusedWebviewPanel.ts`）；`getTemplateFileContent`。
- Produces:
  - `export function quantLogin(): void`（命令处理器）—— 打开面板（VIEW_TYPE `leek-fund.quantLogin`，无需登录直接展示）；面板 onDidReceiveMessage `ready`/`cancel`；`ready` 时若已有有效 session → postMessage `{type:'session', data}`（显示已登录 + 有效期），否则启动 `startLoginWatch`（模块级单例，重复打开不重复连接，`attached` Set 守卫）并 postMessage `{type:'qrcode', data:{did}}`；SSE onQrcode → `{type:'qrcode', data:{url}}`；onLogin → `{type:'success', data}` 并 `quantProvider.refresh()`（Task 5 导出的 provider 引用，经 registerQuant 存模块级指针）。
  - 模板：状态文案 + `<img>`（qrcode url），底部说明「微信扫一扫→手机确认→自动登录」，成功态显示头像+昵称+有效期；3s 自动可手动重试按钮（cancel/重连）。

- [ ] **Step 1: 失败测试**（webview-dom 基线）
  - 推 `{type:'qrcode', data:{url}}` → `<img>` src 更新、状态文案变化
  - 推 `{type:'success', data}` → 显示昵称与有效期
  - 未收到任何消息 → 显示占位提示
- [ ] **Step 2: 确认失败**。
- [ ] **Step 3: 实现**（模板 + quantLogin.ts + 命令绑定）。
- [ ] **Step 4: 确认通过 + 全基线绿**。
- [ ] **Step 5: Commit**：`git commit -m "feat: 微信扫码登录面板（二维码自绘 + 自动截获登录态）"`

### Task 7: 量化图表面板（量价分层 / 北向 / 大盘）

**Files:**
- Create: `template/quant.html`、`src/webview/quantPanel.ts`
- Modify: `src/registerCommand.ts`（`leek-fund.quantOpen` 绑定）
- Test: `test/quantPanelView.test.js`（webview-dom 基线）

**Interfaces:**
- Consumes: Task 3 的 `fetchShareCjl`、Task 4 的 `fetchNorthFundTrends`/`fetchIndexSpark`、`ReusedWebviewPanel`。
- Produces:
  - `export function quantPanel(tab: 'cjl' | 'north' | 'index', code?: string): void`（VIEW_TYPE `leek-fund.quant`，Tab 由 init 消息切换；同 stockFundFlow 的 attached/postMessage 模式，`ready` 时按当前 Tab 推 `init` 数据：`{tab, cjl: {...}|null, north:{...}|null, index:[...]|null, updatedAt}`；`refresh` 消息重推；未登录时 Tab 的授权数据（cjl）显示未登录引导节点（点击复用 quantLogin 面板：经 `vscode.postMessage({command:'openLogin'})` → 面板宿主调 `quantLogin()`）。
  - 模板：三个 Tab 按钮 + canvas 绘制（量价分层：等长柱状分层图；北向：双折线；大盘：折线）；canvas 主题色沿用 stock-fund-flow.html 的 `readThemeColors()` 模式；null/空数据显示占位文字。

- [ ] **Step 1: 失败测试**
  - 初始化 tab=cjl → Tab 高亮正确；数据空 → 占位文字渲染
  - north 数据 → canvas 指令被调用（伪 DOM 计数 ctx 指令即可）
  - `openLogin` 消息 → 面板宿主调用 quantLogin（stub 断言）
- [ ] **Step 2: 确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 确认通过 + 全基线绿 + tsc/eslint**。
- [ ] **Step 5: Commit**：`git commit -m "feat: 量化图表面板（量价分层/北向/大盘 canvas 自绘）"`

### Task 8: 真机端到端验证 + 打包核验

**Files:**
- Modify: `docs/progress-money-flow.md`（追加进度记录小节）
- 不改代码（如 e2e 暴露 bug 则在对应任务文件修复 + 补测试）

**Interfaces:**
- Consumes: Task 1~7 全部导出。
- Produces: 终态交付（commit + vsix 包 + 文档更新）。

- [ ] **Step 1: 全量验证**：`yarn test:unit`（基线 103 + 新增全绿）、`yarn compile`（tsc 0 error）、`yarn lint`（0 error ≤5 warning baseline）。任何失败 → 修复后重跑。
- [ ] **Step 2: 真实接口 e2e**（node 直连编译产物脚本置于 `/tmp`，不入仓库）：`checkSession`（过期 sessionId → 回退未登录）、`fetchDarkBuy`（真实数据 vs 官网一致）、`fetchShareCjl`、`fetchNorthFundTrends`、`fetchIndexSpark`。
- [ ] **Step 3: UI 冒烟**（可选，需要用户配合扫码）：`F5` 扩展开发宿主，走验收标准 1~3。
- [ ] **Step 4: 文档记录**：progress-money-flow.md 追加本次集成设计与实测记录。
- [ ] **Step 5: 打包核验**：`yarn package` → 确认产物 vsix 名称含版本与预期文件（quant 相关模板 + 编译产物）→ 删除旧 vsix → `git status` 干净 → Commit 文档（若有）。产物路径仅在回复中报告，不提交。

---

## Self-Review 记录

- Spec 覆盖：R1→Task 1；R2→Task 2/6；R3→Task 5；R4→Task 7；非功能约束分布于各任务（1018/不抛错/无新依赖）。
- 类型一致性：`LjgxSession`/`DarkBuyItem` 名称在 Task 1/3/5/6/7 间一致；`LjgxStorage` 接口为 `{get, update}`。
- Review Focus 1~5 分别由 Task 1(1)/Task 3+5(2)/Task 2(3)/Task 7(4)/Task 6(5) 的测试钉住。
- 比例：计划约 spec 两倍长，无成段代码转录（测试代码仅列断言清单）。
