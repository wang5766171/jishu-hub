/**
 * 产物索引能力（v0.9.3 需求13 C5-slice1）：自会话消息流识别「生成或编辑过
 * 的本地文件」的纯算子，自 builtin/artifacts.tsx 下沉为基座能力。
 *
 * 产物口径（用户裁决）：生成或编辑过的本地文件——浏览类（read/find/grep/
 * glob/ls…）只读不产出；引用类（preview/open/reveal…）指向既有文件而非产出；
 * 会话内渲染内容（mermaid 等）不经 tool_use 文件参数，天然不在产物源。
 *
 * 两个消费形态：
 * - 直接调用（携带 projectPath 做相对路径解析）——产物中心插件/测试；
 * - 聚合器 `artifact-paths`（messages 源声明 aggregate 即得 string[]，
 *   不做项目根解析——组合插件消费时按需在渲染层解析）。
 */
import { registerAggregator } from "./aggregate-source";
import type { PluginMessage } from "../../plugins/types";

// ── 路径归一 ──

/** Windows 盘符 / UNC / POSIX 绝对路径判定。 */
function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
}

/** 相对路径以项目根解析（agent 写文件常用相对路径）。 */
export function resolveAgainstProject(path: string, projectPath: string | null): string {
  if (isAbsolutePath(path) || !projectPath) return path;
  const sep = projectPath.includes("\\") ? "\\" : "/";
  const rel = path.replace(/^[\\/]*(?:\.{1,2}[\\/]+)+/, "");
  return `${projectPath.replace(/[\\/]+$/, "")}${sep}${rel}`;
}

/** 非产出工具按名称排除（详见模块头「产物口径」）。 */
export function isNonProducingTool(name: string | undefined): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  return /(^|_)(read|find|grep|glob|ls|dir|search|list|watch|head|tail|stat|preview|open|reveal)(_|$)/.test(n)
    || /^(read|find|grep|glob|ls|dir|preview|open|reveal)/.test(n);
}

/** 工具入参里的文件路径参数（write/edit 类工具的 path 形态多样）。 */
export function pickPathArg(input: Record<string, unknown>): string | null {
  const raw =
    typeof input.path === "string"
      ? input.path
      : typeof input.file_path === "string"
        ? input.file_path
        : typeof input.filePath === "string"
          ? input.filePath
          : typeof input.file === "string"
            ? input.file
            : null;
  return raw && raw.trim() ? raw : null;
}

/** 归一化（分隔符/相对路径解析）+ 去重（后写覆盖前写，保留最新位置）。 */
export function normalizeArtifactPaths(rawPaths: string[], projectPath: string | null): string[] {
  const seen = new Map<string, true>();
  const ordered: string[] = [];
  for (const raw of rawPaths) {
    const normalized = resolveAgainstProject(raw.replace(/\\/g, "/"), projectPath).replace(/\\/g, "/");
    if (!seen.has(normalized)) {
      seen.set(normalized, true);
      ordered.push(normalized);
    } else {
      // 同路径再次写入 → 移到末尾（最新）
      const idx = ordered.indexOf(normalized);
      if (idx >= 0) ordered.splice(idx, 1);
      ordered.push(normalized);
    }
  }
  return ordered;
}

/** 主会话消息（PluginMessage 投影：blocks + text=工具名）产物提取。 */
export function extractSessionArtifacts(messages: PluginMessage[], projectPath: string | null): string[] {
  const inputs: string[] = [];
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== "tool_use") continue;
      if (isNonProducingTool(block.text)) continue;
      const raw = pickPathArg(block.input ?? {});
      if (raw) inputs.push(raw);
    }
  }
  return normalizeArtifactPaths(inputs, projectPath);
}

/** 子节点会话消息（get_session_messages 原始形状）的产物提取——任务执行
 * 的实际写文件方是节点子代理，主会话视角也要能识别其产物。 */
export function extractArtifactPathsFromRawMessages(
  messages: Array<{ content?: Array<{ type?: string; name?: string; input?: unknown }> }>,
  projectPath: string | null,
): string[] {
  const inputs: string[] = [];
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (block?.type !== "tool_use") continue;
      if (isNonProducingTool(block.name)) continue;
      const raw = pickPathArg(
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {},
      );
      if (raw) inputs.push(raw);
    }
  }
  return normalizeArtifactPaths(inputs, projectPath);
}

// ── 聚合器注册（messages 源声明 aggregate="artifact-paths" 即得产物路径列表；
//     不做项目根解析——聚合器签名无 project 语境，消费层按需解析） ──

export const artifactPathsAggregator = (
  messages: Array<{ blocks: Array<{ type: string; text?: string; input?: Record<string, unknown> }> }>,
) => {
  const inputs: string[] = [];
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== "tool_use") continue;
      if (isNonProducingTool(block.text)) continue;
      const raw = pickPathArg(block.input ?? {});
      if (raw) inputs.push(raw);
    }
  }
  return normalizeArtifactPaths(inputs, null);
};

registerAggregator("artifact-paths", artifactPathsAggregator);
