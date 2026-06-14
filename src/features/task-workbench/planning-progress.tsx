import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Send, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import type { PlanningProgress } from "./use-task-graph";
import { MarkdownText } from "@/components/sessions/conversation-content";

interface PlanningProgressOverlayProps {
  progress: PlanningProgress;
  text?: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function PlanningProgressOverlay({
  progress,
  text,
}: PlanningProgressOverlayProps) {
  const { t } = useTranslation();
  const [steerText, setSteerText] = useState("");
  const [steerError, setSteerError] = useState<string | null>(null);
  const [steerMessages, setSteerMessages] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new content arrives.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [text, steerMessages]);

  const handleSteer = async () => {
    const msg = steerText.trim();
    if (!msg) return;
    setSteerError(null);
    try {
      await invoke("orchestrator_steer_planner", { message: msg });
      setSteerMessages((prev) => [...prev, msg]);
      setSteerText("");
    } catch (err) {
      setSteerError(String(err));
    }
  };

  // Build conversation messages: agent text chunks + user steer messages,
  // interleaved by position. Agent text is one growing message; user steer
  // messages appear before subsequent agent text.
  // Strategy: show previous text segments split by user steer points.
  const messages: ChatMessage[] = [];
  let agentText = "";
  let steerIdx = 0;

  if (text) {
    // Find where the text was when each steer message was sent.
    // Since we can't precisely track insertion points, we show agent text
    // up to the current position, with user messages before new text.
    const segments = steerMessages.length > 0 ? Math.max(1, steerMessages.length) : 1;
    const textPerSegment = Math.ceil(text.length / segments);
    for (let i = 0; i < steerMessages.length; i++) {
      const segText = text.slice(i * textPerSegment, (i + 1) * textPerSegment);
      if (segText.trim()) {
        messages.push({ role: "assistant", content: segText });
      }
      messages.push({ role: "user", content: steerMessages[i] });
      steerIdx = i + 1;
    }
    // Remaining text after last steer
    const remaining = text.slice(steerIdx * textPerSegment);
    if (remaining.trim()) {
      agentText = remaining;
    }
  }
  // If no text yet but we have steer messages, show them
  if (!text && steerMessages.length > 0) {
    for (const msg of steerMessages) {
      messages.push({ role: "user", content: msg });
    }
  }
  // Initial empty agent placeholder
  if (messages.length === 0 && !agentText) {
    agentText = "";
  }

  const isActive = progress.stage !== "completed" && progress.stage !== "failed";

  return (
    <div className="flex h-full w-full flex-col bg-background">
      {/* Compact header — stage indicator */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border/70 bg-muted/30 px-6 py-3">
        <LoaderCircle className="size-4 animate-spin text-primary" />
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
          {/* Initial agent message */}
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

          {/* Render conversation messages */}
          {messages.map((msg, i) => (
            <ConversationBubble key={i} message={msg} />
          ))}

          {/* Current agent output (growing) */}
          {agentText.trim() && (
            <ConversationBubble
              message={{ role: "assistant", content: agentText }}
              streaming={isActive}
            />
          )}
        </div>
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t border-border/70 bg-background px-6 py-3">
        <div className="mx-auto max-w-3xl">
          {steerError && (
            <p className="mb-2 text-xs text-destructive">{steerError}</p>
          )}
          <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-card px-4 py-2.5 shadow-sm">
            <input
              value={steerText}
              onChange={(e) => setSteerText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSteer();
                }
              }}
              placeholder={t("tasks.workbench.planningProgress.steerPlaceholder")}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <button
              type="button"
              onClick={() => void handleSteer()}
              disabled={!steerText.trim() || !isActive}
              className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Send className="size-3.5" />
              {t("tasks.workbench.planningProgress.steer")}
            </button>
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
