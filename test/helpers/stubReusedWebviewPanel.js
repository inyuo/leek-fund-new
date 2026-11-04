/**
 * 量化面板宿主测试桩：代替 out/webview/ReusedWebviewPanel（经 Module._resolveFilename
 * 在 parent=quantPanel.js 时重定向进来）。暴露 default 形状（与编译产物的
 * ReusedWebviewPanel_1.default.create 兼容）与 created 表供测试断言。
 */
const created = [];

const disposeHandlers = [];

function fakePanel(viewType, title) {
  const pushed = [];
  const handlers = [];
  return {
    viewType,
    title,
    reveal() {},
    onDidDispose(fn) {
      disposeHandlers.push(fn);
    },
    webview: {
      html: '',
      pushed,
      handlers,
      onDidReceiveMessage(fn) {
        handlers.push(fn);
      },
      postMessage(msg) {
        pushed.push(msg);
        return Promise.resolve(true);
      },
      asWebviewUri(uri) {
        return uri;
      },
    },
    /** 宿主测试直接派发 webview 消息（模拟前端 postMessage） */
    fire(message) {
      for (const fn of handlers.slice()) fn(message);
    },
  };
}

function create(viewType, title, showOptions, options) {
  const panel = fakePanel(viewType, title);
  panel.showOptions = showOptions;
  panel.options = options;
  created.push(panel);
  return panel;
}

function reset() {
  created.length = 0;
  disposeHandlers.length = 0;
}

module.exports = { default: { create }, created, disposeHandlers, reset };
