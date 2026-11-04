/**
 * 量化面板宿主测试桩：代替 out/webview/quantLogin（openLogin 引导 → quantLogin()
 * 的调用方），只记录调用序列。
 */
const calls = [];

function reset() {
  calls.length = 0;
}

module.exports = {
  calls,
  reset,
  initQuantLogin() {
    calls.push('initQuantLogin');
  },
  quantLogin() {
    calls.push('quantLogin');
  },
  refreshQuantTree() {},
};
