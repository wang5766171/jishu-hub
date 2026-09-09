import { FileDown } from "lucide-react";
import i18next from "i18next";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type { SessionPluginDescriptor, SessionKernelContext } from "../types";

/**
 * 会话导出插件（v0.9.2 需求1 M4，用户圈定首期 #18）——header-action 挂载点
 * 首个使用者。当前会话导出为 Markdown 文件（用户/助手文本轮次；工具调用
 * 以摘要行呈现），保存对话框选路径，后端命令落盘。
 */

const t = (key: string, fallback: string) => i18next.t(key, { defaultValue: fallback });

function composeMarkdown(ctx: SessionKernelContext): string {
  const lines: string[] = [];
  lines.push(`# ${ctx.sessionTitle ?? ctx.sessionId ?? t("sessionPlugins.export.untitled", "会话记录")}`);
  lines.push("");
  lines.push(`> ${t("sessionPlugins.export.exportedAt", "导出时间")}：${new Date().toLocaleString()}`);
  lines.push("");
  for (const message of ctx.messages) {
    if (message.role === "user") {
      lines.push(`## ${t("sessionPlugins.export.user", "用户")}`);
      lines.push("");
      lines.push(message.text);
      lines.push("");
    } else if (message.role === "assistant") {
      lines.push(`## ${t("sessionPlugins.export.assistant", "助手")}`);
      lines.push("");
      lines.push(message.text);
      lines.push("");
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
