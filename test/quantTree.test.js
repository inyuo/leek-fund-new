/**
 * 量价掘金侧边栏树测试：
 * 1) buildQuantNodes 节点编排 —— 未登录/已登录序列、darkRow 点击参数、
 *    有效期 tooltip、加载失败与空榜单占位
 * 2) QuantProvider 注入 store + mock fetchers —— getChildren 序列与榜单 TTL 缓存
 *
 * quantProvider 顶层依赖 vscode 的 TreeItem，测试环境经 Module._resolveFilename
 * 重定向到 helpers/vscode-mock.js（与 news.test.js 同一模式）。
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

const vscodeMockPath = path.join(__dirname, 'helpers', 'vscode-mock.js');
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return vscodeMockPath;
  return origResolveFilename.call(this, request, ...args);
};

const ljgx = require('../out/shared/ljgxData');
const quant = require('../out/explorer/quantProvider');

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/** 内存版 LjgxStorage（结构同 Memento） */
function memStore() {
  const m = new Map();
  return {
    get: (key) => m.get(key),
    update: (key, value) => {
      m.set(key, value);
      return Promise.resolve();
    },
    _m: m,
  };
}

/** 满足 LjgxSession 形状的样例会话（overdueTime 为 unix 秒） */
function sampleSession(overrides) {
  return Object.assign(
    {
      sessionId: 'wx_sess_abc',
      openId: 'oX8s1',
      overdueTime: 1762249200,
      userName: '股海浮沉',
      avatarUrl: 'https://thirdwx.qlogo.cn/mmopen/vi_32/sample.png',
      did: 'LEEK_k3x9p2_ab12cd',
    },
    overrides || {}
  );
}

/** 暗盘榜单数据（两行） */
function sampleRows() {
  return [
    {
      code: 'sz000001',
      name: '平安银行',
      td1: '15.21',
      td2: '+1.2%',
      color1: '',
      color2: '',
      url: '',
      ext: '',
    },
    {
      code: 'sh600000',
      name: '浦发银行',
      td1: '9.44',
      td2: '-0.4%',
      color1: '',
      color2: '',
      url: '',
      ext: '',
    },
  ];
}

function darkData() {
  return { title: '2026-11-04 暗盘买入', list: sampleRows() };
}

/** 已登录 + 榜单两行的 state */
function loggedInState() {
  return {
    session: sampleSession(),
    sessionValid: true,
    darkBuy: darkData(),
    darkBuyFailed: false,
  };
}

