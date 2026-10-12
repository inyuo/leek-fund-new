# 打包报错修复 + review 后续

根因（已修复）：磁盘 node_modules 与 yarn.lock 漂移（cheerio 1.1.2 vs 1.0.0、htmlparser2 10 vs 9），
vsce 按 `yarn list`（lockfile 树）决定打包依赖路径，同时对每个依赖目录 `ignore: 'node_modules/**'`，
导致磁盘上 `htmlparser2/node_modules/entities@6.0.1` 被排除、顶层 `entities@4.5.0` 顶替，
产出 `htmlparser2@10 + entities@4.5.0` 的错配包，激活时报 ERR_PACKAGE_PATH_NOT_EXPORTED。

- [x] 1. 同步依赖并重新打包，验证产物可用
- [x] 2. RED/GREEN: manifest 一致性测试（`test/manifest.test.js`，先见 3 个失败）
- [x] 3. GREEN: 修 `c34756f` 引入的命令 id 改名不一致（`investment-monitor.*` → `leek-fund.*`）
- [x] 4. GREEN: 合并 `leekFundView.stock` 重复 viewsWelcome 条目
- [x] 5. 依赖漂移检测 `scripts/check-deps.js`（含 mutation 验证 + 3 组端到端场景验证）
- [x] 6. manifest 校验 CLI `scripts/check-manifest-cli.js`
- [x] 7. 两者接入 `package` 脚本前置
- [x] 8. 补 `.vscodeignore`（.codebuddy/.github/ai.md/yarn.lock/test/scripts/PLAN.md）
- [x] 9. 全量验证：lint 0 error / compile 0 / test:unit 7 passing / package 通过 / VSIX 自检无泄漏

## 验证记录

| 场景 | 结果 |
|---|---|
| 旧 VSIX 内 `require('htmlparser2')` | `ERR_PACKAGE_PATH_NOT_EXPORTED: './decode'`（与 exthost 日志逐字一致）|
| 新 VSIX 内 `require('htmlparser2')` + cheerio 解析 | 加载成功 |
| 磁盘 cheerio 版本篡改为 1.1.2 | check-deps 退出码 1（`yarn check --verify-tree` + 明细）|
| integrity 改成「按 1.1.2 安装」（本次事故形态）| check-deps 退出码 1（`Integrity check failed`）|
| package.json 命令改回缺陷版 | check-manifest 退出码 1 |
| VSIX 泄漏文件（.codebuddy/.github/ai.md 等）| 0 |
