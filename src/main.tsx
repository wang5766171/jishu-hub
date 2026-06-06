import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "@/i18n";

const params = new URLSearchParams(window.location.search);
const isFloating = params.has("floating");

window.onerror = function(msg, url, line, col, error) {
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
