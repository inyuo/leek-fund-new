import { ViewColumn, WebviewPanel, window, workspace } from 'vscode';
import ReusedWebviewPanel from './ReusedWebviewPanel';
import { getTemplateFileContent } from '../shared/utils';
import OpenAI from 'openai';
import { fetchJYGNewsByCode, buildJygNewsAppendix } from './jiuyangongshe-news';
import { fetchRecentQfqTradeDataForAi } from '../shared/aiStockHistoryData';
import { fetchStockMainFlow, fetchStockAnalysis, buildStockMoneyFlowAppendix } from '../shared/xxjwxcData';
import {
  hasXxjSession,
  fetchXxjNewsGroupsForAi,
  buildXxjNewsAppendix,
} from '../explorer/xxjwxcNews';
import { fetchStockFundTables, buildStockFundTablesAppendix } from '../shared/stockFundTables';
import { LjgxStorage } from '../shared/ljgxData';
import { StockNewsItem, StockNewsPayload } from './leek-center/stock-news-service';

type AiConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

/**
 * 个股新闻视图。
 *
 * 数据源为韭研公社个股新闻（无全市场快讯流），因此所有取数都必须带股票名称或代码。
 */
export class StockNewsView {
  private static instance: StockNewsView;
  private panel: WebviewPanel | null = null;

  private aiStockAnalysisInProgress = false;
  /** 当前查询的股票，供 AI 分析等无参场景复用 */
  private currentStock = '';

  private constructor() {}

  public static getInstance(): StockNewsView {
    if (!StockNewsView.instance) {
      StockNewsView.instance = new StockNewsView();
    }
    return StockNewsView.instance;
  }

  async send_ai(userMessage: string): Promise<string> {
    try {
      const aiConfig = this.getAiConfig();

      if (!aiConfig.apiKey || !aiConfig.baseUrl || !aiConfig.model) {
        return 'AI配置不完整,请检查配置';
      }

      const openai = new OpenAI({
        apiKey: aiConfig.apiKey,
        baseURL: aiConfig.baseUrl,
      });

      const completion = await openai.chat.completions.create({
        model: aiConfig.model,
        messages: [
          {
            role: 'system',
            content:
              '你是一个拥有多年投资经验的投资专家，擅长分析股票市场、解读财经新闻、提供投资建议。请用中文回答，保持专业且友好的态度。',
          },
          { role: 'user', content: userMessage },
        ],
        // reasoning 思考模型的思考 token 计入该预算，4000 常在思考阶段就被截断导致 content 为空
        max_tokens: 16000,
        temperature: 0.7,
      });

      return completion.choices[0]?.message?.content || '抱歉，我没有收到回复';
    } catch (error) {
      console.error('AI请求失败:', error);
      return '抱歉，AI服务暂时不可用，请稍后再试';
    }
  }