describe('buildQuantNodes 节点编排', () => {
  it('未登录 → 节点序列 = [login, panel(north), panel(index)]', () => {
    const nodes = quant.buildQuantNodes({
      session: null,
      sessionValid: false,
      darkBuy: null,
      darkBuyFailed: false,
    });
    assert.deepStrictEqual(
      nodes.map((n) => [n.kind, n.payload && n.payload.tab]),
      [['login', undefined], ['panel', 'north'], ['panel', 'index']],
      '未登录只显示扫码入口与免登录面板'
    );
    assert.strictEqual(nodes[0].command.command, 'leek-fund.quantLogin');
    assert.strictEqual(nodes[0].label, '微信扫码登录');
  });

  it('已登录 + 榜单 2 行 → [user, darkHeader, row1, row2, panel(cjl), panel(north), panel(index)]', () => {
    const nodes = quant.buildQuantNodes(loggedInState());
    assert.deepStrictEqual(
      nodes.map((n) => n.kind),
      ['user', 'darkHeader', 'darkRow', 'darkRow', 'panel', 'panel', 'panel'],
      '节点序列应为 user + 榜单区 + 三个面板入口'
    );
    assert.deepStrictEqual(
      nodes.slice(4).map((n) => n.payload.tab),
      ['cjl', 'north', 'index'],
      '面板节点依次为 量价分层 / 北向资金 / 大盘指数'
    );
    assert.deepStrictEqual(nodes[4].payload, { tab: 'cjl' });

    // darkRow 点击参数：stockFundFlowForStock，arguments[0].id == code
    const row1 = nodes[2];
    assert.strictEqual(row1.command.command, 'leek-fund.stockFundFlowForStock');
    assert.strictEqual(row1.command.arguments[0].id, 'sz000001');
    const row2 = nodes[3];
    assert.strictEqual(row2.command.arguments[0].id, 'sh600000');
  });

  it('user 节点 tooltip 含 overdueTime 的日期文本（秒 → yyyy-MM-dd HH:mm）', () => {
    const overdue = 1762249200;
    const nodes = quant.buildQuantNodes({
      session: sampleSession({ overdueTime: overdue }),
      sessionValid: true,
      darkBuy: null,
      darkBuyFailed: true,
    });
    const user = nodes[0];
    assert.strictEqual(user.kind, 'user');
    assert.strictEqual(user.label, '股海浮沉');
    const d = new Date(overdue * 1000);
    const expected = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
      d.getHours()
    )}:${pad2(d.getMinutes())}`;
    assert.strictEqual(user.tooltip, `登录有效期至 ${expected}`);
  });

  it('fetchDarkBuy 返回 null → 榜单位置为加载失败占位节点，command 绑 refreshQuant', () => {
    const nodes = quant.buildQuantNodes({
      session: sampleSession(),
      sessionValid: true,
      darkBuy: null,
      darkBuyFailed: true,
    });
    // 失败占位替代整个榜单区：[user, 占位, panel(cjl), panel(north), panel(index)]
    assert.strictEqual(nodes[1].kind, 'darkHeader');
    assert.strictEqual(nodes[1].label, '榜单加载失败（点击重试）');
    assert.strictEqual(nodes[1].command.command, 'leek-fund.refreshQuant');
    assert.strictEqual(nodes.length, 5);
  });

  it('榜单 list 为空 → 「暂无榜单数据」占位节点', () => {
    const nodes = quant.buildQuantNodes({
      session: sampleSession(),
      sessionValid: true,
      darkBuy: { title: '2026-11-04 暗盘买入', list: [] },
      darkBuyFailed: false,
    });
    assert.strictEqual(nodes[1].kind, 'darkHeader');
    assert.strictEqual(nodes[1].label, '暂无榜单数据');
    assert.strictEqual(nodes.length, 5);
  });
});

describe('QuantProvider（store + mock fetchers 注入）', () => {
  function makeProvider(store, fetchMocks) {
    const calls = { dark: 0, check: 0 };
    const provider = new quant.QuantProvider({
      store,
      fetchDarkBuy: async () => {
        calls.dark++;
        return fetchMocks.dark ? darkData() : null;
      },
      checkSession: async () => {
        calls.check++;
        return fetchMocks.check ? store.get('leek-fund.ljgxSession') : null;
      },
    });
    return { provider, calls };
  }

  it('已登录 → getChildren 序列完整并带榜单行', async () => {
    const store = memStore();
    ljgx.saveSession(store, sampleSession());
    const { provider } = makeProvider(store, { dark: true, check: true });

    const nodes = await provider.getChildren();
    assert.deepStrictEqual(
      nodes.map((n) => n.kind),
      ['user', 'darkHeader', 'darkRow', 'darkRow', 'panel', 'panel', 'panel']
    );
    const rows = nodes.filter((n) => n.kind === 'darkRow');
    assert.strictEqual(rows[0].command.arguments[0].id, 'sz000001');
    // QuantTreeItem 实例化后的点击命令与 payload
    assert.strictEqual(rows[0].payload.code, 'sz000001');
  });

  it('榜单 30min TTL 内复用缓存，refreshData 清缓存重新拉取', async () => {
    const store = memStore();
    ljgx.saveSession(store, sampleSession());
    const { provider, calls } = makeProvider(store, { dark: true, check: true });

    await provider.getChildren();
    await provider.getChildren();
    assert.strictEqual(calls.dark, 1, 'TTL 内不应重复拉榜单');

    await provider.refreshData();
    assert.strictEqual(calls.dark, 2, '刷新命令应清缓存重新拉取');
  });

  it('无会话 → getChildren = [login, panel(north), panel(index)]', async () => {
    const store = memStore();
    const { provider, calls } = makeProvider(store, { dark: true, check: true });

    const nodes = await provider.getChildren();
    assert.deepStrictEqual(
      nodes.map((n) => [n.kind, n.payload && n.payload.tab]),
      [['login', undefined], ['panel', 'north'], ['panel', 'index']],
      '未登录不发起榜单请求'
    );
    assert.strictEqual(calls.dark, 0, '未登录不应请求暗盘榜单');
    assert.strictEqual(calls.check, 0, '未登录不应请求会话校验');
  });

  it('fetchDarkBuy 失败 → getChildren 榜单区为加载失败占位', async () => {
    const store = memStore();
    ljgx.saveSession(store, sampleSession());
    const { provider } = makeProvider(store, { dark: false, check: true });

    const nodes = await provider.getChildren();
    assert.deepStrictEqual(nodes.map((n) => n.kind), [
      'user',
      'darkHeader',
      'panel',
      'panel',
      'panel',
    ]);
    assert.strictEqual(nodes[1].label, '榜单加载失败（点击重试）');
    assert.strictEqual(nodes[1].command.command, 'leek-fund.refreshQuant');
  });
});
