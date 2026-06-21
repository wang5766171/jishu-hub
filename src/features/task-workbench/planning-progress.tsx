import { useCallback, useMemo, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { ChatInput } from "@/components/sessions/chat-input";
import { MessageView } from "@/components/sessions/message-view";
import type { Message } from "@/types";
import type { PlanningProgress } from "./use-task-graph";

interface PlanningProgressOverlayProps {
  progress: PlanningProgress;
  text?: string;
  projectPath?: string | null;
  turnActive?: boolean;
  onSubmitMessage?: (message: string) => void | Promise<void>;
}

export function PlanningProgressOverlay({
  progress,
  text,
  projectPath,
  turnActive = false,
  onSubmitMessage,
}: PlanningProgressOverlayProps) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [steerMessages, setSteerMessages] = useState<string[]>([]);
  const acceptsInput = progress.stage !== "completed" && progress.stage !== "failed";

  const messages = useMemo<Message[]>(() => {
    const next: Message[] = [];
    if (text?.trim()) {
      next.push({
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: null,
      });
    } else {
      next.push({
        role: "assistant",
        content: [{ type: "text", text: t("tasks.workbench.planningProgress.description") }],
        timestamp: null,
      });
    }
    for (const message of steerMessages) {
      next.push({
        role: "user",
        content: [{ type: "text", text: message }],
        timestamp: null,
      });
    }
    return next;
  }, [steerMessages, t, text]);

  const handleGuideStaged = useCallback(async (content: string) => {
    setError(null);
    try {
      await invoke("orchestrator_steer_planner", { message: content });
      setSteerMessages((current) => [...current, content]);
    } catch (guideError) {
      setError(String(guideError));
      throw guideError;
    }
  }, []);

  const handleStop = useCallback(async () => {
    await invoke("orchestrator_stop_planner_turn");
  }, []);

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex shrink-0 items-center gap-3 border-b border-border/70 bg-muted/30 px-6 py-3">
        {turnActive && <LoaderCircle className="size-4 animate-spin text-primary" />}
        <div className="min-w-0 flex-1">
          <span className="text-sm font-medium text-foreground">
            {t(`tasks.workbench.planningProgress.stages.${progress.stage}`)}
          </span>
          {progress.attempt && progress.max_attempts ? (
            <span className="ml-3 text-xs text-muted-foreground">
              {t("tasks.workbench.planningProgress.attempt", {
                current: progress.attempt,
                total: progress.max_attempts,
              })}
            </span>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-4">
        <MessageView messages={messages} flat />
      </div>

      <div className="shrink-0 border-t border-border/70 bg-background/95">
        {error ? (
          <p className="mx-auto max-w-[var(--message-content-max-width)] px-4 pt-3 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <ChatInput
          sessionId={`task-planning-${progress.graph_id}`}
          projectPath={projectPath ?? ""}
          allowFiles={false}
          agentDisplayName="Jishu Agent"
          disabled={!acceptsInput}
          isSessionStreaming={turnActive}
          placeholder={t("tasks.workbench.planningProgress.steerPlaceholder")}
          onSubmitMessage={async (message) => {
            await onSubmitMessage?.(message);
          }}
          onGuideStaged={handleGuideStaged}
          onAbort={handleStop}
        />
      </div>
    </div>
  );
}
