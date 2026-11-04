/**
 * 量化面板宿主测试桩：代替 out/webview/quantPanel 依赖的 ../shared/utils。
 * 只提供宿主实际用到的 getTemplateFileContent（模板内容由模板测试覆盖）。
 */
module.exports = {
  getTemplateFileContent() {
    return '<html><body>quant panel stub</body></html>';
  },
};
