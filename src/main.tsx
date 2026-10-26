import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app";
import "./index.css";
import "@/i18n";

const params = new URLSearchParams(window.location.search);
const isFloating = params.has("floating");

// v0.9.1 需求4：ResizeObserver 回环提示是浏览器对「帧内仍有待送达通知」的
// 良性报告（通知下一帧照常送达，非异常）——尺寸观察类组件（chat-input 高度
// 等比伸缩等）在窗口快速缩放/最大化时可能触发一次，不应炸掉整页错误视图。
const isBenignResizeObserverLoop = (msg: unknown): boolean =>
  typeof msg === "string" && msg.includes("ResizeObserver loop");

// ── 全局错误处理器的层级设计（用户裁决：全局处理器是兜底，优先级低于
//    具体子系统处理器）──
//
// 具体子系统（混合插件运行时等）在注入外部脚本期间"认领"错误——打开抑制
// 窗口 → 全局处理器看到窗口开着就跳过（具体处理器已优雅处理：插件跳过/
// 控制台 warn/ErrorBoundary 拦截）→ 窗口关闭后全局处理器恢复兜底。
// 这不是过滤特定模式（脆弱），而是尊重具体处理器的优先权。

import { isSuppressed } from "@/lib/error-suppression";

window.onerror = function(msg, url, line, col, error) {
  if (isBenignResizeObserverLoop(msg)) return;
  if (isSuppressed()) return; // 具体子系统已认领，全局处理器让路（兜底不越权）
  document.body.innerHTML = `
    <div style="color: red; padding: 20px; font-family: monospace;">
      <h3>Frontend Error</h3>
      <p><b>Message:</b> ${msg}</p>
      <p><b>URL:</b> ${url}</p>
      <p><b>Line:</b> ${line}:${col}</p>
      <pre>${error?.stack || ''}</pre>
    </div>
  `;
};

window.addEventListener("unhandledrejection", function(event) {
  if (isBenignResizeObserverLoop(event.reason)) {
    event.preventDefault();
    return;
  }
  document.body.innerHTML = `
    <div style="color: red; padding: 20px; font-family: monospace;">
      <h3>Unhandled Promise Rejection</h3>
      <p><b>Reason:</b> ${event.reason}</p>
      <pre>${event.reason?.stack || ''}</pre>
    </div>
  `;
});

if (isFloating) {
  // Lazy load floating view to keep main bundle small
  import("./components/sessions/floating-session").then(({ FloatingSessionView }) => {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <FloatingSessionView />
      </React.StrictMode>,
    );
  });
} else {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
