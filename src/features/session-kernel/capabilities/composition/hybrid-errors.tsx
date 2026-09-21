/**
 * 混合插件装载错误通知（需求25 用户反馈：插件加载失败不应静默——
 * 至少弹错误提示让用户知道为什么插件没出现；后续接"去编辑"按钮）。
 *
 * 数据面：模块级 store（与 artifacts 预览状态同模式），loader 写入
 * 装载失败的插件 id+错误信息，本组件读取并渲染可关闭的错误卡。
 */
import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, X } from "lucide-react";

export interface HybridLoadError {
  /** 插件 id。 */
  pluginId: string;
  /** 显示名（manifest name）。 */
  name: string;
  /** 具体错误信息（装载失败原因）。 */
  message: string;
  /** 时间戳。 */
  at: number;
}

// ── 模块级 store ──

let errors: HybridLoadError[] = [];
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): HybridLoadError[] {
  return errors;
}

function notify(): void {
  for (const fn of listeners) fn();
}

/** loader 调用：记录一条混合插件装载失败。 */
export function reportHybridLoadError(pluginId: string, name: string, message: string): void {
  // 同插件旧错误替换（避免重复弹卡）。
  errors = errors.filter((e) => e.pluginId !== pluginId);
  errors = [...errors, { pluginId, name, message, at: Date.now() }];
  notify();
}

/** 用户关闭或插件修复重载成功时清除。 */
export function clearHybridLoadError(pluginId: string): void {
  errors = errors.filter((e) => e.pluginId !== pluginId);
  notify();
}

/** 装载成功时清除旧错误（loader 在成功路径也调用）。 */
export function clearHybridLoadErrorOnSuccess(pluginId: string): void {
  if (errors.some((e) => e.pluginId === pluginId)) {
    clearHybridLoadError(pluginId);
  }
}

// ── UI 组件 ──

export function HybridErrorNotification() {
  const errors = useSyncExternalStore(subscribe, getSnapshot, () => [] as HybridLoadError[]);
  if (errors.length === 0) return null;

  return createPortal(
    <div className="fixed bottom-4 right-4 z-[75] flex max-w-[420px] flex-col gap-2">
      {errors.map((err) => (
        <div
          key={err.pluginId}
          className="rounded-xl border border-red-500/40 bg-background p-4 shadow-xl"
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground">
                插件「{err.name}」加载失败
              </div>
              <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {err.message}
              </div>
              <div className="mt-2 font-mono text-[10px] text-muted-foreground/50">
                {err.pluginId}
              </div>
            </div>
            <button
              type="button"
              onClick={() => clearHybridLoadError(err.pluginId)}
              className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="关闭"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>,
    document.body,
  );
}
