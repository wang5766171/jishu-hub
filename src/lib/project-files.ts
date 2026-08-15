import { useEffect, useState } from "react";
import { invokeCommand } from "@/hooks/use-invoke";

/**
 * 项目文件清单（v0.7.3 需求2-A1）：@ 补全的数据源。
 * 后端 `list_project_files` 返回忽略构建/依赖目录后的相对路径清单；
 * 前端按项目路径模块级缓存，@ 触发时按需拉取一次。
 */

const projectFilesCache = new Map<string, string[]>();

export function useProjectFiles(projectPath: string | null | undefined, enabled: boolean): string[] {
  const [files, setFiles] = useState<string[]>(() =>
    projectPath && enabled ? projectFilesCache.get(projectPath) ?? [] : [],
  );

  useEffect(() => {
    if (!projectPath || !enabled) return;
    const cached = projectFilesCache.get(projectPath);
    if (cached) {
      setFiles(cached);
      return;
    }
    let cancelled = false;
    invokeCommand<string[]>("list_project_files", { projectRoot: projectPath })
      .then((list) => {
        projectFilesCache.set(projectPath, list);
        if (!cancelled) setFiles(list);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, enabled]);

  return files;
}
