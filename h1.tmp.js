const fs = require('fs');
const OpenAI = require('openai');
const { fetchRecentQfqTradeDataForAi } = require('./out/shared/aiStockHistoryData.js');
const { fetchJYGNewsByCode } = require('./out/webview/jiuyangongshe-news.js');

// 读用户真实配置
const raw = fs.readFileSync(process.env.HOME + '/Library/Application Support/CodeBuddy CN/User/settings.json', 'utf8');
const s = raw.indexOf('"leek-fund.aiConfig"'); const b = raw.indexOf('{', s);
let d = 0, json = '';
for (let i = b; i < raw.length; i++) { if (raw[i] === '{') d++; else if (raw[i] === '}') { d--; if (!d) { json = raw.slice(b, i + 1); break; } } }
const cfg = JSON.parse(json);
console.log('使用配置:', cfg.baseUrl, '|', cfg.model, '| key 长度', cfg.apiKey.length);

(async () => {
  const baseMessage = '请根据历史数据和韭研公社个股新闻分析以下股票：贵州茅台，股票代码：sh600519';
  let trade = '', news = '';
  const t = await fetchRecentQfqTradeDataForAi('sh600519', '3m');
  if (t.text) trade = `\n\n以下为近3个月的前复权日线数据（来自${t.sourceLabel}）：\n${t.text}`;
  try {
    const items = await fetchJYGNewsByCode('贵州茅台', 10, 0);
    if (items.length) news = `\n\n以下为韭研公社该股新闻：\n${items.map((i) => `- [${i.create_time}] ${i.title}`).join('\n')}`;
  } catch (e) { console.log('新闻取数失败:', e.message); }
  const message = baseMessage + trade + news;
  console.log('prompt 长度:', message.length, '(行情', trade.length, '+ 新闻', news.length, ')');

  const c = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl });
  for (const maxTokens of [4000, 12000]) {
    const r = await c.chat.completions.create({
      model: cfg.model,
      messages: [
        { role: 'system', content: '你是一个拥有多年投资经验的投资专家，擅长分析股票市场、解读财经新闻、提供投资建议。请用中文回答，保持专业且友好的态度。' },
        { role: 'user', content: message },
      ],
      max_tokens: maxTokens,
      temperature: 0.7,
    });
    const ch = r.choices[0];
    const content = ch?.message?.content || '';
    console.log(`\n===== max_tokens=${maxTokens} =====`);
    console.log('finish_reason:', ch?.finish_reason, '| content 长度:', content.length, '| completion_tokens:', r.usage?.completion_tokens);
    console.log('回复前 150 字:', JSON.stringify(content.slice(0, 150)));
  }
})();
