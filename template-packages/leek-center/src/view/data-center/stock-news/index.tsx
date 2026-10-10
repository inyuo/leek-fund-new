import React, { useState, useEffect, useCallback, useContext } from 'react';
import { Tabs, Button, List, message, Input, Space, Tag } from 'antd';
import { ReloadOutlined, RobotOutlined, SearchOutlined } from '@ant-design/icons';
import { postMessage } from '@/utils/common';
import { AIContext } from '../context';
import './style.less';

const { TabPane } = Tabs;
const { Search } = Input;

interface NewsItem {
  id: string;
  title: string;
  summary: string;
  /** 秒级时间戳 */
  created_at: number;
  warn_words?: string | null;
  stocks?: { code: string; name: string }[];
}

interface NewsData {
  messages: NewsItem[];
  allDayMessages: NewsItem[];
  stock?: { keyword: string; name: string; code: string } | null;
}

/**
 * 个股新闻（数据源：韭研公社）。
 * 韭研公社没有全市场快讯流，必须指定股票名称或代码才能查询。
 */
const StockNews: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [newsData, setNewsData] = useState<NewsData>({ messages: [], allDayMessages: [] });
  const [activeTab, setActiveTab] = useState('latest');
  const [inputStock, setInputStock] = useState<string>(
    (typeof window !== 'undefined' && (window as any).initialStock) || ''
  );
  const [currentStock, setCurrentStock] = useState<string>(
    (typeof window !== 'undefined' && (window as any).initialStock) || ''
  );

  const aiContext = useContext(AIContext);

  const fetchNews = useCallback((stock?: string) => {
    const keyword = String(stock ?? currentStock ?? '').trim();
    if (!keyword) {
      message.warning('请输入股票名称或代码，例如「贵州茅台」或「sh600519」');
      return;
    }
    setLoading(true);
    setCurrentStock(keyword);
    postMessage('getNewsData', { stock: keyword });
    setTimeout(() => setLoading(false), 8000);
  }, [currentStock]);

  useEffect(() => {
    if (currentStock) {
      fetchNews(currentStock);
    }

    const handleMessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.command === 'newsData') {
        const data: NewsData = msg.data || { messages: [], allDayMessages: [] };
        setNewsData(data);
        if (data.stock?.keyword) {
          setCurrentStock(data.stock.keyword);
          setInputStock(data.stock.keyword);
        }
        setLoading(false);
      }
    };

    window.addEventListener('message', handleMessage);

    return () => {
      window.removeEventListener('message', handleMessage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRefresh = () => {
    if (!currentStock) {
      message.warning('请先输入股票名称或代码');
      return;
    }
    setLoading(true);
    postMessage('refreshNews', { stock: currentStock });
    setTimeout(() => setLoading(false), 8000);
  };

  const handleAnalyze = () => {
    const list = activeTab === 'latest' ? newsData.messages : newsData.allDayMessages;
    if (!list || list.length === 0) {
      message.warning('当前没有新闻数据可供分析');
      return;
    }

    const LIMIT = activeTab === 'latest' ? 10 : 30;
    const items = list.slice(0, LIMIT).map((item) => ({
      title: item.title,
      summary: item.summary,
      time: item.created_at ? new Date(item.created_at * 1000).toLocaleString() : '',
    }));

    const stockLabel = newsData.stock?.name || currentStock || '该股';
    const prompt = `请分析以下「${stockLabel}」的相关新闻，提供专业的投资建议和市场分析：\n\n${items
      .map(
        (news, index) =>
          `新闻 ${index + 1}:\n标题: ${news.title}\n内容: ${news.summary}\n时间: ${news.time}\n`
      )
      .join('\n')}\n\n请从以下角度进行分析：\n1. 近期消息面整体解读\n2. 对该股的影响判断\n3. 潜在投资机会\n4. 风险提示\n5. 具体操作建议`;

    aiContext?.analyze(prompt);
  };

  const renderNewsList = (list: NewsItem[]) => (
    <List
      className="news-list"
      loading={loading && list.length === 0}
      dataSource={list}
      renderItem={(item) => (
        <div className="news-item">
          <div className="news-title">{item.title || '无标题'}</div>
          <div className="news-summary">{item.summary || '无内容'}</div>
          <div className="news-meta">
            <span>{item.created_at ? new Date(item.created_at * 1000).toLocaleString() : ''}</span>
            {item.warn_words ? (
              <Tag className="news-warn" color="orange">
                敏感词：{item.warn_words}
              </Tag>
            ) : null}
            {(item.stocks || []).map((s) => (
              <Tag key={s.code}>{s.name}</Tag>
            ))}
          </div>
        </div>
      )}
      locale={{ emptyText: '暂无该股新闻数据' }}
    />
  );

  return (
    <div className="stock-news-page">
      <div className="header">
        <h1>韭研公社个股新闻</h1>
        <div>
          <Button
            icon={<ReloadOutlined />}
            onClick={handleRefresh}
            loading={loading}
            disabled={!currentStock}
            style={{ marginRight: 8 }}
          >
            刷新数据
          </Button>
          <Button type="primary" icon={<RobotOutlined />} onClick={handleAnalyze}>
            AI 分析
          </Button>
        </div>
      </div>

      <div className="stock-search">
        <Space.Compact style={{ width: '100%' }}>
          <Search
            placeholder="输入股票名称或代码，如「贵州茅台」或「sh600519」"
            value={inputStock}
            onChange={(e) => setInputStock(e.target.value)}
            onPressEnter={() => fetchNews(inputStock)}
            enterButton={
              <Button icon={<SearchOutlined />} onClick={() => fetchNews(inputStock)}>
                查询
              </Button>
            }
            style={{ width: '100%' }}
          />
        </Space.Compact>
        {newsData.stock?.code ? (
          <div className="stock-current">
            当前股票：{newsData.stock.name}（{newsData.stock.code}）
          </div>
        ) : null}
      </div>

      <Tabs activeKey={activeTab} onChange={setActiveTab}>
        <TabPane tab="最新新闻" key="latest">
          {renderNewsList(newsData.messages)}
        </TabPane>
        <TabPane tab="全部新闻" key="allDay">
          {renderNewsList(newsData.allDayMessages)}
        </TabPane>
      </Tabs>
    </div>
  );
};

export default StockNews;