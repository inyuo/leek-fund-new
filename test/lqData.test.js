/**
 * 量价掘金「策略选股」数据层测试（lqData）。
 *
 * 官网 9 类策略共用 POST /shares.get_lq {tag, days}，需登录（无 token 返回 1018）。
 * 这里用内存 store + 注入的 axios 假对象验证：元数据、载荷归一化、请求契约与降级。
 */
const assert = require('assert');
const { LQ_TAGS, LQ_DAYS, toAShareCode, normalizeLqGroups, fetchLqList } = require('../out/shared/lqData');

const SESSION_KEY = 'leek-fund.ljgxSession';

function memStore(session) {
  const m = new Map();
  if (session) m.set(SESSION_KEY, session);
  return {
    get: (key) => m.get(key),
    update: (key, value) => {
      m.set(key, value);
      return Promise.resolve();
    },
    _m: m,
  };
}

const SESSION = {
  sessionId: 'wx_sess_abc',
  openId: 'oX8s1',
  overdueTime: 1762249200,
  userName: '股海浮沉',
  avatarUrl: '',
  did: 'LEEK_k3x9p2_ab12cd',
};

/** 成功响应包装（与官网 {state,error,data} 一致） */
function ok(data) {
  return { status: 200, data: { state: true, error: 'normal', data } };
}

describe('策略元数据 LQ_TAGS / LQ_DAYS', () => {
  it('9 类策略 tag 与顺序与官网 lq 参数一致', () => {
    assert.deepStrictEqual(
      LQ_TAGS.map((t) => t.tag),
      ['cd', 'qs', 'dwfl', 'szx', 'ztb', 'cx', 'hy', 'jzc', 'fk']
    );
    assert.deepStrictEqual(
      LQ_TAGS.map((t) => t.label),
      ['超跌', '趋势', '低位', '十字星', '涨停', '次新股', '板块', '净增持', '风口']
    );
  });

  it('天数 8 档为官网 dayChoice 的取值', () => {
    assert.deepStrictEqual(
      LQ_DAYS.map((d) => d.num),
      [1, 3, 5, 10, 20, 30, 60, 100]
    );
  });
});

