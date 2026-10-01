import {
  FileText,
  FilePen,
  FilePlus,
  FileX,
  Terminal,
  Search,
  Globe,
  Brain,
  Bot,
  Wrench,
} from "lucide-react";
import i18n from "@/i18n";
import type { ToolKind } from "./types";

// v0.9.5 需求4：工具名汉化（用户裁决——edit/bash/write 等英文换中文；
// 英文 id 作为次要信息保留在工具卡详情/原始输出层）。
// 三轮评审 P1-6：标签走 i18n（zh/en 双语，§7 纪律）——非组件语境用 i18n
// 实例直取（每次调用时解析，语言切换即生效）。
const kindConfig: Record<ToolKind, { icon: typeof FileText; bgVar: string }> = {
  file_read: { icon: FileText, bgVar: "--tool-bg-file-read" },
  file_edit: { icon: FilePen, bgVar: "--tool-bg-file-edit" },
  file_write: { icon: FilePlus, bgVar: "--tool-bg-file-write" },
  file_delete: { icon: FileX, bgVar: "--tool-bg-file-delete" },
  shell_exec: { icon: Terminal, bgVar: "--tool-bg-shell" },
  search: { icon: Search, bgVar: "--tool-bg-search" },
  web: { icon: Globe, bgVar: "--tool-bg-web" },
  think: { icon: Brain, bgVar: "--tool-bg-think" },
  subtask: { icon: Bot, bgVar: "--tool-bg-subtask" },
  other: { icon: Wrench, bgVar: "--tool-bg-other" },
};

export function KindIcon({ kind }: { kind: ToolKind }) {
  const config = kindConfig[kind] ?? kindConfig.other;
  const Icon = config.icon;
  return (
    <span
      className="inline-flex items-center justify-center rounded-[6px] border border-border/45 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]"
      style={{ background: `var(${config.bgVar})` }}
    >
      <Icon className="w-[1.05em] h-[1.05em] text-[var(--color-foreground)]" />
    </span>
  );
}

export function kindLabel(kind: ToolKind): string {
  return i18n.t(`tools.kind.${kind}`, { defaultValue: "Tool" });
}
