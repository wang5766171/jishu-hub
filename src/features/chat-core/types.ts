/**
 * 共享会话核心层类型定义。
 *
 * 设计依据：`任务入口与容器架构设计_20260622.md` §2.3、§11。
 *
 * 本层是通用会话 hook 的类型契约，供 chat-page、TaskPhaseContainer 的需求/规划/节点
 * 子代理阶段统一消费。约束：本层不得出现任何任务语义（task/phase/requirement/node），
 * 阶段差异只能通过 useChatSession 的声明式入参表达。
 */
import type { ContentBlock, Message } from "@/types";
import type { InteractionSplit, StreamToolUse, StepInfo } from "@/hooks/use-stream-store";

/**
 * 准备发送的消息。`prepareMessage` 回调的返回值，允许调用方注入阶段专属的隐藏指令。
 *
 * `visible` 是展示给用户看的文本（不包含隐藏指令），`agent` 是实际发给 agent 的文本
 * （含隐藏指令）。当无需隐藏指令时，二者相同。
 */
export interface PreparedMessage {
  visible: string;
  agent: string;
}

/**
 * 待处理的交互式问答请求（从 agent 事件流解析而来）。
 *
 * 通用会话契约，不含任务语义。具体来源由 useChatSession 内部从 agent-event 解析。
 */
export interface PendingChatInteraction {
  requestId: string;
  prompt: string;
  options: Array<{ optionId: string; label: string; description?: string | null }>;
  origin: string;
  transport: string;
  deliveryHint: "follow_up" | "mid_turn" | null;
  allowCustomText: boolean;
  allowMultiple: boolean;
  required: boolean;
}

/**
 * 待处理的工具/权限审批请求。
 */
export interface PendingChatApproval {
  requestId: string;
  toolName: string;
  input?: unknown;
  summary: string;
}

/**
 * 交互式问答的提交值。
 */
export interface InteractionSubmission {
  selectedOptionIds: string[];
  customText: string | null;
}

/**
 * useChatSession 的入参选项。
 *
 * 所有"阶段差异"必须通过这里的字段表达，hook 内部不得出现 task/phase/node 分支。
 */
export interface UseChatSessionOptions {
  /** 当前会话 id（真实 session id，必须非空）。切换 session 时改变此值即可。 */
  sessionId: string;
  /** 项目根路径（send_message 命令需要）。 */
  projectPath: string;
  /** 项目编码名（用于 get_session_messages 等）。 */
  encodedProjectId?: string;
  /**
   * 智能体 id（v0.7.0 需求一：send_message / get_session_messages 等 IPC 必填）。
   * 常规会话由消费方传入会话作用域的 chatAgentId；任务阶段/节点会话传入对应 agent_id。
   */
  agentId: string;
  /** 是否只读（回溯历史阶段时为 true）。只读时禁用发送与交互提交。 */
  readOnly: boolean;
  /** 发送前的消息预处理（注入阶段专属隐藏指令）。不传则 visible === agent。 */
  prepareMessage?: (message: string) => PreparedMessage;
  /** session 解析为真实 id 后的回调（pending → real）。 */
  onSessionResolved?: (realSessionId: string) => void;
  /**
   * 一轮 agent turn 流式结束后的回调（isStreaming 由 true→false）。
   * 用于阶段推进同步：conductor 在 turn 内调 conductor_sync_phase 推进 current_phase，
   * turn 结束即已落库，消费方可在此刷新任务实例以感知阶段变化。
   */
  onTurnComplete?: () => void;
  /** 交互式问答提交后的回调（用于阶段推进，如需求定稿、生成流程图）。 */
  onInteractionSubmit?: (submission: InteractionSubmission, interaction: PendingChatInteraction) => void;
}

/**
 * 流式输出状态（聚合自 streamStore）。
 */
export interface ChatStreamState {
  /** 流式内容块（实时）。 */
  content: ContentBlock[];
  /** 纯文本（实时）。 */
  text: string;
  /** 思考链（实时）。 */
  thinking: string;
  /** 工具调用列表。 */
  tools: StreamToolUse[];
  /** 编排步骤。 */
  steps: StepInfo[];
  /** 嵌入的交互问答。 */
  interactionSplits: InteractionSplit[];
  /** 是否正在流式。 */
  isStreaming: boolean;
  /** 错误信息。 */
  error: string;
}

/**
 * useChatSession 对外暴露的统一会话状态与动作。
 */
export interface ChatSessionState {
  /** 当前 session id（可能与传入的 pending id 不同，已解析为真实 id）。 */
  sessionId: string;
  /** 是否只读。 */
  readOnly: boolean;
  /** 已加载的历史消息（JSONL）。 */
  messages: Message[];
  /** 流式输出状态（null 表示无活跃流）。 */
  stream: ChatStreamState | null;
  /** 待处理的交互问答。 */
  pendingInteractions: PendingChatInteraction[];
  /** 待处理的审批。 */
  pendingApprovals: PendingChatApproval[];
  /** 是否正在加载历史消息。 */
  loadingMessages: boolean;
  /** 是否可以发送（非只读且有 session）。 */
  canSend: boolean;

  /** 发送消息（内部经 prepareMessage 处理后委托给底层发送链路）。 */
  send: (message: string) => Promise<void>;
  /** 停止当前流。 */
  stop: () => Promise<void>;
  /** 提交交互式问答。 */
  respondInteraction: (submission: InteractionSubmission) => Promise<void>;
  /** 审批决策。 */
  resolveApproval: (requestId: string, approved: boolean) => Promise<void>;
  /** 刷新历史消息。 */
  refreshMessages: () => Promise<void>;
}
