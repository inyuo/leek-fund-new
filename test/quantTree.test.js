/**
 * 量价掘金侧边栏树测试：
 * 1) buildQuantNodes —— 去掉暗盘榜单与重复面板入口后，未登录/已登录都只有
 *    「登录或用户 + 单个量化面板入口（默认 north）」
 * 2) QuantProvider —— 会话校验 TTL、refreshData 语义、不再拉暗盘榜单
 *
 * quantProvider 顶层依赖 vscode 的 TreeItem，测试环境经 Module._resolveFilename
 * 重定向到 helpers/vscode-mock.js。
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

function loggedInState() {
  return { session: sampleSession(), sessionValid: true };
}

function loggedOutState() {
  return { session: null, sessionValid: false };
}

describe('buildQuantNodes 节点编排（精简后）', () => {
  it('未登录 → [login, panel(north)]', () => {
    const nodes = quant.buildQuantNodes(loggedOutState());
    assert.deepStrictEqual(
      nodes.map((n) => [n.kind, n.payload && n.payload.tab]),
      [['login', undefined], ['panel', 'north']]
    );
    assert.strictEqual(nodes[0].command.command, 'leek-fund.quantLogin');
    assert.strictEqual(nodes[0].label, '微信扫码登录');
  });

  it('已登录 → [user, panel(north)]，单入口标签与命令参数', () => {
    const nodes = quant.buildQuantNodes(loggedInState());
    assert.deepStrictEqual(nodes.map((n) => n.kind), ['user', 'panel']);
    assert.strictEqual(nodes[1].label, '打开量化面板');
    assert.strictEqual(nodes[1].command.command, 'leek-fund.quantOpen');
    assert.deepStrictEqual(nodes[1].command.arguments, [{ tab: 'north' }]);
    assert.deepStrictEqual(nodes[1].payload, { tab: 'north' });
  });

  it('即使 state 仍带旧 darkBuy 字段，也不输出任何榜单节点', () => {
    const nodes = quant.buildQuantNodes(
      Object.assign(loggedInState(), {
        darkBuy: { title: '2026-11-04', list: [{ code: 'sz000001' }] },
        darkBuyFailed: false,
      })
    );
    assert.deepStrictEqual(nodes.map((n) => n.kind), ['user', 'panel']);
    assert.strictEqual(nodes.some((n) => /dark/i.test(n.kind)), false);
  });

  it('user 节点 tooltip 含 overdueTime 的日期文本（秒 → yyyy-MM-dd HH:mm）', () => {
    const overdue = 1762249200;
    const nodes = quant.buildQuantNodes({
      session: sampleSession({ overdueTime: overdue }),
      sessionValid: true,
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

  it('不再有策略选股等独立面板入口（面板内 4 个 tab 自行切换）', () => {
    const nodes = quant.buildQuantNodes(loggedInState());
    assert.strictEqual(nodes.filter((n) => n.kind === 'panel').length, 1);
    assert.strictEqual(nodes.some((n) => n.payload && n.payload.tab === 'lq'), false);
  });
});

describe('QuantProvider（store + mock checkSession）', () => {
  /** 只注入 checkSession：精简后 provider 不再接受 fetchDarkBuy 依赖 */
  function makeProvider(store, sessionValid = true) {
    const calls = { check: 0 };
    const provider = new quant.QuantProvider({
      store,
      checkSession: async () => {
        calls.check += 1;
        return sessionValid ? store.get('leek-fund.ljgxSession') : null;
      },
    });
    return { provider, calls };
  }

  it('已登录 → getChildren = [user, panel(north)]', async () => {
    const store = memStore();
    ljgx.saveSession(store, sampleSession());
    const { provider, calls } = makeProvider(store);

    const nodes = await provider.getChildren();
    assert.deepStrictEqual(
      nodes.map((n) => [n.kind, n.payload && n.payload.tab]),
      [['user', undefined], ['panel', 'north']]
    );
    assert.strictEqual(calls.check, 1, '应做一次静默会话校验');
  });

  it('无会话 → [login, panel(north)]，不校验会话', async () => {
    const store = memStore();
    const { provider, calls } = makeProvider(store);

    const nodes = await provider.getChildren();
    assert.deepStrictEqual(
      nodes.map((n) => [n.kind, n.payload && n.payload.tab]),
      [['login', undefined], ['panel', 'north']]
    );
    assert.strictEqual(calls.check, 0);
  });

  it('checkSession 5min TTL：重绘不重复校验，TTL 过后重新校验', async () => {
    const store = memStore();
    ljgx.saveSession(store, sampleSession());
    const { provider, calls } = makeProvider(store);

    await provider.getChildren();
    await provider.getChildren();
    assert.strictEqual(calls.check, 1, 'TTL 内两次 getChildren 只应校验一次');

    provider.sessionCheckTime = 0;
    await provider.getChildren();
    assert.strictEqual(calls.check, 2);
  });

  it('refreshData 重新校验会话并重绘，不再拉榜单', async () => {
    const store = memStore();
    ljgx.saveSession(store, sampleSession());
    const { provider, calls } = makeProvider(store);

    await provider.getChildren();
    assert.strictEqual(calls.check, 1);
    await provider.refreshData();
    assert.strictEqual(calls.check, 2, '刷新应清会话 TTL 重新校验');

    const nodes = await provider.getChildren();
    assert.strictEqual(nodes.length, 2);
  });

  it('会话过期（checkSession 返回 null）→ 回到未登录态', async () => {
    const store = memStore();
    ljgx.saveSession(store, sampleSession());
    const { provider } = makeProvider(store, false);

    const nodes = await provider.getChildren();
    assert.deepStrictEqual(nodes.map((n) => n.kind), ['login', 'panel']);
  });
});