describe('策略载荷归一化 normalizeLqGroups', () => {
  it('两级分组归一为 groups/rows，保留行业与特色标签', () => {
    const result = normalizeLqGroups({
      list: [
        {
          title: '2026-11-04',
          list: [
            { code: '300750', name: '宁德时代', percent: 5.95, desc: '放量突破' },
            { code: '300274', name: '阳光电源', zdf: -1.2, msg: '回踩均线' },
          ],
        },
      ],
      hyTags: ['半导体', '新能源'],
      tsTags: [{ doc: '龙虎榜', url: '/pages/lhb/lhb' }],
    });

    assert.strictEqual(result.groups.length, 1);
    assert.strictEqual(result.groups[0].title, '2026-11-04');
    assert.deepStrictEqual(result.groups[0].rows, [
      { code: 'sz300750', name: '宁德时代', percent: 5.95, note: '放量突破' },
      { code: 'sz300274', name: '阳光电源', percent: -1.2, note: '回踩均线' },
    ]);
    assert.deepStrictEqual(result.hyTags, ['半导体', '新能源']);
    assert.deepStrictEqual(result.tsTags, [{ doc: '龙虎榜', url: '/pages/lhb/lhb' }]);
  });

  it('脏数据容错：分组无 list、行缺 code、非数组标签一律跳过', () => {
    const result = normalizeLqGroups({
      list: [
        { title: '空组' },
        { name: '无标题组', list: [{ name: '缺代码' }, { code: '000001' }] },
        null,
      ],
      hyTags: 'bad',
      tsTags: [null, { doc: '有效' }],
    });

    assert.strictEqual(result.groups.length, 1, '只保留含有效行的分组');
    assert.strictEqual(result.groups[0].title, '无标题组');
    assert.deepStrictEqual(result.groups[0].rows, [
      { code: 'sz000001', name: '', percent: null, note: '' },
    ]);
    assert.deepStrictEqual(result.hyTags, []);
    assert.deepStrictEqual(result.tsTags, [{ doc: '有效', url: '' }]);
  });

  it('空/异常输入返回空结构不抛错', () => {
    for (const bad of [null, undefined, {}, 'bad', { list: 'bad' }]) {
      assert.deepStrictEqual(normalizeLqGroups(bad), {
        groups: [],
        hyTags: [],
        tsTags: [],
      });
    }
  });

  // 缺陷回归：官网 get_lq 行 code 是裸 6 位，资金动态面板只认 sh/sz+6位，
  // 不补前缀则 initialCode 匹配不到下拉项、详情校验失败（表现为「没有选中的股票」）
  it('裸 6 位 code 归一为 sh/sz 前缀（3/0 起→sz，6/5 起→sh）', () => {
    assert.strictEqual(toAShareCode('300750'), 'sz300750');
    assert.strictEqual(toAShareCode('000001'), 'sz000001');
    assert.strictEqual(toAShareCode('600519'), 'sh600519');
    assert.strictEqual(toAShareCode('510300'), 'sh510300');
  });

  it('已带前缀/非 A 股代码原样透传；归一化后 data-code 即可被资金动态识别', () => {
    assert.strictEqual(toAShareCode('sh600519'), 'sh600519');
    assert.strictEqual(toAShareCode('hk00700'), 'hk00700');
    assert.strictEqual(toAShareCode('bad'), 'bad');
    assert.strictEqual(toAShareCode(''), '');
    assert.strictEqual(toAShareCode(undefined), '');

    const result = normalizeLqGroups({
      list: [{ title: 'g', list: [{ code: '600519', name: '贵州茅台' }] }],
    });
    assert.strictEqual(result.groups[0].rows[0].code, 'sh600519');
  });
});

describe('策略榜单拉取 fetchLqList', () => {
  it('带 user-token 请求 /shares.get_lq，body 为 {tag, days}，返回归一化结果', async () => {
    let captured = null;
    const axios = {
      post: async (url, body, config) => {
        captured = { url, body, config };
        return ok({
          list: [{ title: '涨停板', list: [{ code: '000001', name: '平安银行' }] }],
        });
      },
    };

    const result = await fetchLqList('ztb', 3, { store: memStore(SESSION), axios });
    assert.ok(captured, '应发出请求');
    assert.ok(captured.url.endsWith('/shares.get_lq'), `实际路径 ${captured.url}`);
    assert.deepStrictEqual(captured.body, { tag: 'ztb', days: 3 });
    assert.strictEqual(captured.config.headers['user-token'], 'wx_sess_abc');
    assert.strictEqual(result.groups[0].rows[0].name, '平安银行');
  });

  it('未登录不发请求，返回 null', async () => {
    let calls = 0;
    const result = await fetchLqList('cd', 1, {
      store: memStore(null),
      axios: { post: async () => { calls += 1; return ok({ list: [] }); } },
    });
    assert.strictEqual(result, null);
    assert.strictEqual(calls, 0);
  });

  it('1018 会话失效 → 清库并返回 null', async () => {
    const store = memStore(SESSION);
    const result = await fetchLqList('cd', 1, {
      store,
      axios: { post: async () => ({ status: 200, data: { state: false, code: 1018 } }) },
    });
    assert.strictEqual(result, null);
    assert.strictEqual(store._m.get(SESSION_KEY), undefined, '应清除会话');
  });

  it('网络异常 / 业务失败返回 null 不抛错', async () => {
    const store = memStore(SESSION);
    const boom = await fetchLqList('cd', 1, {
      store,
      axios: { post: async () => { throw new Error('boom'); } },
    });
    const bad = await fetchLqList('cd', 1, {
      store,
      axios: { post: async () => ({ status: 200, data: { state: false, code: 1001 } }) },
    });
    assert.strictEqual(boom, null);
    assert.strictEqual(bad, null);
  });
});
