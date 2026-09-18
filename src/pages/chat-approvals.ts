/**
 * 会话审批/交互队列（v0.9.3 需求10 A4：自 chat-page 剥离——纯搬迁零行为
 * 变化；需求13 C4 融合方向：经 SessionDataHub 审批面发布，插件（审批中心
 * 类组合插件）可消费）。
 */
import { useCallback, useState } from "react";
import type { MutableRefObject } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import { streamStore } from "@/hooks/use-stream-store";
import {
  formatInteractionReply,
  formatInteractionResponseValue,
} from "@/lib/conversation-interaction";
import type { InteractionResponseDto, ConversationInteractionSubmission } from "@/types";
import type { PendingChatApproval, PendingChatInteraction } from "./chat-page-utils";

export function useChatApprovals(deps: {
  selectedSession: string | null;
  handleMessageSent: (sid: string, msg: string) => void;
  activeIdRef: MutableRefObject<string | null>;
  projectPathRef: MutableRefObject<string | null>;
}) {
  const { selectedSession, handleMessageSent, activeIdRef, projectPathRef } = deps;
  const [pendingApprovals, setPendingApprovals] = useState<PendingChatApproval[]>([]);
  const [pendingInteractions, setPendingInteractions] = useState<PendingChatInteraction[]>([]);
  const [approvalResolving, setApprovalResolving] = useState(false);

  const activeApproval = pendingApprovals[0] ?? null;
  // 审批类型 → 弹窗描述文案（后端按工具分类：bash→命令、write/edit→文件写入；
  // wire 值 PascalCase，兼容 snake_case 历史值）。
  const approvalKindRaw = (activeApproval?.approvalKind ?? "").toLowerCase();
  const approvalDescKey =
    approvalKindRaw === "command"
      ? "sessions.permissionDescCommand"
      : approvalKindRaw === "filewrite" || approvalKindRaw === "file_write"
        ? "sessions.permissionDescFileWrite"
        : "sessions.permissionDescOther";
  // v0.7.0 需求二：节点会话的 interaction 来自节点子代理（agent_id 可能是非 activeId
  // 的 claude-code/codex 等）。匹配只按 sessionId（已唯一标识会话），不限制 agentId，
  // 否则节点执行阶段的 agent 问答无法显示和提交。
  const activeInteraction = pendingInteractions.find(
    (item) => item.sessionId === selectedSession,
  ) ?? null;
  const handleInteractionSubmit = useCallback(async (
    submission: ConversationInteractionSubmission,
  ) => {
    // v0.7.0 需求二：节点会话 interaction 匹配只按 sessionId + requestId（不限制 agentId）。
    const interaction = pendingInteractions.find(
      (item) =>
        item.sessionId === selectedSession
        && item.request.requestId === submission.requestId,
    );
    if (!interaction) return;

    const matchesInteraction = (item: PendingChatInteraction) =>
      item.agentId === interaction.agentId
      && item.sessionId === interaction.sessionId
      && item.request.requestId === submission.requestId;
    const value = formatInteractionResponseValue(interaction.request, submission);
    const checkpoint = streamStore.recordInteractionResponseWithCheckpoint(
      interaction.sessionId,
      submission.requestId,
      value,
      submission.selectedOptionIds,
    );
    const restorePending = () =>
      setPendingInteractions((current) =>
        current.some(matchesInteraction) ? current : [...current, interaction],
      );

    // Hide the panel immediately; restored below on failure.
    setPendingInteractions((current) => current.filter((item) => !matchesInteraction(item)));

    // Hand the answer to the backend along with the interaction's origin. The
    // backend takes the AUTHORITATIVE delivery decision from the process's
    // actual transport (design R6 — never assume mid-turn from the event hint).
    let result: InteractionResponseDto | null = null;
    try {
      result = await invokeCommand<InteractionResponseDto>("respond_chat_interaction", {
        sessionId: interaction.sessionId,
        requestId: submission.requestId,
        value,
        interaction: {
          request_id: submission.requestId,
          prompt: interaction.request.prompt,
          options: interaction.request.options.map((option) => ({
            option_id: option.optionId,
            label: option.label,
            description: option.description ?? null,
          })),
          answer: value,
          selected_options: submission.selectedOptionIds,
          origin: interaction.request.origin ?? null,
        },
        origin: interaction.request.origin,
      });
    } catch (error) {
      streamStore.rollbackInteractionResponse(checkpoint);
      restorePending();
      throw error;
    }

    const delivery = result?.delivery ?? "follow_up";

    if (delivery === "mid_turn") {
      // The answer was recorded before IPC so a TurnComplete released by the
      // extension_ui_response cannot commit an unanswered interaction.
      return;
    }

    // Follow-up: this transport cannot answer mid-turn as a business question.
    // Remove the inline placeholder (no phantom gap) and deliver the answer as
    // a new user message — the design's safety net for transports without
    // mid-turn reachability (CLI, capability-absent downgrade, opencode).
    streamStore.removeInteractionSplit(interaction.sessionId, submission.requestId);
    const replyText = formatInteractionReply(interaction.request, submission).trim();
    if (!replyText) return;

    // Mirror the standard send path: register a new turn's stream, snapshot the
    // session cache, then dispatch send_message. The prior turn is persisted to
    // the session JSONL and re-rendered from history on completion.
    streamStore.start(interaction.sessionId, replyText);
    handleMessageSent(interaction.sessionId, replyText);
    try {
      await invokeCommand("send_message", {
        agentId: activeIdRef.current ?? "",
        projectPath: projectPathRef.current ?? "",
        sessionId: interaction.sessionId,
        message: replyText,
      });
    } catch (sendError) {
      console.error("Failed to send interaction follow-up message:", sendError);
      streamStore.end(interaction.sessionId);
      restorePending();
    }
  }, [
    handleMessageSent,
    pendingInteractions,
    selectedSession,
  ]);
  const resolveActiveApproval = useCallback(async (approved: boolean, remember = false) => {
    if (!activeApproval || approvalResolving) return;
    setApprovalResolving(true);
    try {
      await invokeCommand("resolve_chat_permission", {
        sessionId: activeApproval.sessionId,
        requestId: activeApproval.requestId,
        approved,
        remember,
      });
      setPendingApprovals((current) =>
        current.filter(
          (item) =>
            item.sessionId !== activeApproval.sessionId
            || item.requestId !== activeApproval.requestId,
        ),
      );
    } catch (error) {
      console.error("Failed to resolve ACP permission request:", error);
    } finally {
      setApprovalResolving(false);
    }
  }, [activeApproval, approvalResolving]);
  return {
    pendingApprovals,
    setPendingApprovals,
    pendingInteractions,
    setPendingInteractions,
    approvalResolving,
    activeApproval,
    approvalDescKey,
    activeInteraction,
    handleInteractionSubmit,
    resolveActiveApproval,
  };
}
