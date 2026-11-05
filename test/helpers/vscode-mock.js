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

/** 与 vscode ViewColumn 同形（面板宿主测试只用到 One） */
const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 };

/** 记录宿主转发的命令（策略选股行「资金动态」） */
const commandCalls = [];
const commands = {
  executeCommand(name, ...args) {
    commandCalls.push({ name, args });
    return Promise.resolve();
  },
};

module.exports = {
  TreeItem,
  EventEmitter,
  ThemeIcon,
  Uri,
  TreeItemCollapsibleState,
  ViewColumn,
  commands,
  commandCalls,
};
