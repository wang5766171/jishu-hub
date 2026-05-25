import { Card, CardContent } from "@/components/ui/card";
import { FolderOpen, FileText, MessageSquare, AlertCircle, MoreVertical, Pencil as PencilIcon, MessageSquareText } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import { useState, useRef, useEffect } from "react";
import type { Project, ProjectMeta } from "@/types";

interface ProjectCardProps {
  project: Project;
  selected: boolean;
  onClick: () => void;
  meta?: ProjectMeta;
  managementMode?: boolean;
  checked?: boolean;
  onCheck?: () => void;
  mergedCount?: number;
  onTagClick?: (tag: string) => void;
  onRefresh?: () => void;
  onEnterChat?: () => void;
}

export function ProjectCard({
  project,
  selected,
  onClick,
  meta,
  managementMode,
  checked,
  onCheck,
  mergedCount,
  onTagClick,
  onRefresh,
  onEnterChat,
}: ProjectCardProps) {
  const { t } = useTranslation();
  const displayName = meta?.custom_name || project.name;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const handleInit = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await invokeCommand("run_in_terminal", { commandStr: "claude init", cwd: project.path });
    } catch (err) {
      console.error("Failed to run claude init:", err);
    }
    onRefresh?.();
  };

  const handleCardClick = () => {
    if (managementMode) return;
    if (project.initialized) {
      onEnterChat?.();
    }
  };

  return (
    <Card
      className={cn(
        "relative transition-colors hover:border-primary/50",
        !managementMode && project.initialized && "cursor-pointer",
        selected && "border-primary ring-1 ring-primary/20"
      )}
      onClick={handleCardClick}
    >
      {managementMode && (
        <div
          className="absolute top-2 left-2 z-10"
          onClick={(e) => {
            e.stopPropagation();
            onCheck?.();
          }}
        >
          <input
            type="checkbox"
            checked={checked}
            className="h-4 w-4"
          />
        </div>
      )}
      {mergedCount != null && mergedCount > 0 && (
        <div className="absolute top-2 right-2 z-10">
          <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] bg-primary/10 text-primary rounded">
            {t("projects.mergedCount", { count: mergedCount })}
          </span>
        </div>
      )}
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
            <h3 className="font-medium truncate">{displayName}</h3>
          </div>
          {!mergedCount && project.has_claude_md && (
            <FileText className="h-4 w-4 text-green-500 shrink-0" />
          )}
        </div>
        {meta?.custom_name && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {project.name}
          </p>
        )}
        <p className="mt-1 truncate text-xs text-muted-foreground" title={project.path}>
          {project.path}
        </p>
        {meta?.tags && meta.tags.length > 0 && (
          <div className="flex gap-1 mt-1 flex-wrap">
            {meta.tags.slice(0, 2).map(tag => (
              <span
                key={tag}
                className="inline-flex items-center px-1.5 py-0.5 text-[10px] bg-secondary text-secondary-foreground rounded cursor-pointer hover:bg-primary/20 hover:text-primary transition-colors"
                onClick={(e) => { e.stopPropagation(); onTagClick?.(tag); }}
              >
                {tag}
              </span>
            ))}
            {meta.tags.length > 2 && (
              <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] bg-muted text-muted-foreground rounded">
                +{meta.tags.length - 2}
              </span>
            )}
          </div>
        )}
        {!project.initialized ? (
          <button
            className="mt-2 flex items-center gap-1.5 text-xs text-amber-500 hover:text-amber-600 transition-colors"
            onClick={handleInit}
          >
            <AlertCircle className="h-3 w-3" />
            {t("projects.notInitialized")}
          </button>
        ) : (
          <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <MessageSquare className="h-3 w-3" />
                {t("projects.sessionCount", { count: project.session_count })}
              </span>
              {project.last_active && <span>{project.last_active}</span>}
            </div>
            {!managementMode && (
              <div className="relative" ref={menuRef}>
                <button
                  className="h-6 w-6 flex items-center justify-center rounded hover:bg-accent/50 transition-fast"
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
                >
                  <MoreVertical className="h-3.5 w-3.5" />
                </button>
                {menuOpen && (
                  <div className="absolute right-0 bottom-full mb-1 w-28 rounded-lg border border-border bg-card shadow-lg z-20 overflow-hidden">
                    <button
                      className="flex items-center gap-2 w-full px-3 py-2 text-xs text-foreground hover:bg-accent/50 transition-fast"
                      onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onClick(); }}
                    >
                      <PencilIcon className="h-3 w-3" />
                      {t("common.edit")}
                    </button>
                    <button
                      className="flex items-center gap-2 w-full px-3 py-2 text-xs text-foreground hover:bg-accent/50 transition-fast"
                      onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onEnterChat?.(); }}
                    >
                      <MessageSquareText className="h-3 w-3" />
                      {t("projects.enterChat")}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
