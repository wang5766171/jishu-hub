/**
 * 插件配置面（v0.9.3 需求12 P1：配置驱动的插件体系——基座）。
 *
 * 模型：插件 = 挂载实现 × configSchema 声明（参数：类型/默认值/约束）
 * × 用户配置值（~/.jishu-hub/plugins-config.json，Rust plugin_config_* 命令
 * 读写）× 状态（启停/布局——既有）。
 *
 * 运行时：模块级缓存（全量 map）+ `plugins-config-changed` 事件失效重拉 +
 * useSyncExternalStore 订阅——配置保存后**热生效**（组件即时重渲染 / 事件
 * 驱动消费者下次读取新快照）。组件纪律：不出现魔法数字，一律经
 * usePluginConfig（React）/ getPluginConfig（非 React）取值。
 */
import { useSyncExternalStore } from "react";
import { invokeCommand } from "@/hooks/use-invoke";

// ── 类型系统（02 §关键设计：扁平值形状，section 仅表单分组）──

export type PluginConfigValue = boolean | number | string;

export interface PluginConfigFieldBase {
  key: string;
  label: string;
  description?: string;
}

export type PluginConfigField =
  | (PluginConfigFieldBase & { type: "switch"; default: boolean })
  | (PluginConfigFieldBase & {
      type: "number";
      default: number;
      min?: number;
      max?: number;
      step?: number;
      unit?: string;
    })
  | (PluginConfigFieldBase & {
      type: "select";
      default: string;
      options: Array<{ value: string; label: string }>;
    })
  | (PluginConfigFieldBase & {
      type: "text";
      default: string;
      placeholder?: string;
      maxLength?: number;
    })
  | (PluginConfigFieldBase & { type: "textarea"; default: string; rows?: number })
  | (PluginConfigFieldBase & { type: "shortcut"; default: string })
  | (PluginConfigFieldBase & { type: "section"; label: string; fields: PluginConfigField[] });

export type PluginConfigValues = Record<string, PluginConfigValue>;

// ── 存储与订阅 ──

/** 全量缓存：pluginId → 用户显式改过的键值（未改键不在此，走 default）。 */
type AllPluginConfigs = Record<string, PluginConfigValues>;

let cache: AllPluginConfigs | null = null;
let loadPromise: Promise<AllPluginConfigs> | null = null;
const listeners = new Set<() => void>();
let unlistenStarted = false;

function ensureListening(): void {
  if (unlistenStarted || typeof window === "undefined") return;
  unlistenStarted = true;
  void import("@tauri-apps/api/event").then(({ listen }) =>
    listen<{ pluginId?: string }>("plugins-config-changed", () => {
      // 保存端（本进程）已先更新缓存；此事件兜底跨窗口/异常路径——统一失效重拉。
      cache = null;
      loadPromise = null;
      for (const fn of listeners) fn();
    }),
  );
}

async function loadAll(): Promise<AllPluginConfigs> {
  ensureListening();
  if (cache) return cache;
  if (!loadPromise) {
    loadPromise = invokeCommand<AllPluginConfigs>("plugin_config_get_all")
      .then((result) => {
        cache = result ?? {};
        return cache;
      })
      .catch((err) => {
        console.warn("plugin_config_get_all failed, using defaults:", err);
        cache = {};
        return cache;
      })
      .finally(() => {
        loadPromise = null;
      });
  }
  return loadPromise;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  void loadAll();
  return () => listeners.delete(cb);
}

function snapshot(): AllPluginConfigs {
  return cache ?? EMPTY;
}

/** 首载完成通知（subscribe 内调用：缓存就绪即重渲染一次）。 */
function bump(): void {
  for (const fn of listeners) fn();
}
const EMPTY: AllPluginConfigs = {};

/** 拉取/合并插件配置（defaults ⨯ 用户值）；空 schema 直接回 defaults。 */
export function mergeConfig(
  schema: PluginConfigField[],
  user: PluginConfigValues | undefined,
): PluginConfigValues {
  const out: PluginConfigValues = {};
  const flat = flattenSchema(schema);
  for (const field of flat) {
    const value = user?.[field.key];
    out[field.key] = value === undefined ? field.default : value;
  }
  return out;
}

/** section 展平（值形状扁平，分组仅表单语义）。 */
export function flattenSchema(schema: PluginConfigField[]): Array<Exclude<PluginConfigField, { type: "section" }>> {
  const out: Array<Exclude<PluginConfigField, { type: "section" }>> = [];
  for (const field of schema) {
    if (field.type === "section") {
      out.push(...flattenSchema(field.fields));
    } else {
      out.push(field);
    }
  }
  return out;
}

/** 类型化取值（值形状宽松，消费侧按需收窄；非法/缺失回 default）。 */
export function cfgNum(values: PluginConfigValues, key: string, fallback: number): number {
  const v = values[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function cfgBool(values: PluginConfigValues, key: string, fallback: boolean): boolean {
  const v = values[key];
  return typeof v === "boolean" ? v : fallback;
}

/** React 组件消费：配置热生效（保存 → 重渲染）。 */
export function usePluginConfig(
  pluginId: string,
  schema: PluginConfigField[],
): { values: PluginConfigValues; ready: boolean } {
  const all = useSyncExternalStore(subscribe, snapshot);
  const user = all[pluginId];
  const values = mergeConfig(schema, user);
  return { values, ready: cache != null };
}

/** 非 React 消费者（event-hook 等）同步快照——缓存未就绪时回 defaults。 */
export function getPluginConfig(pluginId: string, schema: PluginConfigField[]): PluginConfigValues {
  return mergeConfig(schema, cache?.[pluginId]);
}

/** 校验 + 只留与 default 的差异键（存储语义：显式改动才落盘）。 */
export function diffAgainstDefaults(
  schema: PluginConfigField[],
  values: PluginConfigValues,
): PluginConfigValues {
  const diff: PluginConfigValues = {};
  for (const field of flattenSchema(schema)) {
    const value = values[field.key];
    if (value === undefined) continue;
    if (field.type === "number") {
      const num = Number(value);
      if (Number.isNaN(num)) continue;
      const clamped = Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, num));
      if (clamped !== field.default) diff[field.key] = clamped;
      continue;
    }
    if (value !== field.default) diff[field.key] = value;
  }
  return diff;
}

/** 保存（组内全量 diff 替换）+ 本进程缓存即时更新（热生效）。 */
export async function setPluginConfig(
  pluginId: string,
  schema: PluginConfigField[],
  values: PluginConfigValues,
): Promise<void> {
  const diff = diffAgainstDefaults(schema, values);
  await invokeCommand("plugin_config_set", { pluginId, values: diff });
  // Rust 侧也会广播 plugins-config-changed；本进程先行更新缓存让 UI 即时反馈
  //（事件到达时会整体失效重拉，双路径收敛一致）。
  cache = cache ? { ...cache, [pluginId]: diff } : { [pluginId]: diff };
  bump();
}