  async send_ai_stock_analysis(target: any, deps?: { store?: LjgxStorage }): Promise<string> {
    if (!target?.info) {
      window.showErrorMessage('未获取到股票信息');
      return '';
    }

    if (this.aiStockAnalysisInProgress) {
      window.showWarningMessage('AI 分析正在进行中，请稍候完成后再试');
      return '';
    }

    const cfg = workspace.getConfiguration();
    const range: string = cfg.get('leek-fund.aiStockHistoryRange', '3m');
    const rangeLabel =
      {
        '1y': '近1年',
        '6m': '近6个月',
        '3m': '近3个月',
        '1m': '近1个月',
        '1w': '近1周',
      }[range] || '近3个月';

    window.showWarningMessage(
      `开始分析：${target.info.name} 股票 ${rangeLabel}的前复权日线数据，股票代码：${target.info.code}`
    );
    const baseMessage = `请结合历史行情、个股资讯与资金数据，分析以下股票：${target.info.name}，股票代码：${target.info.code}`;

    // 三组数据并发拉取，各自独立降级：任一失败只丢掉对应附录
    const keyword = String(target?.info?.name || target?.info?.code || '').trim();
    const moneyCode = String(target?.info?.code || target?.id || '');

    const tradeTask = fetchRecentQfqTradeDataForAi(target.id, range).catch((e) => {
      console.error('获取历史交易数据失败:', e);
      return null;
    });

    // 新闻附录：登录后用「资讯」栏四来源分类信息替代韭研该股新闻（与资讯视图同源切换），
    // 未登录（或分类源为空）保留韭研公社该股新闻
    const newsTask = (async () => {
      if (hasXxjSession()) {
        const groups = await fetchXxjNewsGroupsForAi();
        const text = buildXxjNewsAppendix(groups);
        if (text) return text;
      }
      if (!keyword) return '';
      const items = await fetchJYGNewsByCode(keyword, 10, 0);
      return buildJygNewsAppendix(keyword, items);
    })().catch((e) => {
      console.error('拼接个股新闻失败:', e);
      return '';
    });

    // 资金附录：分时主力净流入 + 第三方量化结论 + 资金动态三块表格（后者需登录态，未登录返回 []）
    const moneyTask = (async () => {
      const trio = await Promise.all([
        fetchStockMainFlow(moneyCode),
        fetchStockAnalysis(moneyCode),
        fetchStockFundTables(moneyCode, deps),
      ]);
      return buildStockMoneyFlowAppendix(trio[0], trio[1]) + buildStockFundTablesAppendix(trio[2]);
    })().catch((e) => {
      console.error('拼接资金与量化数据失败:', e);
      return '';
    });

    const resolved = await Promise.all([tradeTask, newsTask, moneyTask]);
    const tradeData = resolved[0];
    const newsAppendix = resolved[1];
    const moneyAppendix = resolved[2];

    let tradeDataAppendix = '';
    if (tradeData && tradeData.text) {
      tradeDataAppendix = `\n\n以下为${rangeLabel}的前复权日线数据（来自${tradeData.sourceLabel}）：\n${tradeData.text}`;
    }

    const message = baseMessage + tradeDataAppendix + newsAppendix + moneyAppendix;

    this.aiStockAnalysisInProgress = true;
    try {
      const result = await this.send_ai(message);

      const isConfigIssue = /AI配置不完整|配置不完整/i.test(result);
      const isServiceDown = /不可用|错误|失败|稍后再试|抱歉/i.test(result);

      if (isConfigIssue) {
        window.showWarningMessage('AI 配置不完整，请在设置中完善 API Key / Base URL / 模型');
        return '';
      }
      if (isServiceDown) {
        window.showErrorMessage('AI 服务暂不可用，请稍后再试');
        return '';
      }
      return result;
    } catch (err) {
      console.error('调用 AI 分析失败:', err);
      window.showErrorMessage('调用 AI 分析失败，请稍后再试');
      return '';
    } finally {
      this.aiStockAnalysisInProgress = false;
    }
  }

  getAiConfig(): AiConfig {
    const result = workspace.getConfiguration().get('leek-fund.aiConfig', {
      apiKey: '',
      baseUrl: '',
      model: '',
    });
    return result;
  }

  updateAiConfig(aiConfig: AiConfig, cb?: Function) {
    workspace
      .getConfiguration()
      .update('leek-fund.aiConfig', aiConfig, true)
      .then(
        () => {
          window.showInformationMessage(`AI config Successfully update.`);
          if (cb && typeof cb === 'function') {
            cb(aiConfig);
          }
        },
        (err: any) => {
          console.error('AI配置更新失败:', err);
        }
      );
  }

