/**
 * html-preview-store —— agent 主动预览事件的前端落点（v0.9.2 测试期）。
 *
 * 后端 plugin_preview_html（扩展 preview_html 工具经 hub_invoke 桥调用）校验
 * 文件后广播 `session-plugin-preview` 事件；本模块在加载时注册监听（registry
 * import 本文件，随应用启动常驻——停靠面板组件卸载不丢事件），把文件路径
 * 存入模块级 store 并派发 window CustomEvent 请求展开对应停靠面板（宿主
 * SessionPanelLayer 监听）。
 *
 * 设计取舍：不用 ctx 声明制订阅——事件到达时面板可能未挂载（无组件在听），
 * 监听必须活在组件生命周期之外。
 */
import { listen } from "@tauri-apps/api/event";

export interface HtmlPreviewState {
  file: string | null;
  sessionId: string | null;
  /** 自增版本号：同一文件再次预览（agent 修改后刷新）也驱动重载。 */
  version: number;
}

export const HTML_PREVIEW_PLUGIN_ID = "session.html-preview";
/** 面板宿主监听的展开请求事件名（detail.pluginId）。 */
export const SHOW_SESSION_PANEL_EVENT = "jishu:show-session-panel";

let state: HtmlPreviewState = { file: null, sessionId: null, version: 0 };
const listeners = new Set<() => void>();

function setPreview(file: string, sessionId: string | null): void {
  state = { file, sessionId, version: state.version + 1 };
  for (const fn of listeners) fn();
  window.dispatchEvent(
    new CustomEvent(SHOW_SESSION_PANEL_EVENT, { detail: { pluginId: HTML_PREVIEW_PLUGIN_ID } }),
  );
}

export function subscribeHtmlPreview(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getHtmlPreviewSnapshot(): HtmlPreviewState {
  return state;
}

let listening = false;
/** 幂等注册 Tauri 事件监听（应用启动时由模块加载触发）。非 Tauri 环境
 *（vitest/jsdom 无 __TAURI_INTERNALS__）跳过，避免 IPC 调用产生未处理拒绝；
 * 注册失败重置标记，下次 import 链触发时可重试。 */
export function ensureHtmlPreviewListener(): void {
  if (listening) return;
  if (typeof window === "undefined" || !(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    return;
  }
  listening = true;
  void listen<{ file: string; session_id?: string }>("session-plugin-preview", (event) => {
    const file = event.payload?.file;
    if (typeof file === "string" && file) {
      setPreview(file, event.payload?.session_id ?? null);
    }
  }).catch(() => {
    listening = false;
  });
}

ensureHtmlPreviewListener();
