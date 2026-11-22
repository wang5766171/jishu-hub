/**
 * v0.9.8 需求10 D10-2（成果卡 L1）：任务产物区——列
 * `<project>/.jishu-hub/tasks/<task_id>/artifacts/` 下文件（名称/大小/时间），
 * 每项「打开」=资源管理器定位该文件（reveal_in_file_manager，v0.8.0 成熟
 * 封装）；头部「打开产物文件夹」定位目录。空目录/历史任务无产物区 →
 * 「暂无产物文件」只读提示（自然降级，不假装能打开）。
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, Loader2, Paperclip } from "lucide-react";

import { invokeCommand } from "@/hooks/use-invoke";

interface TaskArtifactFile {
  name: string;
  rel_path: string;
  abs_path: string;
  size: number;
  modified_ms: number;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function TaskArtifactsPanel({
  taskId,
  projectRoot,
}: {
  taskId: string;
  projectRoot: string;
}) {
  const { t } = useTranslation();
  const [files, setFiles] = useState<TaskArtifactFile[] | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await invokeCommand<TaskArtifactFile[]>("task_artifacts_list", {
        projectRoot,
        taskId,
      });
      setFiles(list ?? []);
    } catch {
      setFiles([]);
    }
  }, [projectRoot, taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  const artifactsDir = `${projectRoot.replace(/[\\/]+$/, "")}${projectRoot.includes("\\") ? "\\" : "/"}.jishu-hub${projectRoot.includes("\\") ? "\\" : "/"}tasks${projectRoot.includes("\\") ? "\\" : "/"}${taskId}${projectRoot.includes("\\") ? "\\" : "/"}artifacts`;

  const reveal = async (path: string) => {
    try {
      await invokeCommand("reveal_in_file_manager", { path });
    } catch {
      // 失败静默——目录被外部移动等边缘场景。
    }
  };

  const count = files?.length ?? 0;

  return (
    <div className="border-t border-border/60 bg-background/80 px-3 py-2">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          if (!open && files === null) void load();
        }}
        className="flex w-full items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <Paperclip className="h-3.5 w-3.5" />
        <span className="flex-1 text-left">
          {t("task.artifacts.title", "任务产物")}
          {files !== null && count > 0 ? ` · ${count}` : ""}
        </span>
        {files === null && <Loader2 className="h-3 w-3 animate-spin" />}
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-1">
          {files === null || count === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {t("task.artifacts.empty", "暂无产物文件")}
            </p>
          ) : (
            <>
              {files.map((f) => (
                <div key={f.rel_path} className="flex items-center gap-2 text-[11px]">
                  <span className="min-w-0 flex-1 truncate" title={f.rel_path}>
                    {f.rel_path}
                  </span>
                  <span className="shrink-0 text-muted-foreground/70">{fmtSize(f.size)}</span>
                  <button
                    type="button"
                    onClick={() => void reveal(f.abs_path)}
                    className="shrink-0 rounded px-1.5 py-0.5 text-primary hover:bg-accent"
                  >
                    {t("task.artifacts.open", "打开")}
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => void reveal(artifactsDir)}
                className="mt-1 flex items-center gap-1 self-start text-[11px] text-muted-foreground hover:text-foreground"
              >
                <FolderOpen className="h-3 w-3" />
                {t("task.artifacts.openFolder", "打开产物文件夹")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
