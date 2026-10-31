import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { invokeCommand } from "@/hooks/use-invoke";
import { sessionExportPlugin } from "./builtin/session-export";
import { usagePanelPlugin } from "./builtin/usage-panel";
import { messageSearchPlugin } from "./builtin/message-search";
import "@/features/session-kernel/capabilities/renderers/components/MermaidRenderer";
// 需求14 M5 批1：html/interaction 组合化——渲染键注册（组件本体）+ 内置
// 组合清单（描述符/挂载声明，resources/composed-plugins/*.toml）。
import "@/features/session-kernel/capabilities/renderers/components/HtmlRenderer";
import "@/features/session-kernel/capabilities/renderers/components/InteractionRenderer";
import "@/features/session-kernel/capabilities/renderers/components/primitives";
import "@/features/session-kernel/capabilities/sources/aggregate-source";
import "@/features/session-kernel/capabilities/sources/artifact-index";
import "@/features/session-kernel/capabilities/actions";
import { composedPlugins, composedVersion, subscribeComposed } from "@/features/session-kernel/capabilities/composition/loader";
import { artifactsPlugin } from "./builtin/artifacts";
import { streamStatusPlugin } from "./builtin/stream-status";
import { contextRingPlugin } from "./builtin/context-ring";
import { todoBoardPlugin } from "./builtin/todo-board";
import type { SessionPluginDescriptor } from "./types";

/**
 * 前端会话插件注册表（v0.9.2 需求1 P3）——镜像后端微内核形态：
 * 「id → 实现」映射 + 启用过滤。新增内置插件 = 新增一个描述符（零内核/
 * 宿主改动），这是 Stage 0 的开闭原则机械检验标准（05 §4）。
 *
 * 注册纪律：后端 `builtin_session_plugin_specs()` 与此处按 id 对齐；前端
 * 实现未落地不登记后端描述符（插件页不出现无实现的开关）。
 */
const BUILTIN_SESSION_PLUGINS: SessionPluginDescriptor[] = [
  // 注：HTML 实时渲染（html-render，聊天流内 ```html 代码块渲染卡）与产物
  // 中心（artifacts，产出文件侧栏预览）是两个能力，均保留——前者处理代码
  // 块、后者处理落盘文件（v0.9.3 测试期用户确认，非 html-preview 残留）。
  // 任务流程全景（session.flow）已 C5-slice1 组合化（session.task-board）。
  sessionExportPlugin,
  usagePanelPlugin,
  messageSearchPlugin,
  artifactsPlugin,
  streamStatusPlugin,
  contextRingPlugin,
  // v0.9.5 需求12：待办看板（右上角悬浮列表，rpiv-todo 快照可视化）——
  // 注意它**不进后端 builtin_session_plugin_specs**（无独立管理条目）：
  // 用户层面与 rpiv-todo 是一个「待办」插件（见 SESSION_PLUGIN_PROXY）。
  todoBoardPlugin,
];

/** v0.9.5 需求12：会话插件启用态代理映射——插件 id → 代理条目 id（插件
 * 中心同一条目控制工具与挂件；用户裁决：用户层面一个「待办」插件）。
 * 代理目标不限于 kind=session（pi-todo 是 kind=tool 闸门）——refresh 侧
 * 收集全量 enabled id，交集时按本表换算。 */
const SESSION_PLUGIN_PROXY: Record<string, string> = {
  "session.todo-board": "pi-todo",
};

export function listSessionPlugins(): SessionPluginDescriptor[] {
  // v0.9.3 需求13：builtin 存量 + 组合式（manifest 装配）合并输出。
  return [...BUILTIN_SESSION_PLUGINS, ...composedPlugins()];
}

export function findSessionPlugin(id: string): SessionPluginDescriptor | undefined {
  return BUILTIN_SESSION_PLUGINS.find((plugin) => plugin.id === id);
}

interface PluginListEntry {
  id: string;
  kind: string;
  enabled: boolean;
}

/**
 * 已启用的会话插件 id 集合（含 registry 内置实现交集）。
 * 数据源：后端统一插件清单（plugins.json 启停权威）；`plugins-changed`
 * 广播（插件页开关 → 后端热重建）即时刷新，无需重启。
 */
export function useEnabledSessionPlugins(): Set<string> {
  const [backendEnabled, setBackendEnabled] = useState<Set<string> | null>(null);
  // v0.9.3 需求13：组合清单异步装载完成 → 版本快照变化 → 交集重算（否则
  // 组合插件在首查后被剔除出启用集，且 provider 不重算——渲染失效根因②）。
  const composedRev = useSyncExternalStore(subscribeComposed, composedVersion, () => 0);

  const refresh = useCallback(async () => {
    try {
      const result = await invokeCommand<{ plugins: PluginListEntry[] }>("plugin_list");
      setBackendEnabled(
        new Set(
          (result.plugins ?? [])
            .filter((p) => p.enabled)  // 需求12：全量收集（代理映射目标含 kind=tool 条目如 pi-todo）
            .map((p) => p.id),
        ),
      );
    } catch {
      // 查询失败保持当前值（默认全启用兜底）
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unlisten = listen("plugins-changed", () => void refresh());
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refresh]);

  return useMemo(() => {
    if (backendEnabled === null) return defaultEnabled();
    // 需求12：代理映射换算后查集（session.todo-board ← pi-todo 启用态）。
    return new Set(
      listSessionPlugins()
        .map((p) => p.id)
        .filter((id) => backendEnabled.has(SESSION_PLUGIN_PROXY[id] ?? id)),
    );
    // composedRev 进依赖：装载完成后重算交集。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendEnabled, composedRev]);
}

function defaultEnabled(): Set<string> {
  // 初值全启用：首次渲染（后端清单未返回前）不闪烁；后端权威值到达后校正。
  return new Set(listSessionPlugins().map((p) => p.id));
}
