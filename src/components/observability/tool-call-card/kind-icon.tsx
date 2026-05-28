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
import type { ToolKind } from "./types";

const kindConfig: Record<ToolKind, { icon: typeof FileText; label: string; bgVar: string }> = {
  file_read: { icon: FileText, label: "Read", bgVar: "--tool-bg-file-read" },
  file_edit: { icon: FilePen, label: "Edit", bgVar: "--tool-bg-file-edit" },
  file_write: { icon: FilePlus, label: "Write", bgVar: "--tool-bg-file-write" },
  file_delete: { icon: FileX, label: "Delete", bgVar: "--tool-bg-file-delete" },
  shell_exec: { icon: Terminal, label: "Bash", bgVar: "--tool-bg-shell" },
  search: { icon: Search, label: "Search", bgVar: "--tool-bg-search" },
  web: { icon: Globe, label: "Web", bgVar: "--tool-bg-web" },
  think: { icon: Brain, label: "Thinking", bgVar: "--tool-bg-think" },
  subtask: { icon: Bot, label: "Task", bgVar: "--tool-bg-subtask" },
  other: { icon: Wrench, label: "Tool", bgVar: "--tool-bg-other" },
};

export function KindIcon({ kind }: { kind: ToolKind }) {
  const config = kindConfig[kind] ?? kindConfig.other;
  const Icon = config.icon;
  return (
    <span
      className="inline-flex items-center justify-center rounded-[4px] border border-border/45 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]"
      style={{ background: `var(${config.bgVar})` }}
    >
      <Icon className="w-[1.05em] h-[1.05em] text-[var(--color-foreground)]" />
    </span>
  );
}

export function kindLabel(kind: ToolKind): string {
  return kindConfig[kind]?.label ?? "Tool";
}
