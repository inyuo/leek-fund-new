/**
 * 伪 DOM 运行时：在 Node 里执行 template/*.html 的内联 <script>，
 * 用于资金动态窗口这类**纯字符串拼接渲染**的行为测试。
 *
 * 不引 jsdom（新增依赖与打包体积不成比例）——模板只用到
 * getElementById / addEventListener / querySelectorAll / style 这类最小 API，
 * 用轻量桩即可，测试直接断言元素的 innerHTML/textContent。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** 一个可被模板脚本读写的元素桩 */
function makeElement(id) {
  return {
    id,
    textContent: '',
    innerHTML: '',
    className: '',
    style: {},
    disabled: false,
    offsetWidth: 0,
    offsetHeight: 0,
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    setAttribute() {},
    getAttribute() {
      return null;
    },
    // 模板渲染后给行绑定 click：桩返回空数组即跳过绑定
    querySelectorAll() {
      return [];
    },
    getBoundingClientRect() {
      return { width: 800, height: 300, left: 0, top: 0 };
    },
  };
}

/**
 * 读取模板 HTML，抽取内联 script 在 vm 沙箱里执行。
 * 返回元素表、postMessage 记录与 window 事件派发器。
 */
function loadTemplate(templateName) {
  const tplPath = path.join(__dirname, '..', '..', 'template', templateName);
  const html = fs.readFileSync(tplPath, 'utf8');
  const matched = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!matched) throw new Error(`模板 ${templateName} 没有内联 script`);

  const elements = {};
  const posted = [];
  const windowListeners = {};

  const documentStub = {
    getElementById(id) {
      if (!elements[id]) elements[id] = makeElement(id);
      return elements[id];
    },
    querySelectorAll() {
      return [];
    },
    documentElement: makeElement('html'),
  };

  const windowStub = {
    devicePixelRatio: 1,
    addEventListener(type, fn) {
      (windowListeners[type] = windowListeners[type] || []).push(fn);
    },
  };

  const vscodeStub = {
    getState: () => ({}),
    setState: () => {},
    postMessage: (msg) => posted.push(msg),
  };

  const sandbox = {
    window: windowStub,
    document: documentStub,
    acquireVsCodeApi: () => vscodeStub,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    setTimeout,
    clearTimeout,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(matched[1], sandbox, { filename: templateName });

  return {
    elements,
    posted,
    /** 派发 window message 事件（模拟扩展端 postMessage） */
    fire(type, event) {
      (windowListeners[type] || []).forEach((fn) => fn(event));
    },
    el(id) {
      if (!elements[id]) elements[id] = makeElement(id);
      return elements[id];
    },
  };
}

module.exports = { loadTemplate, makeElement };
