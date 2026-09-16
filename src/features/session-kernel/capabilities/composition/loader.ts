/** 组合清单装载（需求13 C1）：Rust 扫描 toml → engine 装配 → 注册表合并。 */
import { invokeCommand } from "@/hooks/use-invoke";
import { buildComposedDescriptor } from "./engine";
import type { SessionComposedManifest } from "../types";
import type { SessionPluginDescriptor } from "../../plugins/types";

let cache: SessionPluginDescriptor[] = [];
let loaded = false;
/** 版本快照（useSyncExternalStore 用）：每次装载完成自增，消费方据此重渲染。 */
let version = 0;
const listeners = new Set<() => void>();

export function composedPlugins(): SessionPluginDescriptor[] {
  return cache;
}

export function composedReady(): boolean {
  return loaded;
}

export function subscribeComposed(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function composedVersion(): number {
  return version;
}

function bump(): void {
  for (const fn of listeners) fn();
}

export async function reloadComposed(): Promise<void> {
  try {
    const raw = await invokeCommand<unknown>("composed_plugin_manifests");
    // 形状防御：新契约 [{id, manifest}]；历史元组形状 [id, manifest] 兼容。
    const items = ((Array.isArray(raw) ? raw : []) as Array<unknown>).map((item) => {
      if (Array.isArray(item) && item.length === 2) {
        return { id: String(item[0]), manifest: item[1] as SessionComposedManifest };
      }
      return item as { id: string; manifest: SessionComposedManifest };
    });
    const descriptors: SessionPluginDescriptor[] = [];
    for (const item of items ?? []) {
      try {
        descriptors.push(buildComposedDescriptor(item.manifest));
      } catch (err) {
        console.warn(`[composition] 跳过无效组合清单 ${item.id}:`, err);
      }
    }
    cache = descriptors;
    loaded = true;
    version += 1;
    bump();
  } catch (err) {
    console.warn("[composition] composed_plugin_manifests failed:", err);
  }
}

// 挂载即装载 + plugins-changed 热重建（启停/新建组合插件即时生效）。
void reloadComposed();
void import("@tauri-apps/api/event").then(({ listen }) =>
  listen("plugins-changed", () => void reloadComposed()),
);
