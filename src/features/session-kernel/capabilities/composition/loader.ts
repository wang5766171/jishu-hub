/** 组合清单装载（需求13 C1）：Rust 扫描 toml → engine 装配 → 注册表合并。
 *  v0.9.3 需求25：@file: 混合插件在此装载代码组件（hybrid-runtime），
 *  指纹随 _files 透传实现热更；崩溃回调自动停用（plugin_set_enabled）。 */
import { invokeCommand } from "@/hooks/use-invoke";
import { buildComposedDescriptor } from "./engine";
import { loadHybridComponent, setHybridErrorHandler } from "./hybrid-runtime";
import {
  clearHybridLoadErrorOnSuccess,
  reportHybridLoadError,
} from "./hybrid-errors";
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

/** 已自动回滚（disable）的混合插件 id——防止 plugins-changed 广播循环
 *  （失败 → disable → 广播 → 重载 → 再失败 → 再 disable → …）。 */
const autoDisabled = new Set<string>();

/** 混合插件装载失败统一处理：弹错误通知 + 回滚开关（首次失败时）。
 *  用户裁决：加载失败不能静默——要在启用时实时弹出错误，且因为失败
 *  使插件无法打开（开关自动弹回关闭态）。 */
async function onHybridLoadFailed(
  id: string,
  name: string,
  message: string,
): Promise<void> {
  console.warn(`[composition] 混合插件 ${id} 装载失败:`, message);
  reportHybridLoadError(id, name, message);
  // 首次失败 → 自动回滚开关（后续 reload 因已 disable 不再重复触发）。
  if (!autoDisabled.has(id)) {
    autoDisabled.add(id);
    try {
      await invokeCommand("plugin_set_enabled", { pluginId: id, enabled: false });
      console.info(`[composition] 混合插件 ${id} 装载失败，已自动回滚为停用`);
    } catch {
      // 回滚失败不阻塞（下次 reload 还会重试）
    }
  }
}

/** 混合组件装载：@file: 引用 → 组件。失败时写入 hybrid-errors 错误通知
 *  + 自动回滚开关（用户裁决），并返回 null 跳过该插件。 */
async function resolveFileComponent(
  id: string,
  manifest: SessionComposedManifest & ManifestDirMeta,
): Promise<ComponentType<Record<string, unknown>> | null> {
  const name = manifest.plugin?.name ?? id;
  const rel = (manifest.render?.component ?? "").slice("@file:".length);
  if (manifest._file_error) {
    await onHybridLoadFailed(id, name, manifest._file_error);
    return null;
  }
  const dir = manifest._dir;
  const fingerprint = manifest._files?.[rel];
  if (!dir || !fingerprint) {
    await onHybridLoadFailed(id, name, "插件目录元信息缺失（_dir/_files）——请检查目录结构");
    return null;
  }
  const component = await loadHybridComponent(id, dir, rel, fingerprint);
  if (component instanceof Error) {
    await onHybridLoadFailed(id, name, component.message);
    return null;
  }
  // 装载成功：清除旧错误通知 + 清除自动回滚标记（下次失败可再触发）。
  clearHybridLoadErrorOnSuccess(id);
  autoDisabled.delete(id);
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

    // 混合插件启用集（用户实测修复：禁用态的混合插件启动时也弹错误卡——
    // 禁用的不加载代码，只有启用态才尝试，失败时才弹卡+回滚）。
    let enabledIds: Set<string> | null = null;
    const hasHybrid = items.some(
      (item) => (item.manifest.render?.component ?? "").startsWith("@file:"),
    );
    if (hasHybrid) {
      try {
        const list = await invokeCommand<{ plugins: Array<{ id: string; kind: string; enabled: boolean }> }>("plugin_list");
        enabledIds = new Set(
          (list.plugins ?? []).filter((p) => p.kind === "session" && p.enabled).map((p) => p.id),
        );
      } catch {
        enabledIds = null; // 查不到就不做门控（宁可多试也不漏装）
      }
    }

    const descriptors: SessionPluginDescriptor[] = [];
    for (const item of items ?? []) {
      try {
        const manifest = item.manifest as SessionComposedManifest & ManifestDirMeta;
        const isFileComponent = (manifest.render?.component ?? "").startsWith("@file:");
        if (isFileComponent) {
          // 禁用态的混合插件跳过代码装载（不弹错误卡——用户没启用就不该被
          // 打扰；启用态才尝试加载，失败时弹卡+自动回滚开关）。
          if (enabledIds && !enabledIds.has(item.id)) {
            continue;
          }
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
