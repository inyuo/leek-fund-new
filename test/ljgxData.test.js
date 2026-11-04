/**
 * 量价掘金（ljgx）数据层核心测试：
 * 1) SSE 事件解析 extractSseEvents —— 完整帧、分片重组、非 data 行忽略
 * 2) 会话存储 —— deviceId 生成与固化、session 存取往返、re_login 校验降级
 *
 * 说明：全部用内存 store 与注入的 axios mock，不依赖 vscode 与外网；
 * checkSession 经 deps.axios 注入假对象（返回 {status, data} 形状）。
 */
const assert = require('assert');
const ljgx = require('../out/shared/ljgxData');

const SESSION_KEY = 'leek-fund.ljgxSession';
const DEVICE_KEY = 'leek-fund.ljgxDeviceId';

/** 内存版 LjgxStorage（结构同 Memento），_m 供断言已落库 */
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

/** 满足 LjgxSession 形状的样例会话 */
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

describe('SSE 事件解析 extractSseEvents', () => {
  it('返回完整事件数组并清除已消费文本', () => {
    const { events, rest } = ljgx.extractSseEvents('data:{"status":0}\n\ndata:{"status":1}\n\n');
    assert.deepStrictEqual(events, ['{"status":0}', '{"status":1}']);
    assert.strictEqual(rest, '', '两个事件块都已终止，rest 应为空');
  });

  it('把不完整的行留在 rest', () => {
    const a = ljgx.extractSseEvents('data:{"url":"xx');
    assert.deepStrictEqual(a.events, [], '未遇事件边界不应产出事件');
    assert.ok(a.rest !== '', '残行应留在 rest');
  });

  it('组合 rest + 新 chunk 能恢复完整事件', () => {
    // 网络分片把一行 data 切成两半：先拿上半行，再补上下半行 + 事件边界
    const a = ljgx.extractSseEvents('data:{"url":"xx');
    assert.deepStrictEqual(a.events, []);

    const b = ljgx.extractSseEvents(a.rest + '"}\n\ndata:{"status":1}\n\n');
    assert.deepStrictEqual(b.events, ['{"url":"xx"}', '{"status":1}']);
    assert.strictEqual(b.rest, '');
  });

  it('忽略 event: 行与注释行', () => {
    const { events, rest } = ljgx.extractSseEvents(
      'event:msg\n:ping\ndata: {"a":1}\n\n:event\n\ndata:{"b":2}\n\n'
    );
    assert.deepStrictEqual(events, ['{"a":1}', '{"b":2}'], '只取 data: 行，且容忍 data: 后带空格');
    assert.strictEqual(rest, '');
  });
});

describe('设备号 getDeviceId', () => {
  it('首次生成并持久化、二次读取不变且格式为 /^LEEK_\\w+_\\w+$/', () => {
    const store = memStore();
    const id1 = ljgx.getDeviceId(store);
    const id2 = ljgx.getDeviceId(store);

    assert.match(id1, /^LEEK_\w+_\w+$/, `生成的 id 应符合格式，实际 ${id1}`);
    assert.strictEqual(id1, id2, '同一 store 二次读取不生成新 id');
    assert.strictEqual(store._m.get(DEVICE_KEY), id1, '应固化到 store');
  });

  it('已有 deviceId 直接复用不覆盖', () => {
    const store = memStore();
    store.update(DEVICE_KEY, 'LEEK_existing_0001');
    assert.strictEqual(ljgx.getDeviceId(store), 'LEEK_existing_0001');
    assert.strictEqual(store._m.get(DEVICE_KEY), 'LEEK_existing_0001');
  });
});

describe('会话存取 saveSession/loadSession/clearSession', () => {
  it('往返一致（内存 store），空库返回 null', () => {
    const store = memStore();
    assert.strictEqual(ljgx.loadSession(store), null, '空库应为 null');

    const s = sampleSession();
    ljgx.saveSession(store, s);
    assert.deepStrictEqual(ljgx.loadSession(store), s);
    assert.deepStrictEqual(store._m.get(SESSION_KEY), s, '应落在统一 key 上');

    ljgx.clearSession(store);
    assert.strictEqual(ljgx.loadSession(store), null, '清库后应为 null');
    assert.ok(!store._m.has(SESSION_KEY) || store._m.get(SESSION_KEY) === undefined);
  });

  it('loadSession 容忍脏数据：非对象或缺 sessionId 返回 null', () => {
    const store = memStore();
    store.update(SESSION_KEY, 'garbage');
    assert.strictEqual(ljgx.loadSession(store), null);

    store.update(SESSION_KEY, { openId: 'o1' });
    assert.strictEqual(ljgx.loadSession(store), null, '缺 sessionId 不应放行');
  });
});

