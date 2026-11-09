/**
 * v0.9.7 需求6 F2：会话内产物引用 `[标题](jishu-artifact://<项目相对路径>)` 的
 * 点击处理与渲染件。
 *
 * - `openArtifactReference`：共享处理器（**先校验后发信号**——P2-9：校验放
 *   点击处 await，信号链保持同步语义）。需求2 的任务成果卡「打开」直连同款
 *   （P2-6），不走 markdown。
 * - `ArtifactLink`：react-markdown `components.a` 覆写——artifact href 拦截
 *   点击，其余 href 回落默认 `<a>`（http 外开语义不变）。
 * - `SessionArtifactContext`：P2-15——chat-page 消息区注入
 *   `{ projectPath: currentProject?.path ?? null, sessionId: selectedSession }`；
 *   projectPath 为 null 时仅绝对路径引用可解析。
 * - 校验基准 project_root 由前端显式传入 IPC（P1-5：不依赖进程表反查——
 *   刷新/重启后回放链接依然可校验）。
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import { emitSessionSignal } from "@/features/session-kernel/signals";
import { resolveAgainstProject } from "@/features/session-kernel/capabilities/sources/artifact-index";
import { ARTIFACT_SCHEME } from "@/lib/markdown-url";
import { cn } from "@/lib/utils";

export interface SessionArtifactCtx {
  projectPath: string | null;
  sessionId: string | null;
}

export const SessionArtifactContext = createContext<SessionArtifactCtx>({
  projectPath: null,
  sessionId: null,
});

export const useSessionArtifactCtx = () => useContext(SessionArtifactContext);

interface PreviewKindResult {
  kind: "html" | "image" | "markdown" | "text" | "unsupported";
}

/** 需求9 #2 兜底：CommonMark 链接目标解析会吞「反斜杠+ASCII 标点」里的
 * 反斜杠——`C:\Users\name\.jishu-hub\tasks\…` 被解析成 `name.jishu-hub`
 *（分隔符消失，文件必不存在；生成侧已加正斜杠约束治新链，此处救存量
 * 坏链）。`.jishu-hub` 是固定目录名，启发式命中即插回反斜杠。 */
export function repairEatenSeparator(path: string): string {
  // 「非分隔符字符紧跟 .jishu-hub」= 粘连形态（正常路径 .jishu-hub 前必是 \ 或 /）。
  if (/[^\\/\\]\.jishu-hub[\\/]/i.test(path)) {
    return path.replace(/([^.\\/\\])\.jishu-hub([\\/])/gi, "$1\\.jishu-hub$2");
  }
  return path;
}

/** 共享处理器：校验（validate_preview_file）通过才发 file-preview-request。
 * 需求9 #2：①坏链修复启发式（repairEatenSeparator）；② projectPath 缺失
 *（refresh 掉线/恢复窗口瞬态）回落默认工作空间根——默认空间会话的引用
 * 仍可校验打开。 */
export async function openArtifactReference(
  href: string,
  ctx: SessionArtifactCtx,
): Promise<{ ok: boolean; error?: string }> {
  let rel = href.slice(ARTIFACT_SCHEME.length);
  if (!rel) return { ok: false, error: "empty" };
  rel = repairEatenSeparator(rel);
  let projectPath = ctx.projectPath;
  if (!projectPath) {
    try {
      const ws = await invokeCommand<{ path: string }>("get_default_workspace");
      projectPath = ws?.path ?? null;
    } catch {
      projectPath = null;
    }
    if (!projectPath) return { ok: false, error: "no-project" };
  }
  const abs = resolveAgainstProject(rel, projectPath);
  try {
    await invokeCommand<PreviewKindResult>("validate_preview_file", {
      path: abs,
      projectRoot: projectPath,
      sessionId: ctx.sessionId,
    });
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  emitSessionSignal({
    type: "file-preview-request",
    file: abs,
    sessionId: ctx.sessionId ?? undefined,
  });
  return { ok: true };
}

interface ArtifactLinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  href?: string;
  children?: ReactNode;
}

/** react-markdown `a` 覆写：artifact 协议拦截，其余默认。 */
export function ArtifactLink({ href, children, className, ...rest }: ArtifactLinkProps) {
  const { t } = useTranslation();
  const artifactCtx = useSessionArtifactCtx();
  const [failed, setFailed] = useState(false);
  const [failedMsg, setFailedMsg] = useState<string>("");

  if (!href || !href.startsWith(ARTIFACT_SCHEME)) {
    return (
      <a href={href} className={className} target="_blank" rel="noreferrer" {...rest}>
        {children}
      </a>
    );
  }

  const handleClick = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const result = await openArtifactReference(href, artifactCtx);
    if (!result.ok) {
      // 项目无 toast 库：链接旁短暂标红提示（3s 自愈），面板保持不动。
      // 需求9 #2：按后端错误区分提示（原单一文案把「文件不存在」也说成
      // 「超出项目范围」，误导排查）。
      const err = result.error ?? "";
      setFailedMsg(
        err.includes("文件不存在") || err === "no-project" || err === "empty"
          ? t("sessions.artifactLinkNotFound", "文件不存在或已被移动")
          : err.includes("超出项目范围")
            ? t("sessions.artifactLinkFailed")
            : t("sessions.artifactLinkTooLarge", "文件过大或无法预览"),
      );
      setFailed(true);
      setTimeout(() => setFailed(false), 3000);
    }
  };

  return (
    <>
      <a
        href={href}
        onClick={handleClick}
        title={t("sessions.artifactLinkHint")}
        className={cn(
          // 需求7 修2：蓝色实线下划线（原白色虚线不显眼）；失败态红字。
          "cursor-pointer underline decoration-solid underline-offset-2 font-medium",
          failed ? "text-red-500 decoration-red-400" : "text-primary decoration-primary/70",
          className
        )}
        {...rest}
      >
        {children ?? href.slice(ARTIFACT_SCHEME.length)}
      </a>
      {failed && (
        <span className="ml-1 text-xs text-red-500">
          {failedMsg || t("sessions.artifactLinkFailed")}
        </span>
      )}
    </>
  );
}
