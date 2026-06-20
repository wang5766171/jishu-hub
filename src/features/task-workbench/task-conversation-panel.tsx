import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Bot,
  CircleDot,
  ClipboardList,
  RefreshCw,
  Target,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { InteractionComposer } from "@/components/sessions/interaction-composer";
import { MarkdownText } from "@/components/sessions/conversation-content";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  ConversationInteractionRequest,
  ConversationInteractionSubmission,
} from "@/types";

interface TaskConversationSummary {
  graph_id: string;
  title: string;
  original_goal: string;
  project_root: string;
  owner_agent_id: string;
  run_id: string | null;
  phase: string;
  current_node_id: string | null;
  current_node_title: string | null;
  completed_nodes: number;
  total_nodes: number;
  pending_interaction_count: number;
  updated_at: number;
}

interface TaskConversationEntry {
  entry_id: string;
  sequence: number;
  occurred_at: number;
  phase: string;
  node_id: string | null;
  actor: string;
  kind: string;
  payload: Record<string, unknown>;
}

interface TaskInteractionRequest {
  request_id: string;
  node_id: string | null;
  prompt: string;
  options: Array<{
    option_id: string;
    label: string;
    description: string | null;
  }>;
  allow_multiple: boolean;
  allow_custom_text: boolean;
  required: boolean;
}

interface TaskConversationDetail {
  summary: TaskConversationSummary;
  entries: TaskConversationEntry[];
  pending_interactions: TaskInteractionRequest[];
}

interface TaskConversationPanelProps {
  graphId: string;
  selectedNodeId?: string | null;
  onClose: () => void;
  className?: string;
  leadingContent?: ReactNode;
}

function interactionForComposer(
  request: TaskInteractionRequest,
): ConversationInteractionRequest {
  return {
    requestId: request.request_id,
    prompt: request.prompt,
    options: request.options.map((option) => ({
      optionId: option.option_id,
      label: option.label,
      description: option.description ?? undefined,
    })),
    allowMultiple: request.allow_multiple,
    allowCustomText: request.allow_custom_text,
    required: request.required,
  };
}

function entryText(entry: TaskConversationEntry): string {
  const text = entry.payload.text;
  if (typeof text === "string") return text;
  const description = entry.payload.description;
  if (typeof description === "string") return description;
  const message = entry.payload.message;
  if (typeof message === "string") return message;
  return "";
}

export function TaskConversationPanel({
  graphId,
  selectedNodeId,
  onClose,
  className,
  leadingContent,
}: TaskConversationPanelProps) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<TaskConversationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<TaskConversationDetail>(
        "orchestrator_get_task_conversation",
        { graphId, afterSequence: 0 },
      );
      setDetail(next);
      setError(null);
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      setLoading(false);
    }
  }, [graphId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1200);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const visibleEntries = useMemo(() => {
    const entries = detail?.entries ?? [];
    if (!selectedNodeId) return entries;
    return entries.filter(
      (entry) => entry.node_id === selectedNodeId || entry.node_id === null,
    );
  }, [detail?.entries, selectedNodeId]);

  const activeInteraction = useMemo(() => {
    const pending = detail?.pending_interactions ?? [];
    return (
      pending.find((request) => request.node_id === selectedNodeId) ??
      pending.find((request) => request.node_id === null) ??
      pending[0] ??
      null
    );
  }, [detail?.pending_interactions, selectedNodeId]);

  const submitInteraction = useCallback(
    async (submission: ConversationInteractionSubmission) => {
      await invoke("orchestrator_submit_task_interaction", {
        requestId: submission.requestId,
        submission: {
          selected_option_ids: submission.selectedOptionIds,
          custom_text: submission.customText || null,
        },
      });
      await refresh();
    },
    [refresh],
  );

  const summary = detail?.summary;

  return (
    <aside
      className={cn(
        "flex h-full w-[23rem] shrink-0 flex-col border-l border-border/70 bg-card",
        className,
      )}
    >
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <ClipboardList className="size-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">
              {t("tasks.conversation.title")}
            </h2>
            <p className="truncate text-[11px] text-muted-foreground">
              {selectedNodeId
                ? t("tasks.conversation.nodeContext")
                : t("tasks.conversation.taskContext")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            onClick={() => void refresh()}
            aria-label={t("tasks.refresh")}
          >
            <RefreshCw className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
            aria-label={t("tasks.close")}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {summary && (
        <div className="space-y-2 border-b border-border/60 bg-muted/20 px-4 py-3 text-xs">
          <div className="flex items-center gap-2">
            <CircleDot className="size-3.5 text-primary" />
            <span className="font-medium">
              {t(`tasks.conversation.phases.${summary.phase}`)}
            </span>
            <span className="ml-auto text-muted-foreground">
              {summary.completed_nodes}/{summary.total_nodes}
            </span>
          </div>
          <div className="flex items-start gap-2 text-muted-foreground">
            <Bot className="mt-0.5 size-3.5 shrink-0" />
            <span>{t("tasks.conversation.fixedAgent")}</span>
          </div>
          <div className="flex items-start gap-2 text-muted-foreground">
            <Target className="mt-0.5 size-3.5 shrink-0" />
            <span className="line-clamp-3">{summary.original_goal}</span>
          </div>
          {summary.current_node_title && (
            <div className="rounded-md bg-primary/8 px-2.5 py-2 text-foreground">
              {t("tasks.conversation.currentNode", {
                node: summary.current_node_title,
              })}
            </div>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {leadingContent}
        {loading && !detail ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : visibleEntries.length === 0 ? (
          <p className="text-sm leading-6 text-muted-foreground">
            {t("tasks.conversation.noVisibleEvents")}
          </p>
        ) : (
          visibleEntries.map((entry) => {
            const text = entryText(entry);
            return (
              <article
                key={entry.entry_id}
                className="rounded-xl border border-border/70 bg-background px-3 py-2.5"
              >
                <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                  <span>{t(`tasks.conversation.entries.${entry.kind}`)}</span>
                  <span>{entry.actor === "user" ? t("sessions.user") : "Jishu Agent"}</span>
                </div>
                {text && (
                  <div className="mt-1.5 text-xs leading-5 text-foreground">
                    <MarkdownText text={text} />
                  </div>
                )}
              </article>
            );
          })
        )}
      </div>

      {activeInteraction && (
        <div className="border-t border-border/70 p-3">
          <InteractionComposer
            request={interactionForComposer(activeInteraction)}
            onSubmit={submitInteraction}
          />
        </div>
      )}
    </aside>
  );
}