describe('登录态校验 checkSession', () => {
  /** 真实 re_login 响应载荷（用户已验证格式，2026-11-04 实测）：
   *  外层 {state:true, error:"normal", data:<re_login 载荷>}，
   *  载荷字段 relogin / sessionId / openId / overdueTime(unix秒) / nickName / avatarURL / rg / vip */
  function realPayload(relogin, overdue) {
    return {
      state: true,
      error: 'normal',
      data: {
        relogin,
        sessionId: 'wx_sess_abc',
        openId: 'oX8s1',
        overdueTime: overdue,
        nickName: '股海浮沉',
        avatarURL: 'https://thirdwx.qlogo.cn/mmopen/vi_32/sample2.png',
        rg: [],
        vip: 1,
      },
    };
  }

  it('带真实响应载荷（用户已验证格式）返回 null', async () => {
    // 过期会话：真实验证场景 re_login 返回 relogin:true → 清库回未登录态
    const store = memStore();
    ljgx.saveSession(store, sampleSession({ overdueTime: 1762000000 }));

    let calls = 0;
    const mockAxios = {
      post: async () => {
        calls += 1;
        return { status: 200, data: realPayload(true, 0) };
      },
    };

    const r = await ljgx.checkSession(store, { axios: mockAxios });
    assert.strictEqual(calls, 1, '应恰好发起一次 re_login');
    assert.strictEqual(r, null, 'relogin:true → 返回 null');
    assert.strictEqual(ljgx.loadSession(store), null, '会话应被清除');
  });

  it('re_login 成功（relogin:false）刷新 overdueTime 并返回最新 session', async () => {
    const store = memStore();
    ljgx.saveSession(store, sampleSession({ overdueTime: 1762000000 }));

    const NEW_OVERDUE = 1762854000;
    const mockAxios = {
      post: async () => ({ status: 200, data: realPayload(false, NEW_OVERDUE) }),
    };

    const r = await ljgx.checkSession(store, { axios: mockAxios });
    assert.strictEqual(r.overdueTime, NEW_OVERDUE, '应刷新为新 overdueTime');
    assert.strictEqual(r.avatarUrl, 'https://thirdwx.qlogo.cn/mmopen/vi_32/sample2.png', '响应 avatarURL 应映射进 avatarUrl');
    assert.deepStrictEqual(ljgx.loadSession(store).overdueTime, NEW_OVERDUE, '新 overdueTime 应落库');
  });

  it('请求带 re_login 路径与 user-token header', async () => {
    const store = memStore();
    ljgx.saveSession(store, sampleSession({ sessionId: 'wx_tok_42' }));

    let seen = null;
    const mockAxios = {
      post: async (url, body, opts) => {
        seen = { url, body, headers: opts && opts.headers };
        return { status: 200, data: realPayload(false, 1762854000) };
      },
    };
    await ljgx.checkSession(store, { axios: mockAxios });

    assert.ok(/\/weixin\.re_login$/.test(seen.url), `应请求 re_login，实际 ${seen.url}`);
    assert.deepStrictEqual(seen.body, {}, '入参为空对象');
    assert.strictEqual(seen.headers['user-token'], 'wx_tok_42', 'sessionId 应放 user-token header');
  });

  it('network 异常返回 null 且清库（不抛异常）', async () => {
    const store = memStore();
    ljgx.saveSession(store, sampleSession());

    const mockAxios = {
      post: async () => {
        throw new Error('timeout of 30000ms exceeded');
      },
    };
    const r = await ljgx.checkSession(store, { axios: mockAxios });
    assert.strictEqual(r, null);
    assert.strictEqual(ljgx.loadSession(store), null, '失败也应清库');
  });

  it('HTTP >=400 返回 null 且清库', async () => {
    const store = memStore();
    ljgx.saveSession(store, sampleSession());

    const mockAxios = {
      post: async () => ({ status: 500, data: {} }),
    };
    const r = await ljgx.checkSession(store, { axios: mockAxios });
    assert.strictEqual(r, null);
    assert.strictEqual(ljgx.loadSession(store), null);
  });

  it('无 session 时直接返回 null 不发请求', async () => {
    const store = memStore();
    let calls = 0;
    const mockAxios = {
      post: async () => {
        calls += 1;
        return { status: 200, data: realPayload(false, 1) };
      },
    };
    const r = await ljgx.checkSession(store, { axios: mockAxios });
    assert.strictEqual(r, null);
    assert.strictEqual(calls, 0, '本地无会话不应发请求');
  });
});
