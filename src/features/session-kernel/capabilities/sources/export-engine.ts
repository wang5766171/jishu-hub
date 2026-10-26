/**
 * 会话导出引擎（v0.9.3 需求13 C5 后续轮）：消息流 → Markdown 的纯渲染算子，
 * 自 builtin/session-export.tsx 逐字下沉为基座能力（插件与未来组合动作共用）。
 * 仅纯转换；文件保存对话框与写盘 IPC 留在动作/插件层。
 */
import { parseFileRefs } from "@/components/sessions/inline-image";
import type { PluginBlock, PluginMessage } from "../../plugins/types";

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

export interface SessionMarkdownInput {
  title: string | null;
  sessionId: string | null;
  messages: PluginMessage[];
  /** 文案函数（i18n；缺省内置中文兜底）。 */
  t: (key: string, fallback: string) => string;
}

/** 会话 → Markdown 终稿（标题/导出时间/逐消息逐块；与原 composeMarkdown 同义）。 */
export function composeSessionMarkdown(input: SessionMarkdownInput): string {
  const { t } = input;
  const lines: string[] = [];
  lines.push(`# ${input.title ?? input.sessionId ?? t("sessionPlugins.export.untitled", "会话记录")}`);
  lines.push("");
  lines.push(`> ${t("sessionPlugins.export.exportedAt", "导出时间")}：${new Date().toLocaleString()}`);
  lines.push("");
  for (const message of input.messages) {
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
