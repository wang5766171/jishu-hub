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
    var body = document.body;
    var root = document.documentElement;
    // 内容高取 body.scrollHeight 与 html 布局高较大者；**不用**
    // documentElement.scrollHeight——根元素滚动区=视口，会被当前 iframe 视口
    // 高兜底（内容矮于视口时测量值恒=视口高，iframe 高度只涨不缩，起始 240
    // 会把内容钉死在 240）。html 的 getBoundingClientRect().height 无视口
    // 兜底（height:auto=内容高）；vh/百分比布局（html/body 100%）则天然
    // =视口高——矮内容能缩、满幅内容能撑，两类都测准。
    var h = Math.max(
      body ? body.scrollHeight : 0,
      root ? root.getBoundingClientRect().height : 0
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
