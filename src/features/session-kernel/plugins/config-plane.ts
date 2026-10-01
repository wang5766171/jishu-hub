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
import { useMemo, useSyncExternalStore } from "react";
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

/** 测试口：直写配置缓存（vitest 语境无 Tauri 后端）。pluginId 可指定
 *  写入键（端到端验证某插件真实 id 的配置消费——desktop-notify 门控等）。 */
export function setPluginConfigForTest(user: PluginConfigValues, pluginId = "__test_plugin__"): void {
  cache = { __test__: user } as AllPluginConfigs;
  cache[pluginId] = user;
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
  // 批次3：行为键（ui.*）与 schema 值同槽全量替换——保存 schema 时保留既有
  // 行为键（否则详情页「保存」会清掉使用行为设置）。
  const prevUi = uiKeysOf(cache?.[pluginId]);
  const merged = { ...prevUi, ...diff };
  await invokeCommand("plugin_config_set", { pluginId, values: merged });
  // Rust 侧也会广播 plugins-config-changed；本进程先行更新缓存让 UI 即时反馈
  //（事件到达时会整体失效重拉，双路径收敛一致）。
  cache = cache ? { ...cache, [pluginId]: merged } : { [pluginId]: merged };
  bump();
}

// ── 使用行为键（v0.9.5 需求1 GUI 改造 批次3/4：管理面设置 → 会话区归置）──
//
// 双维度设计的「使用行为段」：管理面设置 tab 下半段写入，会话区挂载层
// （session-panel-layer / dock-layout）读取。键名 ui.* 前缀与插件自身
// configSchema 键隔离（setPluginConfig 保存时保留 ui.*，见上）。

export interface PluginBehaviorConfig {
  /** 默认归所覆盖（面板类）：未设置 = 跟随插件声明槽位。（06 §5.2 ui.home
   * 的实现态：三值含悬浮左右缘，更贴 dock-layout 槽位语义——文档已回写对齐） */
  defaultSlot?: "left" | "right" | "sidebar";
  /** 自动展开策略（面板类）：install-once（默认，装完展示一次）/
   * every-session（每新会话自动打开）/ never。 */
  autoOpen?: "install-once" | "every-session" | "never";
  /** 作用域：all（默认）/ task-only（仅任务会话）。 */
  scope?: "all" | "task-only";
  /** 贴边侧位（rail 挂件）：未设置 = defaultSide/布局记忆。（06 ui.side） */
  side?: "left" | "right";
  /** 显隐（composer 挂件）：false = 隐藏呈现但插件仍启用。（06 ui.visible） */
  visible?: boolean;
  /** 执行前确认（header-action 动作）。（06 ui.confirm） */
  confirm?: boolean;
  /** 全局快捷键（调度位/动作位）：如 "ctrl+shift+t"，行为键优先于描述符
   * shortcut 声明。（06 shortcut） */
  shortcut?: string;
}

function uiKeysOf(user: PluginConfigValues | undefined): PluginConfigValues {
  const out: PluginConfigValues = {};
  for (const [k, v] of Object.entries(user ?? {})) {
    if (k.startsWith("ui.") && v !== undefined) out[k] = v;
  }
  return out;
}

/** 同步读行为键（缓存未就绪回空——跟随插件默认）。 */
export function getPluginBehavior(pluginId: string): PluginBehaviorConfig {
  return behaviorFromValues(cache?.[pluginId]);
}

function behaviorFromValues(user: PluginConfigValues | undefined): PluginBehaviorConfig {
  if (!user) return {};
  const out: PluginBehaviorConfig = {};
  if (user["ui.slot"] === "left" || user["ui.slot"] === "right" || user["ui.slot"] === "sidebar") {
    out.defaultSlot = user["ui.slot"];
  }
  if (user["ui.autoOpen"] === "install-once" || user["ui.autoOpen"] === "every-session" || user["ui.autoOpen"] === "never") {
    out.autoOpen = user["ui.autoOpen"];
  }
  if (user["ui.scope"] === "task-only") out.scope = "task-only";
  // 差异性完善（06 §5.2 对齐）：贴边/显隐/确认/快捷键四键。
  if (user["ui.side"] === "left" || user["ui.side"] === "right") out.side = user["ui.side"];
  if (typeof user["ui.visible"] === "boolean") out.visible = user["ui.visible"];
  if (user["ui.confirm"] === true) out.confirm = true;
  if (typeof user["ui.shortcut"] === "string" && /^[a-z+]{2,24}$/.test(user["ui.shortcut"])) {
    out.shortcut = user["ui.shortcut"];
  }
  return out;
}

/** 批次4：会话区挂载层消费——全部插件行为键快照（保存 → 热重渲染）。
 *  仅含有行为键的插件（稀疏 map）。 */
export function useAllPluginBehaviors(): Record<string, PluginBehaviorConfig> {
  const all = useSyncExternalStore(subscribe, snapshot);
  return useMemo(() => {
    const out: Record<string, PluginBehaviorConfig> = {};
    for (const [id, values] of Object.entries(all)) {
      const b = behaviorFromValues(values);
      if (
        b.defaultSlot || b.autoOpen || b.scope || b.side ||
        b.visible === false || b.confirm || b.shortcut
      ) out[id] = b;
    }
    return out;
    // all 引用变化（缓存重建）即重算。
  }, [all]);
}

/** 写行为键（仅覆盖 ui.*，保留插件自身配置值；选即存即热生效）。
 * 三轮评审 C23：缓存未就绪（cache=null，配置首次加载完成前用户保存行为键）
 * 时不得空合并——修前 kept 取空集，写入会抹掉该插件全部 schema 配置值；
 * 此时先等全量配置就绪再合并。 */
export async function setPluginBehavior(
  pluginId: string,
  behavior: PluginBehaviorConfig,
): Promise<void> {
  let snapshot = cache;
  if (!snapshot) {
    snapshot = await loadAll();
  }
  const kept = Object.fromEntries(
    Object.entries(snapshot[pluginId] ?? {}).filter(([k]) => !k.startsWith("ui.")),
  );
  const ui: PluginConfigValues = {};
  if (behavior.defaultSlot) ui["ui.slot"] = behavior.defaultSlot;
  if (behavior.autoOpen && behavior.autoOpen !== "install-once") ui["ui.autoOpen"] = behavior.autoOpen;
  if (behavior.scope === "task-only") ui["ui.scope"] = "task-only";
  // 差异性完善：四新键（非默认态才落盘——存储即差异语义）。
  if (behavior.side) ui["ui.side"] = behavior.side;
  if (behavior.visible === false) ui["ui.visible"] = false;
  if (behavior.confirm === true) ui["ui.confirm"] = true;
  if (behavior.shortcut) ui["ui.shortcut"] = behavior.shortcut;
  const merged = { ...kept, ...ui };
  await invokeCommand("plugin_config_set", { pluginId, values: merged });
  cache = cache ? { ...cache, [pluginId]: merged } : { [pluginId]: merged };
  bump();
}
