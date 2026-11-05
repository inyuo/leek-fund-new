import { Event, EventEmitter, TreeDataProvider, TreeItem } from 'vscode';
import { NEWS_SOURCES, resolveNewsSourceUrl } from './xxjwxcNews';
import { NewsService, NewsSourceGroupTreeItem, NewsTreeItem } from './newsService';

type NewsNode = NewsTreeItem | NewsSourceGroupTreeItem;

export class NewsProvider implements TreeDataProvider<NewsNode> {
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
      await this.service.forceRefreshGroups();
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  /** 根节点：登录后 4 个来源分组；未登录回退旧的扁平降级列表 */
  async getChildren(element?: NewsNode): Promise<NewsNode[]> {
    if (element instanceof NewsSourceGroupTreeItem) {
      return this.childrenOfGroup(element);
    }
    const groups = await this.service.getNewsGroups();
    if (groups.length > 0) {
      return groups.map((group) => {
        const meta = NEWS_SOURCES.find((s) => s.key === group.key) || NEWS_SOURCES[0];
        return new NewsSourceGroupTreeItem(group, meta);
      });
    }
    return this.service.getNewsList();
  }

  /** 分组内条目；失败/空分组给一个可点击重试的占位节点 */
  private childrenOfGroup(node: NewsSourceGroupTreeItem): NewsNode[] {
    const group = node.group;
    if (group.items.length > 0) {
      return group.items.map((news) => new NewsTreeItem(news));
    }
    const placeholder = new NewsTreeItem({
      id: `news-${group.key}-placeholder`,
      url: resolveNewsSourceUrl(group.key),
      time: 0,
      timeLabel: '',
      title: group.failed ? '加载失败，点击重试' : '暂无数据',
      summary: '',
      stocksLabel: '',
      source: group.key,
    });
    placeholder.command = {
      title: '刷新资讯',
      command: 'leek-fund.refreshFollow',
      arguments: [],
    };
    return [placeholder];
  }

  getParent(): NewsNode | null {
    return null;
  }

  getTreeItem(element: NewsNode): TreeItem {
    return element;
  }
}
