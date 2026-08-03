import Axios from 'axios';
import * as iconv from 'iconv-lite';
import { ExtensionContext } from 'vscode';
import globalState from '../globalState';
import { LeekTreeItem } from '../shared/leekTreeItem';
import {
  caculateEarnings,
  randHeader,
  sortData,
  toFixed,
  events,
  formatDate,
} from '../shared/utils';
import { LeekService } from './leekService';
import { executeStocksRemind } from '../shared/remindNotification';

const FUND_RANK_API = `http://vip.stock.finance.sina.com.cn/fund_center/data/jsonp.php/IO.XSRV2.CallbackList['hLfu5s99aaIUp7D4']/NetValueReturn_Service.NetValueReturnOpen?page=1&num=40&sort=form_year&asc=0&ccode=&type2=0&type3=`;

export default class FundService extends LeekService {
  private context: ExtensionContext;
  private totalAmount: number; // 总持仓
  private totalProfit: number; // 总收益
  private updateTime: string; // 更新时间
  private amountRefreshCount: number; // 在一个轮询周期内，刷新数据的次数
  private fundCodesSet: Set<string>; // 存储fundCode的集合
  public fundList: Array<LeekTreeItem> = [];

  constructor(context: ExtensionContext) {
    super();
    this.context = context;
    this.totalAmount = 0;
    this.totalProfit = 0;
    this.updateTime = '';
    this.amountRefreshCount = 0;
    this.fundCodesSet = new Set();
  }

  setFundList(fundList: Array<LeekTreeItem>) {
    fundList.forEach((fund) => {
      let hasInserted = false;
      for (let index = 0; index < this.fundList.length; index++) {
        if (this.fundList[index].info?.code === fund.info?.code) {
          this.fundList.splice(index, 1, fund);
          hasInserted = true;
          break;
        }
      }
      if (!hasInserted) {
        this.fundList.push(fund);
        hasInserted = true;
      }
    });
  }

