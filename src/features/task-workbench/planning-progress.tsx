import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, Send, Square, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import type { PlanningProgress } from "./use-task-graph";
import { MarkdownText } from "@/components/sessions/conversation-content";
import { MessageStaging, type StagedMessage } from "@/components/sessions/message-staging";

interface PlanningProgressOverlayProps {
  progress: PlanningProgress;
  text?: string;
  onCancel?: () => void;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function PlanningProgressOverlay({
  progress,
  text,
  onCancel,
}: PlanningProgressOverlayProps) {
  const { t } = useTranslation();
  const [inputText, setInputText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [steerMessages, setSteerMessages] = useState<string[]>([]);
  const [staged, setStaged] = useState<StagedMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [text, steerMessages, staged]);

  const isActive = progress.stage !== "completed" && progress.stage !== "failed";

  // Stage a message (don't send yet — user can edit/delete/guide later).
  const handleStageInput = () => {
    const msg = inputText.trim();
    if (!msg) return;
    setStaged((prev) => [...prev, { id: crypto.randomUUID(), content: msg }]);
    setInputText("");
  };

  // Send a staged message as steer (guide the agent mid-turn).
  const handleGuideStaged = useCallback(async (id: string, content: string) => {
    setError(null);
    try {
      await invoke("orchestrator_steer_planner", { message: content });
      setStaged((prev) => prev.filter((m) => m.id !== id));
      setSteerMessages((prev) => [...prev, content]);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const handleStop = () => {
    if (onCancel) {
      onCancel();
    }
  };

  // Build conversation view.
  const messages: ChatMessage[] = [];
  let agentText = "";

  if (text) {
    const segments = steerMessages.length > 0 ? Math.max(1, steerMessages.length) : 1;
    const textPerSegment = Math.ceil(text.length / segments);
    for (let i = 0; i < steerMessages.length; i++) {
      const segText = text.slice(i * textPerSegment, (i + 1) * textPerSegment);
      if (segText.trim()) messages.push({ role: "assistant", content: segText });
      messages.push({ role: "user", content: steerMessages[i] });
    }
    const remaining = text.slice(steerMessages.length * textPerSegment);
    if (remaining.trim()) agentText = remaining;
  }
  if (!text && steerMessages.length > 0) {
    for (const msg of steerMessages) messages.push({ role: "user", content: msg });
  }

  // Determine button: if input has content → "发送" (stage); else → "停止" (stop).
  const hasInput = inputText.trim().length > 0;

  return (
    <div className="flex h-full w-full flex-col bg-background">
      {/* Compact header — stage indicator */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border/70 bg-muted/30 px-6 py-3">
        {isActive && <LoaderCircle className="size-4 animate-spin text-primary" />}
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

      {/* Conversation stream */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.length === 0 && !text?.trim() && (
            <div className="flex gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-purple-500/15 text-purple-500">
                <span className="text-xs font-bold">J</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="mb-1 text-xs text-muted-foreground">Jishu Agent</p>
                <div className="text-sm leading-6 text-muted-foreground">
                  {t("tasks.workbench.planningProgress.description")}
                </div>
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <ConversationBubble key={i} message={msg} />
          ))}

          {agentText.trim() && (
            <ConversationBubble
              message={{ role: "assistant", content: agentText }}
              streaming={isActive}
            />
          )}
        </div>
      </div>

      {/* Input area — same visual style as regular chat */}
      <div className="shrink-0 border-t border-border/70 bg-background px-6 py-3">
        <div className="mx-auto max-w-3xl space-y-2">
          {error && <p className="text-xs text-destructive">{error}</p>}

          {/* Staging area */}
          <MessageStaging
            messages={staged}
            onEdit={(id, content) =>
              setStaged((prev) =>
                prev.map((m) => (m.id === id ? { ...m, content } : m)),
              )
            }
            onDelete={(id) => setStaged((prev) => prev.filter((m) => m.id !== id))}
            onSend={handleGuideStaged}
            sendLabel={t("tasks.workbench.planningProgress.steer")}
          />

          {/* Input row */}
          <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-card px-4 py-2.5 shadow-sm">
            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (hasInput && isActive) handleStageInput();
                }
              }}
              disabled={!isActive}
              rows={1}
              placeholder={t("tasks.workbench.planningProgress.steerPlaceholder")}
              className="min-h-[1.5rem] max-h-32 flex-1 resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-muted-foreground disabled:opacity-50"
            />
            {/* Toggle: Send (stage) when input has content; Stop when empty */}
            {hasInput ? (
              <button
                type="button"
                onClick={handleStageInput}
                disabled={!isActive}
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Send className="size-3.5" />
                {t("sessions.sendMessage")}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleStop}
                disabled={!isActive}
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-4 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Square className="size-3 fill-current" />
                {t("tasks.workbench.planningProgress.stop")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ConversationBubble({
  message,
  streaming = false,
}: {
  message: ChatMessage;
  streaming?: boolean;
}) {
  if (message.role === "user") {
    return (
      <div className="flex gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <User className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-xs text-muted-foreground">你</p>
          <div className="rounded-xl rounded-tl-none border border-border/70 bg-muted/40 px-4 py-2.5 text-sm leading-6 text-foreground">
            {message.content}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-purple-500/15 text-purple-500">
        <span className="text-xs font-bold">J</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-xs text-muted-foreground">
          Jishu Agent
          {streaming && (
            <LoaderCircle className="ml-1.5 inline size-3 animate-spin text-primary" />
          )}
        </p>
        <div className="overflow-hidden text-sm leading-6 text-foreground">
          <MarkdownText text={message.content} />
        </div>
      </div>
    </div>
  );
}
