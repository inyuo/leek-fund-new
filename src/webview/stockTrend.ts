import { commands, ViewColumn } from 'vscode';
import ReusedWebviewPanel from './ReusedWebviewPanel';
import stockTrendPic from './stockTrendPic';
import globalState from '../globalState';
import { getEastMoneyHost } from './proxyService/proxyConfig';

/**
 * 是否支持「查看该股资金动态」：仅沪深个股。
 * 港股（hk…）、美股（gb_/usr_…）、期货（nf_/hf_…）与上证/深证指数都不支持，
 * 因为资金动态的三块表格走官网 analy.get_sp，只覆盖 A 股个股。
 */
function canOpenFundFlow(stockCode: string): boolean {
  return /^(sh|sz)\d{6}$/.test(stockCode) && !/^(sh000|sz399)/.test(stockCode);
}

function stockTrend(code: string, name: string, stockCode: string) {
  if (['0dji', '0ixic', '0inx'].includes(code)) {
    return stockTrendPic(code, name, stockCode);
  }
  if (/^恒生.*指数$/.test(name)) {
    return stockTrendPic(code, name, stockCode);
  }
  stockCode = stockCode.toLowerCase();
  const showFundFlow = canOpenFundFlow(stockCode);
  let market = '1';
  if (stockCode.indexOf('hk') === 0) {
    market = '116';
  } else if (stockCode.indexOf('gb_') === 0) {
    stockCode = stockCode.replace('gb_', '.');
  } else if (stockCode.indexOf('usr_') === 0) {
    stockCode = stockCode.replace('usr_', '');
    market = '105';
  } else {
    market = stockCode.substring(0, 2) === 'sh' ? '1' : '0';
  }

  let mcid = market + '.' + code.substr(1);
  let url = `${getEastMoneyHost()}/basic/full.html?mcid=${mcid}`;

  if (!!globalState.kLineChartSwitch) {
    if (
      (market === '1' || market === '0') &&
      stockCode.indexOf('sh000') !== 0 &&
      stockCode.indexOf('sz399') !== 0
    ) {
      // 沪深股票详情地址可查看盘前盘后指数、买五卖五、筹码分布
      url = `${getEastMoneyHost()}/basic/h5chart-iframe.html?code=${code.substr(1)}&market=${market}`;
    }
  }

  // TODO：问题1. 需要选择合适的显示页面。上面的 eastmoney 网站不支持期货，market 113在这个网页上不支持。
  // 问题 2. 如果选用东财传统网页，存在交易代码不一致问题。例如甲醇 `MA2201` 在东财上的代码为 `MA201`，`PVC又是 v2201`
  // 直接采用新浪财经网址，去除 nf的显示
  const isFuture = /nf_/.test(stockCode) || /hf_/.test(stockCode);
  if (isFuture) {
    stockCode = stockCode.replace('nf_', '').replace('hf_', '').toUpperCase();
    url = `https://finance.sina.com.cn/futures/quotes/${stockCode}.shtml`;
  }

  let tabTitle = !isFuture ? `股票实时走势(${code})` : `期货实时走势(${name})`;
  const panel = ReusedWebviewPanel.create('stockTrendWebview', tabTitle, ViewColumn.One, {
    enableScripts: true,
  });

  // 面板是复用的（同一 viewType 复用同一个 WebviewPanel），消息监听只注册一次，
  // 否则反复打开不同股票会累积监听，一次点击触发多次跳转。
  const webview = panel.webview as any;
  if (!webview.__leekFundFlowBound) {
    webview.__leekFundFlowBound = true;
    webview.onDidReceiveMessage((msg: any) => {
      if (msg && msg.command === 'openFundFlow' && msg.code) {
        // 复用已注册的命令：它内部会注入登录态，资金动态的三块表格需要 user-token
        commands.executeCommand('leek-fund.stockFundFlowForStock', { id: msg.code });
      }
    });
  }

  // 顶部工具条：A 股个股给一个「资金动态」入口，跳到该股的资金动态面板
  const toolbar = showFundFlow
    ? `
    <div class="toolbar">
      <span class="title">${tabTitle}</span>
      <button class="btn" id="fundFlowBtn">资金动态</button>
    </div>`
    : '';
  const script = showFundFlow
    ? `
    <script>
      (function () {
        const vscode = acquireVsCodeApi();
        const btn = document.getElementById('fundFlowBtn');
        if (btn) {
          btn.addEventListener('click', function () {
            vscode.postMessage({ command: 'openFundFlow', code: '${stockCode}' });
          });
        }
      })();
    </script>`
    : '';
  const chartHeight = showFundFlow ? 'calc(100vh - 44px)' : '900px';

  panel.webview.html = `
  <!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>股票走势</title>
    <style>
    html.vscode-dark, body.vscode-dark, html.vscode-high-contrast, body.vscode-high-contrast {
      filter: invert(100%) hue-rotate(180deg);
    }
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 6px 10px;
      background: var(--vscode-editorWidget-background, #252526);
      border-bottom: 1px solid var(--vscode-editorWidget-border, #454545);
    }
    .toolbar .title {
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-foreground, #cccccc);
    }
    .toolbar .btn {
      background: #3c3c3c;
      color: #ffffff;
      border: none;
      padding: 4px 12px;
      border-radius: 3px;
      font-size: 12px;
      cursor: pointer;
    }
    .toolbar .btn:hover {
      background: #4d4d4d;
    }
    </style>
  </head>
  <body>
    ${toolbar}
    <div  style="min-width: 1320px; overflow-x:auto">
      <iframe
      src="${url}"
      frameborder="0"
      style="width: 100%; height: ${chartHeight}"
    ></iframe>
    </div>
    ${script}
  </body>
</html>

  `;
}

export default stockTrend;
