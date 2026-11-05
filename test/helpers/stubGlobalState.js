/**
 * stockTrend 依赖桩：代替 ../globalState（默认导出对象）。
 * stockTrend 读 globalState.kLineChartSwitch 决定是否用东财 h5chart iframe。
 */
const state = {
  kLineChartSwitch: true,
};

module.exports = { default: state, __esModule: true };
