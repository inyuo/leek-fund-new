/**
 * 资金动态宿主测试桩：代替 out/webview/stockFundFlow 依赖的 ../shared/fundFlowData。
 * 重点记录 loadStockDetail(code, deps)，用于断言登录态 store 是否透传。
 */
const calls = [];

module.exports = {
  calls,
  loadStockFundRows: async () => [],
  loadIndustryRows: async () => [],
  loadStockDetail: async (code, deps) => {
    calls.push({ code, deps });
    return {
      code,
      name: '浪潮信息',
      price: 57.35,
      percent: 2.87,
      mainFlow: null,
      analysis: [],
      sectors: [],
      fundTables: [],
    };
  },
  reset() {
    calls.length = 0;
  },
};
