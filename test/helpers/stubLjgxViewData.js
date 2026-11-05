/**
 * 量化面板宿主测试桩：代替 out/webview/quantPanel 依赖的 ../shared/ljgxData。
 * state 由测试按需注入结果（null = 接口失败/未拉取），calls 记录调用序列，
 * 用来断言懒加载语义（只拉当前 tab 的接口）。
 */
const calls = [];

const state = {
  /** loadSession 返回值（null = 未登录） */
  session: null,
  /** { tm, price } */
  cjl: null,
  /** { times, hgtNet, szgtNet } */
  north: null,
  /** [{ code, name, price, percent }] */
  index: null,
};

function reset() {
  calls.length = 0;
  state.session = null;
  state.cjl = null;
  state.north = null;
  state.index = null;
}

module.exports = {
  calls,
  state,
  reset,
  loadSession() {
    return state.session;
  },
  fetchShareCjl(codes, deps) {
    calls.push({ name: 'fetchShareCjl', codes, deps });
    return Promise.resolve(state.cjl);
  },
  fetchNorthFundTrends() {
    calls.push({ name: 'fetchNorthFundTrends' });
    return Promise.resolve(state.north);
  },
  fetchIndexSpark() {
    calls.push({ name: 'fetchIndexSpark' });
    return Promise.resolve(state.index);
  },
};
