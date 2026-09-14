import { FileDown } from "lucide-react";
import i18next from "i18next";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { parseFileRefs } from "@/components/sessions/inline-image";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type { SessionPluginDescriptor, SessionKernelContext, PluginBlock } from "../types";

/**
 * 会话导出插件（v0.9.2 需求1 M4，用户圈定首期 #18）——header-action 挂载点
 * 首个使用者。当前会话导出为 Markdown 文件，保存对话框选路径，后端命令落盘。
 *
 * v0.9.3 需求6：导出增强——① 工具调用摘要行（工具名 + 关键参数摘要，错误
 * 结果附输出片段）；② 图片引用（会话内嵌图片标记转 markdown 图片引用，
 * 路径为本地绝对路径，源文件保留时查看器可直接显示）。
 */

const t = (key: string, fallback: string) => i18next.t(key, { defaultValue: fallback });

const IMAGE_MARKER_RE = /<!--JISHU_HUB_IMAGES_BEGIN-->([\s\S]*?)<!--JISHU_HUB_IMAGES_END-->/g;

/** 文本块导出投影：剥离内嵌图片标记（正文不再残留注释标记），图片另列。 */
export function projectTextBlockForExport(text: string): { body: string; imageLines: string[] } {
  const images: string[] = [];
  const body = text.replace(IMAGE_MARKER_RE, (_match, inner: string) => {
    for (const ref of parseFileRefs(`<!--JISHU_HUB_IMAGES_BEGIN-->${inner}<!--JISHU_HUB_IMAGES_END-->`)) {
      images.push(ref.isImage ? `![${ref.label}](${ref.path})` : `[${ref.label}](${ref.path})`);
    }
    return "";
  });
  return { body: body.replace(/\\n/g, "\n").trim(), imageLines: images };
}

/** 工具调用摘要行：工具名 + 输入的关键字段截断（路径/命令/查询类优先）。 */
export function toolSummaryLine(block: PluginBlock): string | null {
  if (block.type !== "tool_use") return null;
  const input = block.input ?? {};
  const keys = ["path", "file_path", "command", "query", "pattern", "url", "content"];
  const parts: string[] = [];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      parts.push(`${key}=${value.trim().slice(0, 80)}${value.trim().length > 80 ? "…" : ""}`);
      if (parts.length >= 2) break;
    }
  }
  const summary = parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
  return `> 🔧 \`${block.text ?? "tool"}\`${summary}`;
}

/** tool_result 摘要（仅错误结果输出片段——成功结果通常冗长，正文已含结论）。 */
export function toolResultErrorLine(block: PluginBlock): string | null {
  if (block.type !== "tool_result" || !block.isError || !block.output) return null;
  return `> ⚠️ ${(block.output ?? "").trim().slice(0, 160)}${block.output.trim().length > 160 ? "…" : ""}`;
}

function composeMarkdown(ctx: SessionKernelContext): string {
  const lines: string[] = [];
  lines.push(`# ${ctx.sessionTitle ?? ctx.sessionId ?? t("sessionPlugins.export.untitled", "会话记录")}`);
  lines.push("");
  lines.push(`> ${t("sessionPlugins.export.exportedAt", "导出时间")}：${new Date().toLocaleString()}`);
  lines.push("");
  for (const message of ctx.messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    lines.push(`## ${message.role === "user" ? t("sessionPlugins.export.user", "用户") : t("sessionPlugins.export.assistant", "助手")}`);
    lines.push("");
    for (const block of message.blocks) {
      if (block.type === "text" && block.text) {
        const { body, imageLines } = projectTextBlockForExport(block.text);
        if (body) lines.push(body);
        for (const image of imageLines) lines.push("", image);
        lines.push("");
      } else {
        const toolLine = toolSummaryLine(block) ?? toolResultErrorLine(block);
        if (toolLine) {
          lines.push(toolLine);
          lines.push("");
        }
      }
    }
  }
  return lines.join("\n");
}

async function exportSession(ctx: SessionKernelContext): Promise<void> {
  if (!ctx.messages || ctx.messages.length === 0) return;
  const suggested = `${(ctx.sessionTitle ?? "session").replace(/[\\/:*?"<>|]/g, "_")}.md`;
  const path = await save({
    defaultPath: suggested,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (!path) return;
  await invoke("export_text_file", { path, content: composeMarkdown(ctx) });
}

export const sessionExportPlugin: SessionPluginDescriptor = {
  id: "session.export",
  displayNameKey: "sessionPlugins.export.name",
  displayNameFallback: "会话导出",
  descriptionKey: "sessionPlugins.export.description",
  descriptionFallback: "当前会话一键导出为 Markdown 文件",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: ["read:messages", "write:file-dialog"],
  mounts: [
    {
      kind: "header-action",
      labelKey: "sessionPlugins.export.action",
      labelFallback: "导出会话",
      icon: FileDown,
      onClick: (ctx) => {
        void exportSession(ctx).catch((error) => console.warn("export session failed:", error));
      },
    },
  ],
};
