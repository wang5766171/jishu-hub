import type { SessionSignal } from "./plugins/types";

/**
 * 会话内核信号总线（v0.9.2 需求1 M4：event-hook 挂载点的数据面）。
 * 内核（chat-page 事件监听）产生信号，插件经 EventHookMount.onSignal 消费
 * （桌面通知等）。无 React 依赖的纯发布订阅，避免为信号重渲染。
 */
type Listener = (signal: SessionSignal) => void;

const listeners = new Set<Listener>();

export function emitSessionSignal(signal: SessionSignal): void {
  for (const listener of listeners) {
    try {
      listener(signal);
    } catch (error) {
      console.warn("session signal listener failed:", error);
    }
  }
}

export function subscribeSessionSignals(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