  async getData(
    fundCodes: Array<string>,
    order: number,
    groupId: string
  ): Promise<Array<LeekTreeItem>> {
    if (!fundCodes.length) {
      return [];
    }
    // console.log('fetching fund data……');
    try {
      const groupIndex: number = parseInt(groupId.replace('fundGroup_', ''));
      this.amountRefreshCount = groupIndex === 0 ? 0 : this.amountRefreshCount;
      if (this.amountRefreshCount === 0) {
        this.totalAmount = 0;
        this.totalProfit = 0;
        this.updateTime = '';
        this.fundCodesSet.clear();
      }

      const qryFundInfos = fundCodes.map((fundCode) => {
        return FundService.qryFundInfo(fundCode);
      });
      const resultFundInfos = await Promise.allSettled(qryFundInfos);
      const fundInfos = [];
      for (const resultFundInfo of resultFundInfos) {
        if (resultFundInfo.status === 'fulfilled') {
          const parts = (resultFundInfo.value || '').split('#');
          const fundCode = parts[0];
          const fundString = parts[1];
          if (fundString) {
            try {
              const fundInfo = JSON.parse(fundString);
              fundInfos.push(fundInfo);
            } catch (e) {
              // 解析失败，构造空数据用于展示
              fundInfos.push({
                fundcode: fundCode,
                name: `${fundCode}暂无数据`,
                gszzl: '--',
                dwjz: '--',
                jzrq: '',
                gsz: '--',
                gztime: '',
              });
            }
          } else {
            // 不支持的基金或接口无数据，构造空数据用于展示
            fundInfos.push({
              fundcode: fundCode,
              name: `${fundCode}暂无数据`,
              gszzl: '--',
              dwjz: '--',
              jzrq: '',
              gsz: '--',
              gztime: '',
            });
          }
        }
      }
      const fundAmountObj: any = globalState.fundAmount;
      const keyLength = Object.keys(fundAmountObj).length;
      const data = fundInfos.map((item: any) => {
        const {
          name: SHORTNAME,
          fundcode: FCODE,
          gsz: GSZ,
          gztime: GZTIME,
          gszzl: GSZZL,
          dwjz: NAV,
          jzrq: PDATE,
        } = item;
        // 新浪 fu_ 接口 gztime 仅含时分秒，无法与净值日期做日期比对，
        // 改用中国时区交易时段判定市场是否闭市（闭市后展示结算盈亏）
        const isUpdated = !FundService.isMarketOpen();
        let earnings = 0;
        let amount = 0;
        let unitPrice = 0;
        let earningPercent = 0;
        let profitPercent = 0;
        let priceDate = '';
        // 不填写的时候不计算
        if (keyLength && GSZ !== '--') {
          amount = fundAmountObj[FCODE]?.amount || 0;
          unitPrice = fundAmountObj[FCODE]?.unitPrice || 0;
          priceDate = fundAmountObj[FCODE]?.priceDate || '';
          const price = fundAmountObj[FCODE]?.price || 0;
          const yestEarnings = fundAmountObj[FCODE]?.earnings || 0;
          const latestProfit = caculateEarnings(amount, price, GSZ);
          // 闭市的时候显示上一次盈亏
          earnings = amount === 0 ? 0 : isUpdated ? yestEarnings : latestProfit;
          profitPercent = (price - unitPrice) / unitPrice;
          // 收益率
          earningPercent = toFixed(profitPercent, 2, 100);
        }

        const obj = {
          id: `${groupId}_${FCODE}`,
          name: SHORTNAME,
          code: FCODE,
          price: GSZ, // 今日估值
          percent: isNaN(Number(GSZZL)) ? '0' : GSZZL, // 当日涨跌幅度没有的话取0
          yestpercent: '0', // 新接口已经没有昨日涨跌幅度
          yestclose: NAV, // 昨日净值
          showLabel: this.showLabel,
          earnings: toFixed(earnings), // 盈亏
          isUpdated,
          amount, // 持仓金额
          unitPrice, // 成本价
          priceDate,
          earningPercent, // 收益率
          t2: GSZZL === '--' ? true : false, // 海外基金t2
          time: GSZZL === '--' ? PDATE : GZTIME, // 更新时间
          showEarnings: keyLength > 0 && amount !== 0,
          yestPriceDate: PDATE,
        };
        this.updateTime = obj.time || '';
        if (!this.fundCodesSet.has(item.fundcode)) {
          this.fundCodesSet.add(item.fundcode);
          this.totalAmount += amount;
          this.totalProfit += earnings;
        }
        return new LeekTreeItem(obj, this.context);
      });

      const fundList = sortData(data, order);
      executeStocksRemind(fundList, this.fundList);
      const oldFundList = this.fundList;
      this.setFundList(fundList);
      events.emit('fundListUpdate', this.fundList, oldFundList);

      this.amountRefreshCount++;
      if (this.amountRefreshCount === globalState.fundLists.length) {
        events.emit('updateBar:profit-refresh', {
          fundProfit: toFixed(this.totalProfit),
          fundAmount: toFixed(this.totalAmount),
          fundProfitPercent: toFixed(this.totalProfit / this.totalAmount, 2, 100),
          priceDate: formatDate(this.updateTime),
        });
      }

      return fundList;
    } catch (err) {
      console.log(err);
      return [];
    }
  }

  // 当前是否为 A 股交易时段（中国时区，周一至周五 9:30-11:30、13:00-15:00）
  static isMarketOpen(): boolean {
    const now = new Date();
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
    const cn = new Date(utcMs + 8 * 3600000);
    const day = cn.getDay();
    if (day === 0 || day === 6) {
      return false;
    }
    const minutes = cn.getHours() * 60 + cn.getMinutes();
    const morning = 9 * 60 + 30 <= minutes && minutes <= 11 * 60 + 30;
    const afternoon = 13 * 60 <= minutes && minutes <= 15 * 60;
    return morning || afternoon;
  }

