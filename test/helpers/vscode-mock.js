/**
 * 测试环境没有 vscode 运行时，这里提供被测代码实际用到的最小实现。
 * 仅供单测注入，不参与打包（.vscodeignore 已排除 test/**）。
 */
class TreeItem {
  constructor(label) {
    this.label = label;
  }
}

/** 与 vscode TreeItemCollapsibleState 同形（None=0, Collapsed=1, Expanded=2） */
const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

class EventEmitter {
  constructor() {
    this._listeners = [];
  }
  get event() {
    return (fn) => {
      this._listeners.push(fn);
      return { dispose: () => {} };
    };
  }
  fire(e) {
    this._listeners.forEach((fn) => fn(e));
  }
}

class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}

class Uri {
  constructor(value) {
    this.fsPath = value;
  }
  static parse(value) {
    return new Uri(value);
  }
  toString() {
    return this.fsPath;
  }
}

module.exports = { TreeItem, EventEmitter, ThemeIcon, Uri, TreeItemCollapsibleState };
