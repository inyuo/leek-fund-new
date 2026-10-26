# 资金动态模块 · 实施进度

> 方案：**后端数据层 + postMessage**（方案二）+ **canvas 自绘图表**
> 数据源：xxjwxc 为主，东财/新浪为备（`fflow` 实测被反爬拦截，仅 `clist` 可用）
> 分支 `dev` · 起始基线 `39a1437`

## 范围（最终版，一次性交付）

四个粒度全部落地：

| 粒度 | 数据 | 来源 |
|---|---|---|
| A 每只自选股当日主力净流入 | 逐股列表 | xxjwxc `analy.get_share_main` |
| B 单股分时资金曲线 | price[] + main[] | xxjwxc `analy.get_share_main`（canvas 双轴） |
| C 自选股所属板块资金流 | 板块排名 | xxjwxc `shares.search` → `get_hy_time` |
| D 全行业资金流排名 | 496 板块 | 东财 `clist/get` ←→ xxjwxc `get_hy_time` 互备 |

三处消费：

1. **P1** 数据层 + 接入「AI分析股票」prompt 附录
2. **P2** 资讯视图第二数据源兜底（韭研超时/空时）
3. **P3** 新开「资金动态」窗口（四粒度 + canvas 曲线）

## 进度

- [x] 0. 接口结构验证（`get_hy_time` 有金额 `data:[name,jlr,tm]`；东财 `clist` 稳定、`fflow` 风控后已恢复）
- [x] 1. 数据层 `src/shared/xxjwxcData.ts` + 单测（先红后绿）
- [x] 2. 数据层 `src/shared/emMoneyFlow.ts` + 单测（30 passing，新增 30 用例）
- [x] 3. 接入 AI prompt 附录（`ai-service.ts` + `stock-news-view.ts` 两处，
      串行取数改 `Promise.all` 并发，三组数据各自 `.catch` 降级）
- [x] 4. 资讯第二源兜底（`newsService.ts` + 新增 `headlineNews.ts` 头条转换器）
- [x] 4b. 并发限流 `mapLimit`（`shared/utils.ts`，防打爆第三方）
- [x] 4c. 多源编排层 `src/shared/fundFlowData.ts`（A 逐股 / D 行业 / B+C 详情）
- [x] 5. 开窗 `src/webview/stockFundFlow.ts` + `template/stock-fund-flow.html`
      （四区 + canvas 双轴图，零外部依赖）
- [x] 6. 命令注册 2 条：`leek-fund.viewStockFundFlow`（命令面板）、
      `leek-fund.stockFundFlowForStock`（自选股右键，`group3`），
      通过 `check-manifest` 一致性测试
- [x] 4d. A 粒度备源接入：`xxjwxc 失败 → 东财 fflow 当日值`；
      删除未接入的新浪逐日源（语义为逐日粒度，与分时的 B 不匹配，
      作第三层降级的收益低于维护成本）
- [x] 7. 全量验证 `tsc` 0 error / `eslint` 0 error（5 warning 基线）/
      **83 passing**（新增 49，删 4 个新浪用例）/ 模板 script 语法检查
- [x] 7b. 端到端真实接口验证（不 mock）：
      A 3行过滤正确 · B 242 时点 · C 3 板块 · 分析结论完整 ·
      **数据一致性**（列表末值 == 详情末值 297097790）· 非 A 股空详情不发请求
- [x] 7c. 东财限流态验证：`toSecid` 全对、被限流时返回 null/空数组**不抛错**、
      重试 1 次生效、日志精简为单行（原 axios error 带 config/request 会刷屏）
- [x] 8. 提交 `65842fb`（15 files / +2692，husky lint + commitlint 通过）+
      重新打包 `investment-monitor-1.0.0.vsix`（3221 files / 6.37MB）；
      打包后核验：6 个新文件全部进包，并修复 `.vscodeignore` 漏掉的
      `docs/**`（进度文件首次打包时被带入，已排除并复验零泄漏）

## 设计约束（沿用既有教训）

- 数据层**可单测**（方案一被否的核心原因）
- 每块数据独立 `try/catch`，失败只让该区块显示「暂无数据」
  （韭研超时静默吞异常 → AI 说「无法抓取」的教训）
- 韭研/xxjwxc 统一 **30s 超时 + 重试 1 次**
- 失败绝不挂主流程

## 决策记录

- **不加 `leek-fund.xxjwxc.enabled` 配置开关**：YAGNI。降级链路已保证接口挂掉时
  区块显示「暂无数据」而非报错，开关只省几次失败请求噪音，不值得膨胀
  `package.json` 配置（已有 43 命令）。
- **不引入 echarts**：`price[]`/`main[]` 双数组画双轴约 60 行 canvas，
  不值得为它给 6.35MB 的包再加 800KB。
- **东财 API 有按 IP 的频率限制**（实测）：短时间内密集请求会把
  `/api/qt/clist/get` 和 `/fflow/kline/get` 拦成 `ECONNRESET`/`Empty reply`，
  而同期 `quote.eastmoney.com` 网页始终 200、`push2` 根路径 404（服务本身活着）。
  推论：正常插件使用频率远低于触发阈值，但仍需重试 + 限流 + 降级三重防护。
  `fetchEastIndustryFlow` 加重试 1 次即为此。
