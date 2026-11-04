# 量价掘金（ljgx）集成 Spec

## 背景

xxjwxc「复利备忘录」官网（https://www.xxjwxc.cn/webshares/）的「量价掘金」模块提供暗盘/明盘净流入榜单、量价分层数据、美元汇率、北向资金、大盘指数等数据。官方开源仓库（xxjwxc/shares）含其官方 VS Code 插件（vscode/a-shares）的完整实现，本次集成直接参照。

全部接口已于 2026-11-04 用真实调用实测验证通过（见本文「已验证接口契约」）。

## 目标

在 leek-fund 插件中集成量价掘金：未登录 → 插件内自绘微信扫码登录（自动截获 sessionId）；登录后 → 侧边栏树视图展示暗盘榜单 + Webview 面板展示量价分层 / 北向资金 / 大盘。

## 首版范围（用户已确认）

- **包含**：暗盘榜单（树视图）、量价分层图（面板）、北向资金/大盘图（面板，免登录）、微信扫码登录全链路。
- **不包含**（后续迭代）：美元人民币图、自选股状态同步（rg 红绿配色）、在线自选股增删（get_my_code / delete_my_code）。

## UI 决策（用户已确认）

1. 形态：侧边栏树视图 + Webview 面板（非纯面板、非纯数据层）。
2. 登录二维码：插件内自绘面板直接显示二维码图片 + 后台 SSE 自动截获（不用官方 iframe 方案、不用外部浏览器）。

## 已验证接口契约（实测，2026-11-04）

统一基址 `https://www.xxjwxc.cn/shares/api/v1`；成功响应 `{state:true, error:"normal", data:<payload>}`；失败 `{state:false, code:<int>, error:<msg>}`，**code 1018 = 未登录/缓存过期**。

| 功能 | 方法/路径 | 入参 | 出参 data 要点 | 鉴权 |
|---|---|---|---|---|
| 登录 SSE | `GET /weixin.login?did=<deviceId>` | deviceId | `event:msg` 流，第一帧 `{code, url:<微信二维码图片URL>, status:0, sessionId:""}`；扫码确认后同连接再推 `{status:1, userId, userName, avatarUrl, rg, sessionId}` | 无 |
| 登录态校验 | `POST /weixin.re_login` | `{}`，header `user-token: <sessionId>` | `{relogin:bool, sessionId, openId, overdueTime:<unix秒>, nickName, avatarURL, rg, vip...}` | 无（带 token 出结果） |
| 登出 | `POST /weixin.clear_login` | `{code:<did>}` | `{}` | 无 |
| 大盘快讯（免登录） | `POST /weixin.get_maga` | `{code:<did>}` | `{maga:[{name,url,icon}...]}` | 无 |
| 暗盘榜单 | `POST /shares.get_dark_buy` | `{days, tag}`（tag: all/dc/tx/ths），header `user-token` | `{title:<日期>, vaild, thList, list:[{code, name, ext, td1:<暗盘净流入>, td2:<明盘净流入>, color1, color2, url, ...}]}` | 需要 |
| 量价分层 | `POST /analy.get_share_cjl` | `{codes:[...]}`，header `user-token` | `{tm, price:<分层和数组>, ...}` | 需要 |

- **登录会话**：sessionId 7 天有效；**同一 did 在已扫码登录后重连 SSE 直接得到 `status:1 + sessionId`**（不要求保持首条连接），因此监听器断线可自动重连补状态。
- 免登录数据：北向资金用东财 `kamt.rtmin/get`；大盘指数用腾讯 `proxy.finance.qq.com/cgi/cgi-bin/market/hs/index?scenes=6`（大盘 CGI 免登录已验证过）。

## 需求

### R1 登录态管理

- 凭据（sessionId、openId、overdueTime、userName、avatarUrl）与 deviceId 存 VS Code `globalState`（Memento），不入 settings.json。
- deviceId 规则 `LEEK_` + 时间戳36进制 + 随机码，首次生成后持久化。
- 启动时静默 `checkSession()`：`re_login` 失败或返回 `relogin:true` → 清凭据回未登录态；成功刷新 overdueTime。
- 所有数据层函数失败一律返回 null/空，不抛异常（沿用 xxjwxcData 惯例）；数据接口遇 `code:1018` 标记会话失效。

### R2 登录链路

- 树视图「微信扫码登录」节点 → 打开登录面板 → 后台建立 SSE 监听 → 面板显示二维码图片。
- SSE 推 `status:1` → 保存 sessionId → 关闭面板内容切换成功态 → 刷新树视图与面板。
- SSE 断开自动重连（复用同 did）；15s 未收到首帧重试一次。

### R3 侧边栏树视图（view id `leekFundView.quant`，挂现有 `leekFundMenu` 容器）

- 未登录：置顶「点击扫码微信登录」节点 + 「北向资金」「大盘」面板入口（免登录可用）。
- 已登录：用户节点（昵称 + tooltip 显示有效期日期）；「暗盘榜单」分组 + 逐股行（名称 / 暗盘净流入 / 明盘净流入，点击 → 调 `leek-fund.stockFundFlowForStock`）；「量价分层」「北向资金」「大盘」面板入口。
- 暗盘榜单当日缓存（服务端就是日频数据），面板入口点击打开量化面板对应 Tab。

### R4 量化面板

- `template/quant.html`：三个 Tab（量价分层 / 北向资金 / 大盘），canvas 自绘（参照 stock-fund-flow.html 的主题色适配与 postMessage 数据注入），不引入 echarts。
- `template/quant-login.html`：二维码图片 + 状态文案；成功后自动变成功态。

## 非功能约束

- `@typescript-eslint/parser@2.34.0`：src 内禁用元组 `[T, U?]` 语法。
- 数据层与 UI 层分离：数据放 `src/shared/*Data.ts`，postMessage 通信；所有 xxjwxc/东财请求失败静默降级。
- 版本号与打包走既有 `scripts/package.js` 编排（`1.0.YYYYMMDDHHmmss`）。

## 验收标准

1. 未登录打开插件 → 树视图显示登录节点 → 点击弹出示二维码面板 → 扫码确认后 sessionId 自动入库、面板变成功态、树视图出现用户条与暗盘榜单。
2. 树视图暗盘榜单与官网 `get_dark_buy` 数据一致；行点击可以打开个股资金流。
3. 量化面板三个 Tab 均能出图（量价分层/北向/大盘），数据与官网对应页面一致。
4. 手动改坏 sessionId（模拟过期）→ 树视图回退未登录态，无崩溃、无未捕获异常。
5. TDD 全程先红后绿；`tsc 0 error`、`eslint 0 error（≤5 warning 基线）`、`yarn test:unit` 全绿；`yarn package` 产物核验通过。
