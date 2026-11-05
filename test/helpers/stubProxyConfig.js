/**
 * stockTrend 依赖桩：代替 ./proxyService/proxyConfig 的 getEastMoneyHost。
 */
function getEastMoneyHost() {
  return 'https://quote.eastmoney.com';
}

module.exports = { getEastMoneyHost };
