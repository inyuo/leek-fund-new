/**
 * 量化面板宿主测试桩：代替 out/webview/quantPanel 依赖的 ../shared/lqData。
 * 元数据取真实数据层（单一数据源），只桩掉网络拉取并记录调用参数。
 */
const real = require('../../out/shared/lqData');

const calls = [];
const state = { lq: null };

function reset() {
  calls.length = 0;
  state.lq = null;
}

module.exports = {
  calls,
  state,
  reset,
  LQ_TAGS: real.LQ_TAGS,
  LQ_DAYS: real.LQ_DAYS,
  fetchLqList(tag, days) {
    calls.push({ name: 'fetchLqList', tag, days });
    return Promise.resolve(state.lq);
  },
};
