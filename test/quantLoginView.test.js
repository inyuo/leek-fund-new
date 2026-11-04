/**
 * 微信扫码登录面板模板行为测试（伪 DOM 执行内联 script）：
 * 1) qrcode 消息 → 二维码 img src 更新、状态文案变化
 * 2) success 消息 → 显示昵称与有效期
 * 3) 未收到任何消息 → 显示占位提示
 *
 * 同 stockFundFlowView.test.js：模板是纯字符串拼接渲染，轻量桩即可断言。
 */
const assert = require('assert');
const { loadTemplate } = require('./helpers/webview-dom');

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

describe('微信扫码登录模板 quant-login.html', () => {
  it('qrcode 消息 → 二维码 img src 更新、状态文案变化', () => {
    const page = loadTemplate('quant-login.html');
    page.fire('message', {
      data: { type: 'qrcode', data: { url: 'https://www.xxjwxc.cn/qr/abc123.png' } },
    });

    assert.strictEqual(
      page.el('qrImg').src,
      'https://www.xxjwxc.cn/qr/abc123.png',
      '二维码图片地址应更新到 img.src'
    );
    assert.strictEqual(page.el('qrBox').style.display, 'flex', '收到二维码后应展示扫码区');
    assert.ok(
      page.el('status').textContent.indexOf('微信') !== -1,
      `状态文案应提示扫码，实际：${page.el('status').textContent}`
    );
  });

  it('success 消息 → 显示昵称与有效期', () => {
    const page = loadTemplate('quant-login.html');
    const overdue = 1762249200;
    page.fire('message', {
      data: {
        type: 'success',
        data: {
          sessionId: 'wx_sess_abc',
          userName: '股海浮沉',
          avatarUrl: 'https://thirdwx.qlogo.cn/mmopen/vi_32/sample.png',
          overdueTime: overdue,
        },
      },
    });

    assert.strictEqual(page.el('nick').textContent, '股海浮沉', '应显示微信昵称');
    const d = new Date(overdue * 1000);
    const expected = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
      d.getHours()
    )}:${pad2(d.getMinutes())}`;
    assert.strictEqual(
      page.el('expire').textContent,
      `登录有效期至 ${expected}`,
      '应显示登录有效期（unix 秒 → yyyy-MM-dd HH:mm）'
    );
    assert.strictEqual(page.el('qrBox').style.display, 'none', '成功后应隐藏扫码区');
    assert.strictEqual(page.el('successBox').style.display, 'flex', '成功后应展示登录态');
  });

  it('未收到任何消息 → 显示占位提示', () => {
    const page = loadTemplate('quant-login.html');

    const status = page.el('status').textContent;
    assert.ok(status.trim(), `应显示占位提示文案，实际为空`);
    assert.ok(
      status.indexOf('二维码') !== -1,
      `占位提示应说明正在准备二维码，实际：${status}`
    );
    assert.strictEqual(page.el('qrBox').style.display, 'none', '未收到消息不应展示扫码区');
    assert.strictEqual(page.el('successBox').style.display, 'none', '未收到消息不应展示登录态');
    // 模板脚本应已自报 ready（扩展端据此下发 did/url）
    assert.strictEqual(
      page.posted.some((m) => m.command === 'ready'),
      true,
      '模板加载后应主动 postMessage ready'
    );
  });
});
