/**
 * v0.9.4 需求12：dev 全流程日志总线（日志中心的数据层）。
 *
 * 设计要点：
 * - **生产零开销**：`import.meta.env.DEV` 为 false 时 devLog 内部短路——无缓冲
 *   写入、无订阅通知，调用点零样板（不需要 if (DEV) 包裹）。
 * - **环形缓冲**（默认 3000 条，超出丢最旧）——排查会话流转/时序足够回溯，
 *   不吃内存。
 * - **订阅推送**：日志中心面板实时刷新（带版本号通知）。
 * - 高频事件（text_delta/thinking_delta/tool_use_progress）由调用方自行聚合
 *   或跳过，本层不做节流（保持简单）。
 *
 * 类别约定：pipeline（事件管线）/ store（流式态）/ steer（引导协调器）/
 * ipc（会话命令）/ session（切换/滚动）/ approval（审批交互）。
 */

export type DevLogCategory =
  | "pipeline"
  | "store"
  | "steer"
  | "ipc"
  | "session"
  | "approval"
  /** v0.9.4 需求12：插件经底座 ctx.devLog 发出的日志（message 约定以 [插件id] 开头）。 */
  | "plugin";

export interface DevLogEntry {
  /** 单调序号（复制与定位用）。 */
  seq: number;
  /** epoch ms。 */
  ts: number;
  category: DevLogCategory;
  message: string;
  data?: unknown;
}

const MAX_ENTRIES = 3000;

const IS_DEV = typeof import.meta !== "undefined" && Boolean(import.meta.env?.DEV);

/**
 * v0.9.4 需求12 测试期（用户：安装包测试更稳定——dev 启动会被代码改动重启）：
 * 运行时强制开关——设置页打开后**生产构建同样启用日志中心**（localStorage
 * 持久化，属显示层调试开关）。dev 构建恒启用。
 */
let forceEnabled = false;
void 0;
export function isDevLogForced(): boolean {
  return forceEnabled;
}

/** 启动时从后端 settings.json 水合（app 挂载早期调用一次；后端为主权威，
 *  localStorage 仅作水合前的闪断兜底——用户实测 localStorage 跨启动丢失，
 *  后端持久化解决）。 */
export async function hydrateDevLogForced(): Promise<void> {
  try {
    const { invokeCommand } = await import("@/hooks/use-invoke");
    forceEnabled = await invokeCommand<boolean>("get_dev_log_forced");
  } catch {
    forceEnabled = false;
  }
  version += 1;
  for (const l of listeners) l();
}

export async function setDevLogForced(v: boolean): Promise<void> {
  forceEnabled = v;
  version += 1;
  for (const l of listeners) l();
  try {
    const { invokeCommand } = await import("@/hooks/use-invoke");
    await invokeCommand("set_dev_log_forced", { enabled: v });
  } catch (e) {
    console.warn("[dev-log] 持久化开关失败（内存态仍生效）:", e);
  }
}

function enabled(): boolean {
  return IS_DEV || forceEnabled;
}

let entries: DevLogEntry[] = [];
let nextSeq = 1;
let t0 = 0;
let version = 0;
const listeners = new Set<() => void>();

export function devLog(category: DevLogCategory, message: string, data?: unknown): void {
  if (!enabled()) return;
  const ts = Date.now();
  if (t0 === 0) t0 = ts;
  entries.push({ seq: nextSeq++, ts, category, message, data });
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(-MAX_ENTRIES);
  }
  version += 1;
  for (const l of listeners) l();
}

/** 快照（最新在末尾）。 */
export function getDevLogs(): readonly DevLogEntry[] {
  return entries;
}

export function devLogVersion(): number {
  return version;
}

export function subscribeDevLogs(listener: () => void): () => void {
  if (!enabled()) return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearDevLogs(): void {
  entries = [];
  version += 1;
  for (const l of listeners) l();
}

/** 格式化为可复制文本（用户粘贴给 agent 排查用）。 */
export function formatDevLogs(filter?: readonly DevLogCategory[]): string {
  const t0Local = entries[0]?.ts ?? 0;
  const lines = entries
    .filter((e) => !filter || filter.length === 0 || filter.includes(e.category))
    .map((e) => {
      const rel = `+${String(e.ts - t0Local).padStart(6, " ")}ms`;
      const data = e.data === undefined ? "" : " " + safeJson(e.data);
      return `#${e.seq} [${rel}] [${e.category}] ${e.message}${data}`;
    });
  return lines.join("\n");
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s !== undefined && s.length > 400 ? s.slice(0, 400) + "…(" + s.length + ")" : (s ?? "");
  } catch {
    return String(v);
  }
}
