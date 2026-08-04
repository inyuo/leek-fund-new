# Changelog (investment-monitor fork)

本 CHANGELOG 仅记录本 fork 分支 (`dev`) 的独立改动，与原版 LeekFund 无关。

## 1.0.0 (2026-08-03)

### Features
- 基金估值数据源由下线的天天基金接口迁移至新浪行情接口（GBK 解码 + Referer 验证）
- 扩展 id 由 `leek-fund` 重命名为 `investment-monitor`，避免与原版 Marketplace 扩展冲突

### Changes
- 快讯服务（金十/选股宝）输出与抽象层适配
- `leek-center` 前端路由与 App 入口调整
- `.gitignore` 补充 `.codebuddy/`、子目录 `node_modules`、构建产物等忽略项
