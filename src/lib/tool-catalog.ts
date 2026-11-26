/**
 * 会话工具目录——id → 显示名、id → 类别（v0.9.8 评审修复轮 R2）。
 *
 * 数据是后端 `session_tool_list`：除「本会话是否启用」之外与具体会话无关。
 * 此前每个会话各取各的、各存一份，带来两处问题——没打开过的会话没有名字
 * （侧栏搜索认不出消息里的工具标签）；新会话头几帧名字还没到（正文里的
 * `@[名]` 字样先按原文露出来，后面又跟着一个标签）。
 *
 * 改成全局一份：第一次用到时取一次，插件有变更（`plugins-changed`）时重取。
 * 气泡与流式里的标签、侧栏搜索都读同一份。
 */
import { listen } from "@tauri-apps/api/event";
import { invokeCommand } from "@/hooks/use-invoke";
import { devLog } from "@/lib/dev-log";

/** 会话工具条目（后端 session_tool_list 的最小子集）。 */
export interface SessionToolEntry {
  id: string;
  display_name: string;
  /** cli | mcp | skill | extension。 */
  category?: string;
}

interface ToolCatalog {
  names: Record<string, string>;
  cats: Record<string, string>;
}

/** 还没取到目录时的那份（模块私有，只读不改）。 */
const EMPTY_CATALOG: ToolCatalog = { names: {}, cats: {} };
const NEW_SESSION_KEY = "__new_session__";

/** 当前目录。快照的引用只在目录真的换了时才变（useSyncExternalStore 按引用比较）。 */
let catalog: ToolCatalog = EMPTY_CATALOG;
/** 是否成功取到过。没取到过时，下一次有消费方挂载会再试。 */
let loaded = false;
/** 在途请求。 */
let request: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function getToolNames(): Record<string, string> {
  return catalog.names;
}

export function getToolCats(): Record<string, string> {
  return catalog.cats;
}

export function subscribeToolCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(next: ToolCatalog): void {
  catalog = next;
  for (const listener of listeners) listener();
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * 取一次目录。同一时刻只有一个请求在途；失败保持现有目录（从没取到过时，
 * 下一次有消费方挂载再试，不在这里重试）。取回来的与现有的一样的，不换对象
 * ——订阅方不白白重渲染。
 */
export function refreshToolCatalog(sessionId: string | null): Promise<void> {
  if (request) return request;
  request = invokeCommand<unknown>("session_tool_list", { sessionId: sessionId ?? NEW_SESSION_KEY })
    .then((tools) => {
      // 返回形状不合预期（异常响应）：按「没取到」处理，不记成已取到——记成取到的话，
      // 当前会话的标签会一直按 id 显示、不再重试（二轮评审 R3 P2-4）。
      if (!Array.isArray(tools)) throw new Error("session_tool_list 返回的不是清单");
      const names: Record<string, string> = {};
      const cats: Record<string, string> = {};
      for (const tool of tools as SessionToolEntry[]) {
        if (!tool || typeof tool.id !== "string") continue;
        names[tool.id] = tool.display_name;
        cats[tool.id] = tool.category ?? "cli";
      }
      loaded = true;
      if (sameRecord(names, catalog.names) && sameRecord(cats, catalog.cats)) return;
      publish({ names, cats });
    })
    .catch((e) => {
      // 失败留一条日志（二轮评审 R3 P2-16）：此前静默，标签显示成 id 时查不到原因
      devLog("ipc", "工具目录读取失败（session_tool_list）", { error: String(e) });
    })
    .finally(() => {
      request = null;
    });
  return request;
}

let watching = false;

/**
 * 插件有变更（安装 / 卸载 / 启停）时重取——目录跟着注册表走，不必等到重开会话。
 * 只挂一次监听。非 Tauri 环境（测试）里 `listen` 的返回值不会被兑现：同步抛错与
 * 返回拒绝两种情况都接住，不留未处理的拒绝。
 */
function watchPluginChanges(): void {
  if (watching) return;
  watching = true;
  void Promise.resolve()
    .then(() => listen("plugins-changed", () => void refreshToolCatalog(null)))
    .then(
      () => undefined,
      () => undefined,
    );
}

/** 有消费方在用目录：还没有就取。 */
export function ensureToolCatalog(sessionId: string | null): void {
  watchPluginChanges();
  if (!loaded && !request) void refreshToolCatalog(sessionId);
}
