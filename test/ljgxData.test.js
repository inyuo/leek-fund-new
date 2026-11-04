/**
 * 量价掘金（ljgx）数据层核心测试：
 * 1) SSE 事件解析 extractSseEvents —— 完整帧、分片重组、非 data 行忽略
 * 2) 会话存储 —— deviceId 生成与固化、session 存取往返、re_login 校验降级
 *
 * 说明：全部用内存 store 与注入的 axios mock，不依赖 vscode 与外网；
 * checkSession 经 deps.axios 注入假对象（返回 {status, data} 形状）。
 */
const assert = require('assert');
const { EventEmitter } = require('events');
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

/** 假 SSE 流：EventEmitter 模拟 Node stream，支持 destroy（stop() 会调用） */
function fakeStream() {
  const s = new EventEmitter();
  s.destroyed = false;
  s.destroy = function () {
    this.destroyed = true;
  };
  return s;
}

/** 记录每次连接的 url 与对应假流，测试按序取用 */
function fakeHttpFactory() {
  const records = [];
  const fn = (url) => {
    const stream = fakeStream();
    records.push({ url, stream });
    return stream;
  };
  return { fn, records };
}

// SSE 一帧 data 事件即可被 extractSseEvents 消费的文本
function sseFrame(obj) {
  return `data:${JSON.stringify(obj)}\n\n`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('登录监听器 startLoginWatch', () => {
  const QR_RAW = { code: 0, status: 0, url: 'https://qr.example/x.png' };

  it('首帧 status:0 回调 onQrcode 且不落库', function () {
    this.timeout(3000);
    const store = memStore();
    store.update(DEVICE_KEY, 'LEEK_t1_did');

    const f = fakeHttpFactory();
    const qrcodes = [];
    const watch = ljgx.startLoginWatch(
      'LEEK_t1_did',
      { onQrcode: (url) => qrcodes.push(url), onLogin: () => assert.fail('等待扫码不应回调 onLogin') },
      { httpStream: f.fn, store }
    );

    assert.strictEqual(f.records.length, 1, '应发起一次连接');
    assert.ok(
      /weixin\.login\?did=LEEK_t1_did$/.test(f.records[0].url),
      `应请求登录 SSE 接口，实际 ${f.records[0].url}`
    );

    f.records[0].stream.emit('data', sseFrame(QR_RAW));

    assert.deepStrictEqual(qrcodes, ['https://qr.example/x.png'], '应回调 onQrcode(raw.url)');
    assert.strictEqual(ljgx.loadSession(store), null, '等待扫码不得落库');

    watch.stop();
  });

  it('首帧直接 status:1（重连补状态场景）落库并回调 onLogin 后停', async function () {
    this.timeout(3000);
    const store = memStore();
    store.update(DEVICE_KEY, 'LEEK_t2_did');

    const f = fakeHttpFactory();
    const logins = [];
    const watch = ljgx.startLoginWatch(
      'LEEK_t2_did',
      { onQrcode: () => assert.fail('status:1 不应回调 onQrcode'), onLogin: (s) => logins.push(s) },
      { httpStream: f.fn, store }
    );

    f.records[0].stream.emit(
      'data',
      sseFrame({
        code: 1,
        status: 1,
        sessionId: 'wx_sess_re',
        userId: 'oX_re',
        userName: '浮沉',
        avatarUrl: 'https://a/re.png',
      })
    );

    const expected = {
      sessionId: 'wx_sess_re',
      openId: 'oX_re',
      overdueTime: 0,
      userName: '浮沉',
      avatarUrl: 'https://a/re.png',
      did: 'LEEK_t2_did',
    };
    assert.deepStrictEqual(logins, [expected], 'onLogin 应收到组装好的会话');
    assert.deepStrictEqual(ljgx.loadSession(store), expected, 'status:1 必须落库');

    // 登录成功自动停：后续 end 也不得再开新连接、不再回调
    f.records[0].stream.emit('end');
    await sleep(1150);
    assert.strictEqual(f.records.length, 1, 'onLogin 后应自动停止，不得重连');
    assert.ok(f.records[0].stream.destroyed, '停止时应关闭当前流');

    watch.stop(); // 幂等：已停后再调不报错
  });

  it('流断开后重连：注入假 httpStream 第二次成功，onLogin 正常触发', async function () {
    this.timeout(3000);
    const store = memStore();
    store.update(DEVICE_KEY, 'LEEK_t3_did');

    const f = fakeHttpFactory();
    const qrcodes = [];
    const logins = [];
    const watch = ljgx.startLoginWatch(
      'LEEK_t3_did',
      { onQrcode: (url) => qrcodes.push(url), onLogin: (s) => logins.push(s) },
      { httpStream: f.fn, store }
    );

    // 第一次连接：先推等待扫码帧，再断流 —— 不得清任何状态
    f.records[0].stream.emit('data', sseFrame(QR_RAW));
    f.records[0].stream.emit('end');
    assert.strictEqual(f.records.length, 1, 'end 后应节流 1s，不得立刻重连');
    assert.deepStrictEqual(qrcodes, ['https://qr.example/x.png'], '断流前收到的帧应照常回调');

    await sleep(1150);
    assert.strictEqual(f.records.length, 2, '流断开后应静默重连');

    // 重连首帧直接 status:1（服务端补状态）
    f.records[1].stream.emit(
      'data',
      sseFrame({ status: 1, sessionId: 'wx_r1', userId: 'oR1', userName: 'rs', avatarUrl: 'u1' })
    );
    assert.strictEqual(logins.length, 1, '重连后 onLogin 正常触发');
    assert.strictEqual(logins[0].sessionId, 'wx_r1');
    assert.strictEqual(ljgx.loadSession(store).sessionId, 'wx_r1', '重连登录应落库');

    watch.stop();
  });

  it('stop() 后不再重连也不再回调', async function () {
    this.timeout(3000);
    const store = memStore();
    store.update(DEVICE_KEY, 'LEEK_t4_did');

    const f = fakeHttpFactory();
    const qrcodes = [];
    const logins = [];
    const watch = ljgx.startLoginWatch(
      'LEEK_t4_did',
      { onQrcode: (url) => qrcodes.push(url), onLogin: (s) => logins.push(s) },
      { httpStream: f.fn, store }
    );

    watch.stop(); // 立即停止
    assert.ok(f.records[0].stream.destroyed, 'stop 应关闭当前流');

    // stop 后到达的帧与断流事件都不得触发任何回调或重连
    f.records[0].stream.emit('data', sseFrame({ status: 1, sessionId: 'wx_x', userId: 'oX' }));
    f.records[0].stream.emit('end');
    await sleep(1150);
    assert.deepStrictEqual(logins, [], 'stop 后不得回调 onLogin');
    assert.strictEqual(ljgx.loadSession(store), null, 'stop 后不得落库');
    assert.strictEqual(f.records.length, 1, 'stop 后不得重连');
  });

  it('httpStream 直接失败（Promise reject）→ 静默重连且不清现有会话', async function () {
    this.timeout(3500);
    const store = memStore();
    const existing = sampleSession({ did: 'LEEK_t5_did' });
    ljgx.saveSession(store, existing);

    let calls = 0;
    let secondStream = null;
    const logins = [];
    const httpStream = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('ECONNRESET'));
      secondStream = fakeStream();
      return secondStream;
    };

    const watch = ljgx.startLoginWatch('LEEK_t5_did', { onQrcode: () => {}, onLogin: (s) => logins.push(s) }, { httpStream, store });
    assert.strictEqual(calls, 1, '失败后应节流，不得立刻重试');

    await sleep(1150);
    assert.strictEqual(calls, 2, '网络失败 1s 后应静默重连');
    assert.deepStrictEqual(ljgx.loadSession(store), existing, '失败重连不得清现有会话');

    secondStream.emit(
      'data',
      sseFrame({ status: 1, sessionId: 'wx_rej', userId: 'oRj', userName: 'rj', avatarUrl: 'r' })
    );
    assert.strictEqual(logins.length, 1);
    assert.strictEqual(logins[0].sessionId, 'wx_rej');

    watch.stop();
  });

  it('跨 chunk 半帧拼接：一帧 data 被网络切成两段也能解析出完整 url', function () {
    this.timeout(3000);
    const store = memStore();
    store.update(DEVICE_KEY, 'LEEK_t6_did');

    const f = fakeHttpFactory();
    const qrcodes = [];
    const watch = ljgx.startLoginWatch(
      'LEEK_t6_did',
      { onQrcode: (url) => qrcodes.push(url), onLogin: () => assert.fail('不应回调 onLogin') },
      { httpStream: f.fn, store }
    );

    // 同一帧 data 被切成两个半段：第一段含上半行，第二段补完并带事件边界
    const frame = sseFrame(QR_RAW);
    const cut = Math.floor(frame.length / 2);
    f.records[0].stream.emit('data', frame.slice(0, cut));
    assert.deepStrictEqual(qrcodes, [], '半帧不应产生事件');
    f.records[0].stream.emit('data', frame.slice(cut));

    assert.deepStrictEqual(qrcodes, [QR_RAW.url], '监听器应持有残行并拼接，回调完整 url 一次');

    watch.stop();
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

  it('network 异常 → 保守返回原 session 且不清库（不抛异常）', async () => {
    const store = memStore();
    const original = sampleSession();
    ljgx.saveSession(store, original);

    const mockAxios = {
      post: async () => {
        throw new Error('timeout of 30000ms exceeded');
      },
    };
    const r = await ljgx.checkSession(store, { axios: mockAxios });
    assert.deepStrictEqual(r, original, '网络失败应保留原会话原样返回，不清库');
    assert.deepStrictEqual(ljgx.loadSession(store), original, '本地会话不得被破坏');
  });

  it('HTTP >=400 → 保守返回原 session 且不清库', async () => {
    const store = memStore();
    const original = sampleSession();
    ljgx.saveSession(store, original);

    const mockAxios = {
      post: async () => ({ status: 500, data: {} }),
    };
    const r = await ljgx.checkSession(store, { axios: mockAxios });
    assert.deepStrictEqual(r, original, 'HTTP 非 200 应保留原会话');
    assert.deepStrictEqual(ljgx.loadSession(store), original);
  });

  it('响应不可解析（state!==true）→ 保守返回原 session 且不清库', async () => {
    const store = memStore();
    const original = sampleSession();
    ljgx.saveSession(store, original);

    const mockAxios = {
      post: async () => ({ status: 200, data: { state: false, code: 500, error: 'boom' } }),
    };
    const r = await ljgx.checkSession(store, { axios: mockAxios });
    assert.deepStrictEqual(r, original, '不可解析响应≠业务信号，不得清会话');
    assert.deepStrictEqual(ljgx.loadSession(store), original);
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

describe('授权数据接口 fetchDarkBuy / fetchShareCjl', () => {
  /** 记录请求条件的 mock axios */
  function recordingAxios(payloadOfCall) {
    const calls = [];
    return {
      calls,
      post: async (url, body, opts) => {
        calls.push({ url, body, headers: opts && opts.headers });
        return payloadOfCall(calls.length, calls[calls.length - 1]);
      },
    };
  }

  /** 真实 shares.get_dark_buy 响应载荷（2026-11-04 实测验证格式） */
  function darkBuyPayload() {
    return {
      state: true,
      error: 'normal',
      data: {
        title: '2026-11-03（周二）',
        vaild: 1,
        thList: ['名称', '现价', '涨幅'],
        list: [
          {
            code: 'sz300750',
            simpleCode: '300750',
            ext: '创',
            name: '宁德时代',
            price: 258.5,
            percent: 2.3,
            optional: 0,
            td1: '5.95亿',
            td2: '12.85亿',
            data1: 1,
            data2: 2,
            color1: '#ff0000',
            color2: '#00aa00',
            url: '/pages/add/add?scode=sz300750',
            value1: 9,
          },
          // 缺 td2/color1/url/ext 的条目 → 容错为空串
          { code: 'sh688981', name: '中芯国际', td1: '3.20亿', color2: '#00aa00', price: 88.8 },
        ],
      },
    };
  }

  it('正常载荷 → 归一化数组 + title，带 user-token header 与默认 body', async () => {
    const store = memStore();
    ljgx.saveSession(store, sampleSession({ sessionId: 'wx_tok_77' }));

    const mock = recordingAxios(() => ({ status: 200, data: darkBuyPayload() }));
    const r = await ljgx.fetchDarkBuy(2, 'all', { axios: mock, store });

    assert.strictEqual(mock.calls.length, 1, '应恰好请求一次');
    assert.ok(
      /\/shares\.get_dark_buy$/.test(mock.calls[0].url),
      `应请求 shares.get_dark_buy，实际 ${mock.calls[0].url}`
    );
    assert.deepStrictEqual(mock.calls[0].body, { days: 2, tag: 'all' }, '默认 days/tag 入参');
    assert.strictEqual(mock.calls[0].headers['user-token'], 'wx_tok_77', 'sessionId 放 user-token header');

    assert.deepStrictEqual(r, {
      title: '2026-11-03（周二）',
      list: [
        {
          code: 'sz300750',
          name: '宁德时代',
          td1: '5.95亿',
          td2: '12.85亿',
          color1: '#ff0000',
          color2: '#00aa00',
          url: '/pages/add/add?scode=sz300750',
          ext: '创',
        },
        {
          code: 'sh688981',
          name: '中芯国际',
          td1: '3.20亿',
          td2: '',
          color1: '',
          color2: '#00aa00',
          url: '',
          ext: '',
        },
      ],
    }, '只保留归一化字段，缺失字段容错为空串');
  });

  it('state:false code:1018 → 返回 null 且 clearSession 被调用（内存 store 验证）', async () => {
    const store = memStore();
    ljgx.saveSession(store, sampleSession());

    const mock = recordingAxios(() => ({
      status: 200,
      data: { state: false, code: 1018, error: '登录已过期' },
    }));

    const r = await ljgx.fetchDarkBuy(2, 'all', { axios: mock, store });

    assert.strictEqual(r, null, '1018 应返回 null');
    assert.strictEqual(ljgx.loadSession(store), null, '1018 → 默认 clearSession 应清掉会话');
  });

  it('网络异常 → 返回 null 不抛，且不清会话', async () => {
    const store = memStore();
    const original = sampleSession();
    ljgx.saveSession(store, original);

    const mockAxios = {
      post: async () => {
        throw new Error('timeout of 30000ms exceeded');
      },
    };
    const r = await ljgx.fetchDarkBuy(2, 'all', { axios: mockAxios, store });
    assert.strictEqual(r, null, '网络失败应静默返回 null');
    assert.deepStrictEqual(ljgx.loadSession(store), original, '网络失败≠会话失效，不得清库');
  });

  it('HTTP >=400 / state!==true → 返回 null 不抛，且不清会话', async () => {
    const store = memStore();
    const original = sampleSession();
    ljgx.saveSession(store, original);

    const r1 = await ljgx.fetchDarkBuy(2, 'all', {
      axios: recordingAxios(() => ({ status: 500, data: {} })),
      store,
    });
    assert.strictEqual(r1, null, 'HTTP 500 应返回 null');

    const r2 = await ljgx.fetchDarkBuy(2, 'all', {
      axios: recordingAxios(() => ({ status: 200, data: { state: false, code: 500, error: 'boom' } })),
      store,
    });
    assert.strictEqual(r2, null, 'state!==true 且非 1018 应返回 null');
    assert.deepStrictEqual(ljgx.loadSession(store), original, '非 1018 失败不得清库');
  });

  it('fetchShareCjl 正常载荷：price 过滤掉 null 与非数字，保留数字（含 0）', async () => {
    const store = memStore();
    ljgx.saveSession(store, sampleSession({ sessionId: 'wx_tok_88' }));

    const mock = recordingAxios(() => ({
      status: 200,
      data: { state: true, error: 'normal', data: { tm: '2026-11-03', price: [3456.78, null, 0, 'bad', 123.45, NaN] } },
    }));
    const r = await ljgx.fetchShareCjl(['sh000001', 'sz399001'], { axios: mock, store });

    assert.strictEqual(mock.calls.length, 1);
    assert.ok(
      /\/analy\.get_share_cjl$/.test(mock.calls[0].url),
      `应请求 analy.get_share_cjl，实际 ${mock.calls[0].url}`
    );
    assert.deepStrictEqual(
      mock.calls[0].body,
      { codes: ['sh000001', 'sz399001'] },
      'codes 数组原样放 body'
    );
    assert.strictEqual(mock.calls[0].headers['user-token'], 'wx_tok_88', 'sessionId 放 user-token header');

    assert.deepStrictEqual(r, { tm: '2026-11-03', price: [3456.78, 0, 123.45] }, 'null/非数字剔除，0 保留');
  });

  it('fetchShareCjl 同错误策略：1018 清会话返回 null，网络异常不清会话', async () => {
    const store = memStore();
    const original = sampleSession();
    ljgx.saveSession(store, original);

    const r1 = await ljgx.fetchShareCjl(['sh000001'], {
      axios: recordingAxios(() => ({ status: 200, data: { state: false, code: 1018, error: '登录已过期' } })),
      store,
    });
    assert.strictEqual(r1, null, '1018 应返回 null');
    assert.strictEqual(ljgx.loadSession(store), null, '1018 应清掉会话');

    ljgx.saveSession(store, original);
    const mockAxios = { post: async () => { throw new Error('ECONNRESET'); } };
    const r2 = await ljgx.fetchShareCjl(['sh000001'], { axios: mockAxios, store });
    assert.strictEqual(r2, null, '网络异常应返回 null');
    assert.deepStrictEqual(ljgx.loadSession(store), original, '网络异常不得清库');
  });
});

describe('免登录数据接口 fetchNorthFundTrends / fetchIndexSpark', () => {
  /**
   * 东财 kamt.rtmin 真实载荷形状（2026-11-04 实测，数值替换为可断言样本）：
   * data.s2n 为『时间,沪股通净流入,深股通净流入,合计』字符串数组；
   * 未到的分时样本为 `-` 占位（如 10:56,-,-,-），早盘前为 0.00。
   */
  function kamtPayload() {
    return {
      rc: 0,
      rt: 14,
      data: {
        s2n: [
          '9:30,5.10,6.20,11.30',
          '9:31,-8.30,7.40,-0.90',
          '10:56,-,-,-',
          '10:57,,,',
        ],
        n2s: ['9:00,1.00,2.00,3.00'],
        s2nDate: '11-04',
        n2sDate: '11-04',
      },
    };
  }

  it('北向资金：正常载荷 → s2n 逗号归一化，剔除 -/空样本行，带浏览器头', async () => {
    const calls = [];
    const mock = {
      get: async (url, opts) => {
        calls.push({ url, opts });
        return { status: 200, data: kamtPayload() };
      },
    };

    const r = await ljgx.fetchNorthFundTrends({ axios: mock });

    assert.strictEqual(calls.length, 1, '应恰好请求一次');
    assert.ok(
      /push2\.eastmoney\.com\/api\/qt\/kamt\.rtmin\/get\?.*ut=/.test(calls[0].url),
      `应请求东财 kamt.rtmin，实际 ${calls[0].url}`
    );
    assert.ok(/quote\.eastmoney\.com/.test(calls[0].opts.headers.Referer), '带 quote.eastmoney.com Referer 防风控');
    assert.strictEqual(
      calls[0].opts.validateStatus(500),
      true,
      'validateStatus 恒 true（HTTP >=400 归一为 null）'
    );

    assert.deepStrictEqual(r, {
      times: ['9:30', '9:31'],
      hgtNet: [5.1, -8.3],
      szgtNet: [6.2, 7.4],
    }, '剔除 - 占位行与空字段行，三数组保持对齐');
  });

  it('北向资金：s2n 缺失 / 样本全空 → null 不抛', async () => {
    const mock1 = { get: async () => ({ status: 200, data: { rc: 0, data: {} } }) };
    const r1 = await ljgx.fetchNorthFundTrends({ axios: mock1 });
    assert.strictEqual(r1, null, 'data.s2n 缺失应返回 null');

    const mock2 = {
      get: async () => ({ status: 200, data: { rc: 0, data: { s2n: ['9:30,-,-,-'] } } }),
    };
    const r2 = await ljgx.fetchNorthFundTrends({ axios: mock2 });
    assert.strictEqual(r2, null, '样本全部无效应返回 null');

    const mock3 = {
      get: async () => { throw new Error('ECONNRESET'); },
    };
    const r3 = await ljgx.fetchNorthFundTrends({ axios: mock3 });
    assert.strictEqual(r3, null, '网络异常应静默返回 null');
  });

  /**
   * 腾讯 hs/index 真实载荷形状（2026-11-04 实测，数值截短）：
   * 不存在 esllt_list，等价数组为 data.minute_set（对象值形态），
   * 条目 {code, pre, data: ["0930 价 量", ...]}，无 name/zdf 字段。
   */
  function qqIndexPayload() {
    return {
      code: 0,
      data: {
        now: '20261104105447',
        minute_set: {
          minute_sh_index: {
            code: 'sh000001',
            date: '20261104',
            pre: '3608.10',
            data: ['0930 3605.39 5145513', '0931 3648.10 22603113'],
          },
        },
      },
    };
  }

  it('大盘指数：正常载荷 → code/price 分时价解析，percent 由 pre 与最新价推导', async () => {
    const calls = [];
    const mock = {
      get: async (url, opts) => {
        calls.push({ url, opts });
        return { status: 200, data: qqIndexPayload() };
      },
    };

    const r = await ljgx.fetchIndexSpark({ axios: mock });

    assert.strictEqual(calls.length, 1, '应恰好请求一次');
    assert.ok(
      /proxy\.finance\.qq\.com\/cgi\/cgi-bin\/market\/hs\/index\?scenes=6$/.test(calls[0].url),
      `应请求腾讯 hs/index，实际 ${calls[0].url}`
    );
    assert.ok(String(calls[0].opts.headers['User-Agent'] || '').includes('Mozilla'), '带浏览器 UA');

    assert.ok(Array.isArray(r) && r.length === 1, '应解析出一条指数');
    const item = r[0];
    assert.strictEqual(item.code, 'sh000001');
    assert.strictEqual(item.name, '', '实测载荷无 name，容错为空串');
    assert.deepStrictEqual(item.price, [3605.39, 3648.1], '分时价的第二段');
    assert.strictEqual(
      item.percent,
      ((3648.1 - 3608.1) / 3608.1) * 100,
      'percent = (最新价 - 昨收) / 昨收 * 100'
    );
  });

  it('大盘指数：esllt_list 或等价数组整体缺失 → null 不抛', async () => {
    const mock1 = {
      get: async () => ({ status: 200, data: { code: 0, data: { now: '20261104105447' } } }),
    };
    const r1 = await ljgx.fetchIndexSpark({ axios: mock1 });
    assert.strictEqual(r1, null, 'esllt_list/minute_set 均缺失应返回 null');

    const mock2 = {
      get: async () => ({ status: 200, data: { code: 0, data: { minute_set: {} } } }),
    };
    const r2 = await ljgx.fetchIndexSpark({ axios: mock2 });
    assert.strictEqual(r2, null, '等价数组为空应返回 null');

    const mock3 = {
      get: async () => { throw new Error('timeout'); },
    };
    const r3 = await ljgx.fetchIndexSpark({ axios: mock3 });
    assert.strictEqual(r3, null, '网络异常应静默返回 null');
  });
});
