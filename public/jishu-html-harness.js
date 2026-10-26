/**
 * jishu-html-harness.js —— HTML 渲染插件（session.html-render）的 iframe
 * 运行脚本（v0.9.3 测试期：CSP 适配）。
 *
 * 为何外置：srcDoc iframe 继承应用主 CSP（script-src 'self'，无 'unsafe-inline'），
 * 此前内联注入的测量脚本在生产包被 CSP 静默拦截 → 高度上报失效 → 卡片停在
 * 240px 兜底出滚动条（dev 无 CSP 所以表现正常）。外置为同源静态资源后
 * 'self' 放行，dev（vite）/生产（tauri origin）全平台一致。
 *
 * 职责：① 高度上报（load/resize/ResizeObserver，postMessage——sandbox 无
 * allow-same-origin，opaque origin 下与父窗口唯一可信通道）；② ESC 转发
 *（焦点进 iframe 后父窗口 keydown 收不到按键，放大层会关不掉）。
 * 消息协议（父侧 html-render.tsx 消费，event.source 校验来源）：
 *   { type: "jishu-html-height", height: number }
 *   { type: "jishu-html-esc" }
 */
(function () {
  "use strict";
  function report() {
    var h = Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0
    );
    parent.postMessage({ type: "jishu-html-height", height: h }, "*");
  }
  if (document.readyState === "complete") {
    report();
  } else {
    window.addEventListener("load", report);
  }
  window.addEventListener("resize", report);
  if (window.ResizeObserver && document.documentElement) {
    new ResizeObserver(report).observe(document.documentElement);
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      parent.postMessage({ type: "jishu-html-esc" }, "*");
    }
  });
})();