  public show(stock?: string) {
    if (stock) {
      this.currentStock = String(stock).trim();
    }

    if (this.panel) {
      this.panel.reveal();
      this.renderPage();
      return;
    }

    this.panel = ReusedWebviewPanel.create(
      'stockNewsWebview',
      '个股新闻',
      ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    this.panel.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case 'refreshNews':
        case 'getNewsData':
          this.sendNewsData(message.data?.stock);
          return;
        case 'queryStockNews':
          this.currentStock = String(message.data?.stock || '').trim();
          this.sendNewsData(this.currentStock);
          return;
        case 'sendAIMessage':
          this.handleAIMessage(message.data);
          return;
        case 'openAiConfig':
          try {
            const { AiConfigView } = require('./ai-config');
            AiConfigView.getInstance().show();
          } catch (e) {
            console.error('打开 AI 配置页面失败:', e);
          }
          return;
        case 'getAiConfig':
          this.postToPanel('aiConfig', this.getAiConfig());
          return;
        case 'updateAiConfig':
          this.updateAiConfig(message.data);
          return;
      }
    });

    this.panel.onDidDispose(() => {
      this.panel = null;
    });

    this.renderPage();
  }

  private renderPage() {
    if (!this.panel) return;

    const initialRoute = '/data-center/stock-news';
    const html = getTemplateFileContent(['leek-center', 'build', 'index.html'], this.panel.webview);
    this.panel.webview.html = html.replace(
      '<head>',
      `<head><script>window.initialRoute = '${initialRoute}';window.initialStock = ${JSON.stringify(
        this.currentStock || ''
      )};</script>`
    );

    setTimeout(() => {
      this.sendNewsData(this.currentStock);
    }, 500);
  }

  private postToPanel(command: string, data: any) {
    if (!this.panel) {
      console.log('panel为空，无法发送数据到前端');
      return;
    }
    this.panel.webview.postMessage({ command, data });
  }

  /** 拉取韭研公社个股新闻并回传前端 */
  private async sendNewsData(stock?: string) {
    if (!this.panel) return;

    const keyword = String(stock || this.currentStock || '').trim();
    if (!keyword) {
      this.postToPanel('newsData', {
        messages: [],
        allDayMessages: [],
        lastUpdate: Date.now(),
        stock: null,
      } as StockNewsPayload);
      return;
    }

    try {
      this.currentStock = keyword;
      const payload = await this.fetchNewsData(keyword);
      this.postToPanel('newsData', payload);
    } catch (error) {
      console.error('获取韭研公社个股新闻失败:', error);
      this.postToPanel('newsData', {
        messages: [],
        allDayMessages: [],
        lastUpdate: Date.now(),
        stock: { keyword, name: keyword, code: '' },
      } as StockNewsPayload);
    }
  }

  private async fetchNewsData(keyword: string, limit = 30): Promise<StockNewsPayload> {
    const articles = await fetchJYGNewsByCode(keyword, limit, 0);
    const toItem = (item: any): StockNewsItem => ({
      id: item.article_id || `${item.create_time}-${item.title}`,
      title: item.title || '无标题',
      summary: item.content ? (item.content.length > 500 ? item.content.slice(0, 500) + '…' : item.content) : '',
      created_at: item.create_time
        ? Math.floor(Date.parse(String(item.create_time).replace(' ', 'T') + '+08:00') / 1000) || 0
        : 0,
      warn_words: item.warn_words ?? null,
      stocks: (item.stock_list || []).map((s: any) => ({ code: s.code, name: s.name })),
    });

    const allDayMessages = articles.map(toItem);
    return {
      messages: allDayMessages.slice(0, 20),
      allDayMessages,
      lastUpdate: Date.now(),
      stock: { keyword, name: keyword, code: '' },
    };
  }

  private async handleAIMessage(userMessage: string) {
    if (!this.panel) return;

    try {
      const aiResponse = await this.send_ai(userMessage);
      this.postToPanel('aiResponse', aiResponse);
    } catch (error) {
      console.error('处理AI消息失败:', error);
      this.postToPanel('aiResponse', '抱歉，处理您的请求时出现错误');
    }
  }
}

export default StockNewsView;