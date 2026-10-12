import { Event, EventEmitter, TreeDataProvider, TreeItem } from 'vscode';
import { NewsService, NewsTreeItem } from './newsService';

export class NewsProvider implements TreeDataProvider<NewsTreeItem> {
  private _onDidChangeTreeData: EventEmitter<any> = new EventEmitter<any>();

  readonly onDidChangeTreeData: Event<any> = this._onDidChangeTreeData.event;

  private service: NewsService;

  constructor() {
    this.service = new NewsService();
  }

  refresh(): any {
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
