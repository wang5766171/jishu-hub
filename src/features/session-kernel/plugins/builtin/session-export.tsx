import { FileDown } from "lucide-react";
import i18next from "i18next";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type { SessionPluginDescriptor, SessionKernelContext } from "../types";
import { composeSessionMarkdown } from "../../capabilities/sources/export-engine";

/**
 * 会话导出插件（v0.9.2 需求1 M4，用户圈定首期 #18）——header-action 挂载点
 * 首个使用者。当前会话导出为 Markdown 文件，保存对话框选路径，后端命令落盘。
 *
 * v0.9.3 需求6：导出增强——① 工具调用摘要行（工具名 + 关键参数摘要，错误
 * 结果附输出片段）；② 图片引用（会话内嵌图片标记转 markdown 图片引用，
 * 路径为本地绝对路径，源文件保留时查看器可直接显示）。
 */

const t = (key: string, fallback: string) => i18next.t(key, { defaultValue: fallback });

async function exportSession(ctx: SessionKernelContext): Promise<void> {
  if (!ctx.messages || ctx.messages.length === 0) return;
  const suggested = `${(ctx.sessionTitle ?? "session").replace(/[\\/:*?"<>|]/g, "_")}.md`;
  const path = await save({
    defaultPath: suggested,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (!path) return;
  await invoke("export_text_file", { path, content: composeSessionMarkdown({ title: ctx.sessionTitle ?? null, sessionId: ctx.sessionId ?? null, messages: ctx.messages, t }) });
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

export { projectTextBlockForExport, toolSummaryLine, toolResultErrorLine } from "../../capabilities/sources/export-engine";