- **xxjwxc `get_hy_time` 只返回 12 个行业**（50 个时间点），不是全量 496。
  因此 D 粒度降级时只有「主要行业 12 个」——前端按 `IndustryRow.code` 是否存在
  标注数据源（东财有 BK 代码 → 全量；xxjwxc 无代码 → 备用源），不让用户误以为是全部。
- **A 粒度备源选东财 fflow、弃新浪逐日**：东财返回「当日主力净流入」单值，
  与 xxjwxc 分时序列末值语义一致；新浪是逐日粒度（字符串金额需转换、还要判断
  `opendate` 是否当天），作第三层降级的收益低于维护成本。备源只在主源失败时触发，
  此时粒度 B（分时曲线）同样是空的，所以不会出现「列表一个值、点进去另一个值」
  的跨源矛盾。

## 后续追加

- [x] **打包版本号带日期时间**（用户要求「每次打包产生变化」）：
  新增 `scripts/package.js` 编排打包，版本生成 `1.0.YYYYMMDDHHmmss`
  （例 `1.0.20261019170500`）——保持 1.0 主线前缀、时间戳单调递增以满足
  VS Code「新版本必须大于旧版本」的更新要求、patch 无前导零故 semver 合法。
  打包前临时写入 `package.json`，无论成败都用**原始字节还原**，
  版本只体现在产物上，git 工作区保持干净。`package` 脚本改为
  `node ./scripts/package.js`，原有 check-deps / check-manifest 前置检查保留。
  新增 `test/package-version.test.js` 7 用例（格式/补零/同秒稳定/跨秒必变/
  递增链/跨小时位数/semver），全量 **90 passing**。
  产物 `investment-monitor-1.0.20261019170500.vsix`（3221 files / 6.37MB），
  包内 `extension/package.json` 的 version 已确认为带日期的值。

## 窗口显示优化（2026-10-26，用户提出的两项）

- [x] **1. 左侧自选股显示股票名称**
  根因：`StockFundRow` 只有 `code/mainNet/tm/source`，后端从未取过名称，
  前端只能渲染代码 `sh600519`。
  方案（实测对比后选定）：**腾讯批量行情** `qt.gtimg.cn/q=sh600519,sz000001,...`
  一次请求拿全部名称（30 只约 15KB，GBK 编码，复用 `iconv-lite` 解码模式）；
  否决的备选「复用自选股树行情缓存」——0 请求但依赖树已加载，刚启动时拿不到，
  且让 webview 层依赖 explorer 层。
  实测细节：`r_` 精简前缀对 A 股返回 `pv_none_match`（不可用），
  必须用原始代码前缀；无效代码行无名称段，`parseStockNames` 不入表。
  实现：`tencentStock.ts` 新增 `parseStockNames`（纯函数，可单测）+
  `fetchStockNames`（失败返回 `{}` 不抛错）；`loadStockFundRows` 里
  名称与逐股资金流**并发**，名称失败只丢展示名、行与资金流照常返回。
  渲染：名称为主（加粗）+ 代码为辅（弱色小字），名称缺失回退只显示代码。
- [x] **2. 第三方量化分析区显示优化**
  根因：接口原始数据本是结构化分组（实测茅台 5 组：PEG估值/技术指标分析/
  预测与评价/综合评分/特色数据），但 `fetchStockAnalysis` 拍平成
  `【组名】msg1；msg2` 纯文本整块 `pre-wrap` 渲染，无层次。
  实现：新增 `fetchStockAnalysisGroups` 返回 `{name, msgs[]}[]` 结构化分组；
  `fetchStockAnalysis` 改为其文本投影（**AI prompt 两个消费方零改动**，
  附录格式与原来完全一致）；`StockDetail.analysis` 类型从 `string` 改为
  `AnalysisGroup[]`。
  渲染：分组卡片 = 组名徽章（badge 色）+ 组内逐条消息，
  消息里首个冒号（中英文皆可）前的 key 用弱色区分层次。
- [x] **3. 模板行为测试基座**：新增 `test/helpers/webview-dom.js`（伪 DOM，
  在 Node vm 里执行模板内联 script，不引 jsdom）+ `test/stockFundFlowView.test.js`
  4 用例（名称渲染/名称缺失回退/分组卡片/空态）。
- [x] TDD：先红后绿，RED **14 failing**（结构化分组 3 + 腾讯名称 4 +
  编排层 4 + 模板渲染 3）→ GREEN 全绿。
  验证：`tsc` 0 error / `eslint` 0 error 5 warning（基线）/
  **103 passing**（原 90 + 新增 13）。
- [x] 端到端真实接口验证（不 mock）：腾讯名称 4 只全对、
  列表 3 只 A 股带名称（hk00700 正确过滤）、分析 5 分组结构化、
  `fetchStockAnalysis` 文本首行与原来一致、详情 `analysis=array/5`、
  名称接口失败降级 `name:""` 且资金流数据不受影响。
