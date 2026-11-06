import { commands, ViewColumn, WebviewPanel, window } from 'vscode';
import FundService from '../explorer/fundService';
import globalState from '../globalState';
import { LeekFundConfig } from '../shared/leekConfig';
import { LeekTreeItem } from '../shared/leekTreeItem';
import { IAmount } from '../shared/typed';
import { formatDate, getTemplateFileContent, toFixed } from '../shared/utils';
import ReusedWebviewPanel from './ReusedWebviewPanel';
import { cloneDeep } from 'lodash';

async function setAmount(fundService: FundService) {
  // const list = fundDataHandler(fundService);
  const panel = ReusedWebviewPanel.create(
    'setFundAmountWebview',
    `基金持仓金额设置`,
    ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );
  // Handle messages from the webview
  panel.webview.onDidReceiveMessage((message) => {
    switch (message.command) {
      case 'success':
        console.log(JSON.parse(message.text));
        setAmountCfgCb(JSON.parse(message.text));
        return;
      case 'alert':
        window.showErrorMessage('保存失败！');
        return;
      case 'donate':
        commands.executeCommand('leek-fund.donate');
        return;
      case 'refresh':
        const list = fundDataHandler(fundService);
        // console.log(list);
        // panel.webview.html = `<h3>loading</h3>`;
        // getWebviewContent(panel);
        // 如果消息中有sortType，使用它；否则使用保存的配置
        const sortType = message.sortType || LeekFundConfig.getConfig('leek-fund.fundAmountSort', 'default');
        panel.webview.postMessage({
          command: 'init',
          data: list,
          sortType: sortType,
        });
        return;
      case 'saveSort':
        // 保存排序方式
        LeekFundConfig.setConfig('leek-fund.fundAmountSort', message.sortType);
        return;
    }
  }, undefined);

  getWebviewContent(panel);
  
  // 初始化时发送保存的排序方式
  const savedSortType = LeekFundConfig.getConfig('leek-fund.fundAmountSort', 'default');
  const list = fundDataHandler(fundService);
  panel.webview.postMessage({
    command: 'init',
    data: list,
    sortType: savedSortType,
  });

  /* panel.onDidChangeViewState((event) => {
    // console.log(event);
    panel.webview.postMessage({
      command: 'init',
      data: list,
    });
  }); */
}

function fundDataHandler(fundService: FundService) {
  const fundList: LeekTreeItem[] = cloneDeep(fundService.fundList);
  const amountObj: any = globalState.fundAmount || {};
  const list = fundList.map((item: LeekTreeItem) => {
    const fundConfig = amountObj[item.info?.code] || {};
    
    // 兼容旧数据：如果没有份额但有金额和基金净值，计算份额
    let shares = fundConfig.shares;
    if (!shares && fundConfig.amount && item.info?.yestclose) {
      shares = fundConfig.amount / parseFloat(String(item.info.yestclose));
    }
    
    // 计算持仓金额：优先使用份额 * 基金净值（昨日净值），否则使用保存的金额
    const calculatedAmount = shares && item.info?.yestclose
      ? shares * parseFloat(String(item.info.yestclose))
      : fundConfig.amount || 0;
    
    return {
      name: item.info?.name,
      code: item.info?.code,
      percent: item.info?.percent,
      amount: calculatedAmount,
      shares: shares || 0, // 添加份额字段
      earningPercent: item.info?.earningPercent,
      unitPrice: item.info?.unitPrice,
      // priceDate: formatDate(item.info?.time),
      earnings: item.info?.earnings || 0,
      yestEarnings: fundConfig.earnings || 0,
      price: item.info?.yestclose,
      priceDate: item.info?.yestPriceDate,
    };
  });

  return list;
}

function getWebviewContent(panel: WebviewPanel) {
  /*   const _getWebviewResourcesUrl = (arr: string[]): Uri[] => {
    return getWebviewResourcesUrl(panel.webview, globalState.context.extensionUri, arr);
  }; */

  panel.webview.html = getTemplateFileContent('fund-amount.html', panel.webview);
}

