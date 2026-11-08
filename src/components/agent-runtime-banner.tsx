/**
 * v0.9.7 需求1 T5：pi 版本变更横幅（Q2 裁决：软提示 + 不可关闭、持续显眼）。
 *
 * - 启动拉 `agent_runtime_status`：`mismatch` 且不在初始化中 → 顶部横幅
 *   「智能体引擎有新版本（{expected}）」+「一键更新」；**无关闭按钮**——
 *   不更新就一直在，但**不拦截**任何会话操作（软提示）。
 * - `init-running`（首装/启动钩子在跑）：展示阶段进度行（解压/复制/装扩展），
 *   消费 `agent-runtime-progress` 事件；需求4 引导页落地前这是首装的进度出口。
 * - 一键更新 → `agent_runtime_init`（幂等）→ 完成后横幅短暂切换
 *   「已更新，新会话生效」再消失。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { RefreshCw } from "lucide-react";
import { invokeCommand } from "@/hooks/use-invoke";
import { cn } from "@/lib/utils";

interface AgentRuntimeStatus {
  state: "ready" | "init_running" | "mismatch";
  recorded: string | null;
  expected: string;
}

type BannerState =
  | { kind: "mismatch"; expected: string; stage: string | null }
  | { kind: "running"; stage: string | null }
  | { kind: "done"; expected: string };

export function AgentRuntimeBanner() {
  const { t } = useTranslation();
  const [banner, setBanner] = useState<BannerState | null>(null);
  const [updating, setUpdating] = useState(false);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const status = await invokeCommand<AgentRuntimeStatus>("agent_runtime_status");
        if (cancelled) return;
        if (status.state === "mismatch") {
          setBanner({ kind: "mismatch", expected: status.expected, stage: null });
        } else if (status.state === "init_running") {
          setBanner({ kind: "running", stage: null });
        } else {
          setBanner(null);
        }
      } catch {
        // 状态命令失败不打扰用户（横幅是增强信息，不是门禁）。
      }
    };
    void refresh();
    // 更新进行中周期对账（事件驱动为主，轮询兜底 5s）。
    const poll = setInterval(() => {
      if (!cancelled && (banner === null || banner.kind !== "done")) void refresh();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
    // banner 故意不入依赖：轮询闭包内读最新即可，避免重建定时器。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 进度事件：更新/首装期间展示阶段。
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listen<{ stage: string; detail: string }>("agent-runtime-progress", (event) => {
      if (cancelled) return;
      setBanner((prev) => {
        if (!prev || prev.kind === "done") return prev;
        return { ...prev, stage: event.payload.stage } as BannerState;
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (doneTimer.current) clearTimeout(doneTimer.current);
    };
  }, []);

  const handleUpdate = async () => {
    if (updating) return;
    setUpdating(true);
    try {
      await invokeCommand<string>("agent_runtime_init");
      const status = await invokeCommand<AgentRuntimeStatus>("agent_runtime_status");
      if (status.state === "ready") {
        const expected = status.expected;
        setBanner({ kind: "done", expected });
        doneTimer.current = setTimeout(() => setBanner(null), 4000);
      }
      // 非 ready（如启动钩子仍在跑）：轮询对账会接管横幅状态。
    } catch {
      // 失败保持 mismatch 横幅（不可关闭语义：下次启动仍在），按钮可重试。
    } finally {
      setUpdating(false);
    }
  };

  if (!banner) return null;

  const stage = banner.kind === "done" ? null : banner.stage;
  const stageText =
    stage === "extract"
      ? t("agentRuntime.stageExtract")
      : stage === "install"
        ? t("agentRuntime.stageInstall")
        : stage === "extensions"
          ? t("agentRuntime.stageExtensions")
          : null;

  return (
    <div
      className="flex items-center gap-2 px-4 h-8 border-b text-xs shrink-0"
      style={{
        background: "var(--color-warning-bg, rgba(234,179,8,0.12))",
        borderColor: "var(--color-warning-border, rgba(234,179,8,0.35))",
      }}
    >
      <RefreshCw className={cn("h-3.5 w-3.5 shrink-0", updating && "animate-spin")} />
      {banner.kind === "mismatch" && (
        <>
          <span className="flex-1 truncate text-foreground/90">
            {t("agentRuntime.bannerText", { expected: banner.expected })}
          </span>
          <button
            onClick={handleUpdate}
            disabled={updating}
            className={cn(
              "shrink-0 rounded px-2.5 py-0.5 text-xs font-medium transition-fast",
              "bg-foreground/90 text-background hover:bg-foreground",
              updating && "opacity-60 cursor-not-allowed"
            )}
          >
            {updating ? (stageText ?? t("agentRuntime.updating")) : t("agentRuntime.updateNow")}
          </button>
        </>
      )}
      {banner.kind === "running" && (
        <span className="flex-1 truncate text-foreground/90">
          {stageText ?? t("agentRuntime.initializing")}
        </span>
      )}
      {banner.kind === "done" && (
        <span className="flex-1 truncate text-foreground/90">
          {t("agentRuntime.updatedToast", { expected: banner.expected })}
        </span>
      )}
    </div>
  );
}
