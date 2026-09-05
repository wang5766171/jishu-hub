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

window.onerror = function(msg, url, line, col, error) {
  if (isBenignResizeObserverLoop(msg)) return;
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
