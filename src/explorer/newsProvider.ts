import { Event, EventEmitter, TreeDataProvider, TreeItem } from 'vscode';
import { NewsService, NewsTreeItem } from './newsService';

export class NewsProvider implements TreeDataProvider<NewsTreeItem> {
  private _onDidChangeTreeData: EventEmitter<any> = new EventEmitter<any>();

  readonly onDidChangeTreeData: Event<any> = this._onDidChangeTreeData.event;

  private service: NewsService;

  constructor() {
    this.service = new NewsService();
  }

  /**
   * @param force true 时先丢弃缓存重新拉取（手动刷新），false 仅重绘（后台轮询）
   */
  async refresh(force = false): Promise<void> {
    if (force) {
      await this.service.forceRefresh();
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  getChildren(): Thenable<NewsTreeItem[]> {
    return this.service.getNewsList();
  }

  getParent(): NewsTreeItem | null {
    return null;
  }

  getTreeItem(element: NewsTreeItem): TreeItem {
    return element;
  }
}
