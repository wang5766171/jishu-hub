/** 组合清单装载（需求13 C1）：Rust 扫描 toml → engine 装配 → 注册表合并。
 *  v0.9.3 需求25：@file: 混合插件在此装载代码组件（hybrid-runtime），
 *  指纹随 _files 透传实现热更；崩溃回调自动停用（plugin_set_enabled）。 */
import { invokeCommand } from "@/hooks/use-invoke";
import { buildComposedDescriptor } from "./engine";
import { loadHybridComponent, setHybridErrorHandler } from "./hybrid-runtime";
import type { SessionComposedManifest } from "../types";
import type { SessionPluginDescriptor } from "../../plugins/types";
import type { ComponentType } from "react";
import type { RendererComponentProps } from "../types";

/** Rust 扫描附带的目录元信息（attach_plugin_files 注入）。 */
interface ManifestDirMeta {
  _dir?: string;
  _files?: Record<string, string>;
  _file_error?: string;
}

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

/** 混合组件装载：@file: 引用 → 组件（失败返回 null 并告警跳过）。 */
async function resolveFileComponent(
  id: string,
  manifest: SessionComposedManifest & ManifestDirMeta,
): Promise<ComponentType<Record<string, unknown>> | null> {
  const rel = (manifest.render?.component ?? "").slice("@file:".length);
  if (manifest._file_error) {
    console.warn(`[composition] 跳过混合插件 ${id}: ${manifest._file_error}`);
    return null;
  }
  const dir = manifest._dir;
  const fingerprint = manifest._files?.[rel];
  if (!dir || !fingerprint) {
    console.warn(`[composition] 跳过混合插件 ${id}: 目录元信息缺失（_dir/_files）`);
    return null;
  }
  const component = await loadHybridComponent(id, dir, rel, fingerprint);
  if (component instanceof Error) {
    console.warn(`[composition] 混合插件 ${id} 代码装载失败:`, component.message);
    return null;
  }
  return component;
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
        const manifest = item.manifest as SessionComposedManifest & ManifestDirMeta;
        const isFileComponent = (manifest.render?.component ?? "").startsWith("@file:");
        // 临时诊断（需求25 P1 用户实测：插件中心可见但能力中心无面板）
        if (isFileComponent) {
          console.log("[hybrid-diag]", item.id, {
            component: manifest.render?.component,
            _dir: manifest._dir,
            _files: manifest._files,
            _file_error: manifest._file_error,
          });
        }
        if (isFileComponent) {
          const component = await resolveFileComponent(item.id, manifest);
          if (!component) continue;
          descriptors.push(buildComposedDescriptor(manifest, {
            component: component as unknown as ComponentType<RendererComponentProps>,
          }));
        } else {
          descriptors.push(buildComposedDescriptor(manifest));
        }
      } catch (err) {
        console.warn(`[composition] 跳过无效组合清单 ${item.id}:`, err);
      }
    }
    cache = descriptors;
    loaded = true;
    version += 1;
    // 临时诊断：装载完成后的缓存内容
    console.log("[composition-diag] cache:", descriptors.map(d => `${d.id}(${d.mounts.map(m => m.kind).join(",")})`));
    bump();
  } catch (err) {
    console.warn("[composition] composed_plugin_manifests failed:", err);
  }
}

// 崩溃隔离（需求25 P1）：混合组件渲染异常 → 自动停用该插件 + 热重建，
// 其余插件与会话界面不受影响。
setHybridErrorHandler((pluginId, error) => {
  console.warn(`[hybrid] 插件 ${pluginId} 渲染崩溃，已自动停用:`, error);
  void invokeCommand("plugin_set_enabled", { pluginId, enabled: false })
    .then(() => reloadComposed())
    .catch(() => undefined);
});

// 挂载即装载 + plugins-changed 热重建（启停/新建组合插件即时生效）。
void reloadComposed();
// .catch：非 Tauri 环境（vitest/jsdom 无 __TAURI_INTERNALS__）listen 同步抛错，
// 链尾兜底避免 unhandled rejection（生产 webview 内 listen 正常 resolve，行为不变）。
void import("@tauri-apps/api/event")
  .then(({ listen }) => listen("plugins-changed", () => void reloadComposed()))
  .catch(() => undefined);
