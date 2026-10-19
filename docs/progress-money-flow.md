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
