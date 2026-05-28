import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "@/i18n";

const params = new URLSearchParams(window.location.search);
const isFloating = params.has("floating");

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
