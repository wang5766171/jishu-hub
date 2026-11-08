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

/** 共享处理器：校验（validate_preview_file）通过才发 file-preview-request。 */
export async function openArtifactReference(
  href: string,
  ctx: SessionArtifactCtx,
): Promise<{ ok: boolean; error?: string }> {
  const rel = href.slice(ARTIFACT_SCHEME.length);
  if (!rel) return { ok: false, error: "empty" };
  const abs = resolveAgainstProject(rel, ctx.projectPath);
  if (!ctx.projectPath) {
    return { ok: false, error: "no-project" };
  }
  try {
    await invokeCommand<PreviewKindResult>("validate_preview_file", {
      path: abs,
      projectRoot: ctx.projectPath,
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
          "cursor-pointer underline decoration-dotted underline-offset-2",
          failed ? "text-red-500" : "text-[var(--icon-action)]",
          className
        )}
        {...rest}
      >
        {children ?? href.slice(ARTIFACT_SCHEME.length)}
      </a>
      {failed && (
        <span className="ml-1 text-xs text-red-500">{t("sessions.artifactLinkFailed")}</span>
      )}
    </>
  );
}