function setAmountCfgCb(data: IAmount[]) {
  const cfg: any = {};
  data.forEach((item: any) => {
    // 计算持仓金额：如果有份额，则使用 单价 * 份额，否则使用原来的金额
    const calculatedAmount = item.shares && item.unitPrice 
      ? item.shares * item.unitPrice 
      : item.amount || 0;
    
    cfg[item.code] = {
      name: item.name,
      amount: calculatedAmount,
      shares: item.shares || 0, // 保存份额
      price: item.price,
      unitPrice: item.unitPrice,
      earnings: item.earnings,
      priceDate: item.priceDate,
    };
  });
  LeekFundConfig.setConfig('leek-fund.fundAmount', cfg).then(() => {
    cacheFundAmountData(cfg);
    window.showInformationMessage('保存成功！（没开市的时候添加的持仓盈亏为0，开市时会自动计算）');
  });
}

/**
 * 更新持仓金额
 * @param leekModel
 */
export async function updateAmount() {
  const amountObj: any = globalState.fundAmount;
  const codes = Object.keys(amountObj);
  if (codes.length === 0) {
    return;
  }
  const filterCodes: string[] = [];
  for (const code of codes) {
    const amount = amountObj[code]?.amount;
    if (amount > 0) {
      filterCodes.push(code);
    }
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const qryFundInfos = filterCodes.map((filterCode) => {
      return FundService.qryFundInfo(filterCode);
    });
    const resultFundInfos = await Promise.allSettled(qryFundInfos);
    const fundInfos: any[] = [];
    for (const resultFundInfo of resultFundInfos) {
      if (resultFundInfo.status === 'fulfilled') {
        const fundStrings = /jsonpgz\((.*)\);/.exec(resultFundInfo.value) || [];
        const fundString = fundStrings.length === 2 ? fundStrings[1] : '';
        const fundInfo = JSON.parse(fundString);
        fundInfos.push(fundInfo);
      }
    }
    fundInfos.forEach((item: any) => {
      const { fundcode: FCODE, gztime: GZTIME, dwjz: NAV, jzrq: PDATE } = item;
      const time = GZTIME?.substr(0, 10);
      const pdate = PDATE?.substr(0, 10);
      const isUpdated = pdate === time; // 判断闭市的时候
      const fundConfig = amountObj[FCODE];
      const money = fundConfig?.amount || 0;
      const price = fundConfig?.price || 0;
      const priceDate = fundConfig?.priceDate || '';
      
      if (priceDate !== pdate) {
        // 兼容处理：如果没有份额但有历史金额，从金额和基金净值计算份额
        if (!fundConfig.shares && money && price) {
          fundConfig.shares = parseFloat((money / price).toFixed(2));
        }
        
        // 使用份额计算新的持仓金额，如果没有份额则用原逻辑
        const currentMoney = fundConfig.shares 
          ? fundConfig.shares * NAV 
          : (money / price) * NAV;
          
        amountObj[FCODE].amount = toFixed(currentMoney);
        if (isUpdated) {
          // 闭市的时候保留上一次盈亏值
          amountObj[FCODE].earnings = toFixed(currentMoney - money);
        }
        amountObj[FCODE].priceDate = pdate;
        amountObj[FCODE].price = NAV;
      }
    });
    if (fundInfos.length > 0) {
      LeekFundConfig.setConfig('leek-fund.fundAmount', amountObj).then(() => {
        cacheFundAmountData(amountObj);
        console.log('🐥fundAmount has Updated ');
      });
    }
  } catch (e) {
    return [];
  }
}

export function cacheFundAmountData(amountObj: Object) {
  globalState.fundAmount = amountObj;
  globalState.fundAmountCacheDate = formatDate(new Date());
}

export default setAmount;
