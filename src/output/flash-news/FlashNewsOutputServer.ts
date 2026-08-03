import { throttle } from 'lodash';
import { OutputChannel, StatusBarAlignment, StatusBarItem, window } from 'vscode';
import { LeekFundConfig } from '../../shared/leekConfig';
import FlashNewsDaemon from './FlashNewsDaemon';
import { FlashNewsServerInterface } from './NewsFlushServiceAbstractClass';

export default class FlashNewsOutputServer implements FlashNewsServerInterface {
  flashNewsBarItem: StatusBarItem | undefined;
  public op: OutputChannel | undefined;
  public newsCount: number = 0;

  isEnableOutput: boolean = false;
  newsCache: string[] = [];
  unregisterServer: (() => void) | undefined;

  constructor() {
    this.isEnableOutput = LeekFundConfig.getConfig('leek-fund.flash-news');
    this.updateNewsBarItem = throttle(this.updateNewsBarItem, 1000);
    this.setup();
  }

  setup() {
    if (this.isEnableOutput) {
      this.op = window.createOutputChannel('韭菜盒子 - 快讯');
      this.flashNewsBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 3);
      this.flashNewsBarItem.text = `⚡️️ ${this.newsCount}`;
      this.flashNewsBarItem.command = 'leek-fund.flash-news-show';
      this.flashNewsBarItem.show();
      this.unregisterServer = FlashNewsDaemon.registerServer(this);
    }
  }

  reload() {
    const _enable: boolean = LeekFundConfig.getConfig('leek-fund.flash-news');
    if (this.isEnableOutput !== _enable) {
      this.isEnableOutput = _enable;
      if (!_enable) {
        this.destroy();
      } else {
        this.setup();
      }
    }
  }

  destroy() {
    this.newsCount = 0;
    this.newsCache.length = 0;
    this.unregisterServer?.();
    this.op?.dispose();
    this.flashNewsBarItem?.dispose();
  }

  // 将快讯正文拆分为行，超过 3 行时截断并在第 3 行末加省略号
  private formatNewsLines(news: string): string[] {
    const lines = news
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+$/, ''))
      .filter((l) => l.length > 0);
    if (lines.length <= 3) {
      return lines;
    }
    const head = lines.slice(0, 3);
    head[2] = `${head[2]} …`;
    return head;
  }

  print(news: string, source?: { type: string; data: any; time: number; important?: boolean }) {
    if (!this.isEnableOutput) return;
    // 仅显示重要快讯：来源未标记重要时直接过滤
    const importantOnly = LeekFundConfig.getConfig('investment-monitor.flash-news-important-only');
    if (importantOnly && !source?.important) {
      return;
    }
    const tag = source?.important ? '🔴 重要' : '⚪ 一般';
    const taggedNews = `[${tag}] ${news}`;
    this.newsCount++;
    this.newsCache.push(taggedNews);
    this.newsCache = this.newsCache.slice(-5);
    this.updateNewsBarItem();
    // 多行内容逐行输出，正文最多 3 行；消息之间增加空行间隔
    this.formatNewsLines(taggedNews).forEach((line) => this.op?.appendLine(line));
    this.op?.appendLine('');
    this.op?.appendLine('-----------------------------');
    this.op?.appendLine('');
  }

  updateNewsBarItem() {
    if (this.flashNewsBarItem) {
      this.flashNewsBarItem.text = `⚡️️ ${this.newsCount}`;
      this.flashNewsBarItem.tooltip = `${this.newsCache.join(
        '\r\n-----------------------------\r\n'
      )}`;
      this.flashNewsBarItem.show();
    }
  }

  showOutput() {
    this.op?.show();
    this.newsCount = 0;
    if (this.flashNewsBarItem) {
      this.flashNewsBarItem.text = `⚡️️ ${this.newsCount}`;
      this.flashNewsBarItem.show();
    }
  }
}