  // 中国时区日期时间字符串 YYYY-MM-DD HH:mm:ss
  static chinaDateString(d: Date = new Date()): string {
    const utcMs = d.getTime() + d.getTimezoneOffset() * 60000;
    const cn = new Date(utcMs + 8 * 3600000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${cn.getFullYear()}-${p(cn.getMonth() + 1)}-${p(cn.getDate())} ${p(
      cn.getHours()
    )}:${p(cn.getMinutes())}:${p(cn.getSeconds())}`;
  }

  // 将新浪 fu_ 接口返回映射为统一基金对象
  static mapFuData(fundCode: string, raw: string): string {
    const f = raw.split(',');
    const jzrq = f[7] || FundService.chinaDateString().substr(0, 10);
    const obj = {
      name: f[0],
      fundcode: fundCode,
      gsz: f[2] || '--',
      gszzl: f[6] || '--',
      gztime: `${jzrq} ${f[1]}`, // 补全日期，便于展示与排序
      dwjz: f[3] || '--',
      jzrq,
    };
    return JSON.stringify(obj);
  }

  // 将新浪股票行情接口返回映射为统一基金对象（用于场内货基/ETF 兜底）
  static mapStockData(fundCode: string, raw: string): string {
    const f = raw.split(',');
    const jzrq = FundService.chinaDateString().substr(0, 10);
    const price = f[1];
    const yest = f[2];
    const gszzl =
      yest && Number(yest)
        ? (((Number(price) - Number(yest)) / Number(yest)) * 100).toFixed(2)
        : '--';
    const obj = {
      name: f[0],
      fundcode: fundCode,
      gsz: price || '--',
      gszzl,
      gztime: FundService.chinaDateString(),
      dwjz: yest || '--',
      jzrq,
    };
    return JSON.stringify(obj);
  }

  // fu_ 无数据时回退到新浪股票行情（sh/sz），兼容场内货基ETF等
  static qryStockQuote(fundCode: string): Promise<string> {
    const fetch = (prefix: string) =>
      Axios.get(`https://hq.sinajs.cn/list=${prefix}${fundCode}`, {
        headers: { ...randHeader(), Referer: 'https://finance.sina.com.cn' },
        responseType: 'arraybuffer',
      }).then((resp: any) => {
        const text = iconv.decode(Buffer.from(resp.data), 'gbk');
        const m = new RegExp(`hq_str_${prefix}${fundCode}="(.*)";`).exec(text);
        if (!m || !m[1] || !m[1].split(',')[1]) {
          throw new Error('empty');
        }
        return FundService.mapStockData(fundCode, m[1]);
      });
    return new Promise((resolve) => {
      fetch('sh')
        .then((data) => resolve(`${fundCode}#${data}`))
        .catch(() =>
          fetch('sz')
            .then((data) => resolve(`${fundCode}#${data}`))
            .catch(() => resolve(`${fundCode}#`))
        );
    });
  }

  static qryFundInfo(fundCode: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!fundCode) {
        reject('');
      } else {
        // 天天基金估值接口(fundgz.1234567.com.cn)已下线，改用新浪基金实时估值接口
        const url = `https://hq.sinajs.cn/list=fu_${fundCode}`;
        Axios.get(url, {
          headers: {
            ...randHeader(),
            Referer: 'https://finance.sina.com.cn',
          },
          responseType: 'arraybuffer',
        })
          .then((resp: any) => {
            const buf = Buffer.from(resp.data);
            const text = iconv.decode(buf, 'gbk');
            const m = new RegExp(`hq_str_fu_${fundCode}="(.*)";`).exec(text);
            if (!m || !m[1]) {
              // 货币基金/部分场内品种 fu_ 无数据，回退股票行情接口
              FundService.qryStockQuote(fundCode)
                .then(resolve)
                .catch(() => resolve(`${fundCode}#`));
              return;
            }
            resolve(`${fundCode}#${FundService.mapFuData(fundCode, m[1])}`);
          })
          .catch((err: any) => {
            console.error(err);
            reject('');
          });
      }
    });
  }

  static async getRankFund(): Promise<Array<any>> {
    console.log('get ranking fund');
    const url = FUND_RANK_API;
    const response = await Axios.get(url, {
      headers: randHeader(),
    });
    const sIndex = response.data.indexOf(']({');
    const data = response.data.slice(sIndex + 2, -2);
    return JSON.parse(data).data || [];
  }
}
