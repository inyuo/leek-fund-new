import { Webview, workspace, window } from 'vscode';
import OpenAI from 'openai';
import { fetchJYGNewsByCode } from '../jiuyangongshe-news';
import { StockNewsService } from './stock-news-service';
import { fetchRecentQfqTradeDataForAi } from '../../shared/aiStockHistoryData';
import { fetchStockMainFlow, fetchStockAnalysis, buildStockMoneyFlowAppendix } from '../../shared/xxjwxcData';

export class AiService {
  private aiStockAnalysisInProgress = false;

  constructor(private webview: Webview, private stockNewsService: StockNewsService) {}

  async handleMessage(message: any) {
    switch (message.command) {
      case 'getAiConfig':
        this.getAiConfig();
        break;
      case 'updateAiConfig':
        this.updateAiConfig(message.data);
        break;
      case 'sendAIMessage':
        this.handleChat(message.data);
        break;
      case 'analyzeStock':
        this.handleStockAnalysis(message.data);
        break;
    }
  }

  private getAiConfig() {
    const config = workspace.getConfiguration();
    const aiConfig = config.get('leek-fund.aiConfig') || {
      apiKey: '',
      baseUrl: '',
      model: '',
    };
    this.webview.postMessage({
      command: 'aiConfig',
      data: aiConfig
    });
  }

  private updateAiConfig(data: any) {
    const config = workspace.getConfiguration();
    config.update('leek-fund.aiConfig', data, true).then(() => {
      this.webview.postMessage({
        command: 'saveSuccess'
      });
    });
  }

  private async handleChat(userMessage: string) {
    try {
      const result = await this.send_ai(userMessage);
      this.webview.postMessage({
        command: 'aiResponse',
        data: result
      });
    } catch (error) {
      this.webview.postMessage({
        command: 'aiResponse',
        data: "抱歉，AI服务暂时不可用，请稍后再试"
      });
    }
  }

  private async handleStockAnalysis(target: any) {
    try {
      const result = await this.send_ai_stock_analysis(target);
      if (result) {
        this.webview.postMessage({
          command: 'aiResponse',
          data: result
        });
      }
    } catch (error) {
      console.error(error);
      this.webview.postMessage({
        command: 'aiResponse',
        data: "股票分析失败，请稍后再试"
      });
    }
  }

  // --- Core AI Methods ---

  async send_ai(userMessage: string): Promise<string> {
    try {
      const config = workspace.getConfiguration();
      const aiConfig: any = config.get('leek-fund.aiConfig');
      
      if(!aiConfig?.apiKey || !aiConfig?.baseUrl || !aiConfig?.model) {
        return "AI配置不完整,请检查配置";
      }

      const openai = new OpenAI({
        apiKey: aiConfig.apiKey, 
        baseURL: aiConfig.baseUrl,
      });

      const completion = await openai.chat.completions.create({
        model: aiConfig.model,
        messages: [
          { 
            role: "system", 
            content: "你是一个拥有多年投资经验的投资专家，擅长分析股票市场、解读财经新闻、提供投资建议。请用中文回答，保持专业且友好的态度。" 
          },
          { role: "user", content: userMessage }
        ],
        // reasoning 思考模型的思考 token 计入该预算，4000 常在思考阶段就被截断
        //（实测 finish_reason=length 且 content 为空，界面显示"抱歉，我没有收到回复"）
        max_tokens: 16000,
        temperature: 0.7,
      });
      
      return completion.choices[0]?.message?.content || "抱歉，我没有收到回复";
    } catch (error) {
      console.error('AI请求失败:', error);
      return "抱歉，AI服务暂时不可用，请稍后再试";
    }
  }

  async send_ai_stock_analysis(target: any): Promise<string> {
    console.log('aiStockAnalysis target:', target?.info);
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
    const rangeLabel: Record<string, string> = {
      '1y': '近1年',
      '6m': '近6个月',
      '3m': '近3个月',
      '1m': '近1个月',
      '1w': '近1周',
    };
    const label = rangeLabel[range] || '近3个月';

    window.showWarningMessage(`开始分析：${target.info.name} 股票 ${label}的前复权日线数据，股票代码：${target.info.code}`);
    const baseMessage = `请根据历史数据和韭研公社个股新闻分析以下股票：${target.info.name}，股票代码：${target.info.code}`;

    // 三组数据并发拉取：历史行情 / 韭研新闻 / 资金流+量化结论
    // 各自独立降级 —— 任一失败只丢掉对应附录，绝不让整个分析失败
    // （教训：韭研超时被静默吞掉时，模型拿不到数据只能回答"无法实时抓取"）
    const stockName = String(target?.info?.name || '').trim();
    const stockCode = String(target?.info?.code || '').trim();
    const keyword = stockName || stockCode;
    const moneyCode = stockCode || String(target?.id || '');

    const tradeTask = fetchRecentQfqTradeDataForAi(target.id, range).catch((e) => {
      console.error('获取历史交易数据失败:', e);
      return null;
    });

    const newsTask = keyword
      ? fetchJYGNewsByCode(keyword, 10, 0).catch((e) => {
          console.error('拼接韭研公社新闻失败:', e);
          return [];
        })
      : Promise.resolve([]);

    const moneyTask = (async () => {
      const pair = await Promise.all([fetchStockMainFlow(moneyCode), fetchStockAnalysis(moneyCode)]);
      return buildStockMoneyFlowAppendix(pair[0], pair[1]);
    })().catch((e) => {
      console.error('拼接资金与量化数据失败:', e);
      return '';
    });

    const resolved = await Promise.all([tradeTask, newsTask, moneyTask]);
    const tradeData = resolved[0];
    const jygItems = resolved[1];
    const moneyAppendix = resolved[2];

    let tradeDataAppendix = '';
    if (tradeData && tradeData.text) {
      tradeDataAppendix = `\n\n以下为${label}的前复权日线数据（来自${tradeData.sourceLabel}）：\n${tradeData.text}`;
    }

    let newsAppendix = '';
    if (Array.isArray(jygItems) && jygItems.length) {
      const lines: string[] = [];
      for (const item of jygItems) {
        const title = item.title || '';
        const warns = item.warn_words ? `warn_words: ${item.warn_words}` : '';
        const snippet = item.content
          ? item.content.length > 300
            ? item.content.slice(0, 300) + '…'
            : item.content
          : '';
        const ts = item.create_time ? `[${item.create_time}] ` : '';
        lines.push(`- ${ts}${title}`);
        if (warns) lines.push(`  - ${warns}`);
        if (snippet) lines.push(`  - content: ${snippet}`);
      }
      newsAppendix = `\n\n以下为韭研公社该股新闻（关键词：${keyword}）：\n${lines.join('\n')}`;
    }

    const message = baseMessage + tradeDataAppendix + newsAppendix + moneyAppendix;
    
    console.log('request ai model message', message);

    this.aiStockAnalysisInProgress = true;
    try {
      const result = await this.send_ai(message);
      console.log('aiStockAnalysis result:', result);

      // 结果判定
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
}
