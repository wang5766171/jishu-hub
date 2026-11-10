// §12 处置说明（v0.9.5 立案；v0.9.7 需求2 补充执行完毕，2026-11-08）
// ─────────────────────────────────────────────────────────────────────
// 现状：2853 行（v0.9.7 补充前 3440）。三簇预案已全部执行（零逻辑变更纯
// 移动，tsc/vitest/cargo 全绿）：
//   簇A 滚动系统 → use-chat-scroll.ts（218 行：scrollAction 指令消费/
//     贴底跟随/clamp 扩窗/滚动 rAF 节流/活动轮次/横杠跳转）
//   簇B 任务/节点会话加载 → use-task-session-load.ts（166 行：缓存先行/
//     节点 agent_id 重读/空载重试/入口定位/scrollMemory 落盘）
//   簇C 任务执行段 → use-task-execution-stage.ts（363 行：方案卡数据与
//     确认启动/子任务卡数据/失败节点干预/执行段滚动）
// 历史拆分（更早）：kernel/event-pipeline、kernel/data-hub、kernel/
// session-cache、chat-approvals、use-task-instance-sync、use-task-
// session-routing、use-access-mode、use-session-selection、chat-sidebar。
// 剩余为「核心视图 JSX + 会话编排薄壳」——按架构裁决（会话内核+插件宿主+
// 薄壳）不再强拆；后续触碰本文件的新需求仍应先评估能否在钩子层承接。
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useInvoke, invokeCommand } from "@/hooks/use-invoke";
import {
  streamStore,
  useSessionStream,
  useStreamingSessionIds,
} from "@/hooks/use-stream-store";
import { steerCoordinator } from "@/features/session-kernel/kernel/steer-coordinator";
import { devLog } from "@/lib/dev-log";
import { useSyncExternalStore } from "react";
import { MessageView } from "@/components/sessions/message-view";
import { SessionArtifactContext } from "@/components/sessions/artifact-link";
import { SessionPanelLayer } from "@/features/session-kernel/plugins/mounts/session-panel-layer";
import { SessionSidebarLayer } from "@/features/session-kernel/plugins/mounts/session-sidebar-layer";
import { requestPanelActivation, requestPanelClose } from "@/features/session-kernel/shell/panel-activation";
import { closeSessionSidebar } from "@/features/session-kernel/shell/session-sidebar";
import { BlockRenderersProvider } from "@/features/session-kernel/plugins/mounts/use-block-renderers";
import { PluginSignalBridge } from "@/features/session-kernel/plugins/mounts/plugin-signal-bridge";
import { SessionPluginActions } from "@/features/session-kernel/plugins/mounts/session-plugin-actions";
// 5c（v0.9.5 需求1）已回退（2026-09-30 测试期用户裁决）：头部插件快捷区
// 与「能力中心统一调度」冲突——面板类插件默认收在能力中心，不在头部平铺。
// 重新设计的入口形态见需求1 GUI 统一优化（02 §GUI 重设计）。
// 5e/5f（v0.9.5 需求1）：插件快捷执行共享（命令面板 / /plugin 命令）。
import { runPluginQuickAction } from "@/lib/plugin-quick-run";
import { FlowBoardOverlay } from "@/features/task-workspace/board/flow-board-overlay";
import { useTaskInstance } from "@/features/task-instance/use-task-instance";
import { useNodeSession } from "@/features/task-instance/use-node-session";
import { normalizeAgentId, parseRunnerCard } from "@/features/task-instance/types";
import { useEnabledSessionPlugins } from "@/features/session-kernel/plugins/registry";
import { emitSessionSignal, subscribeSessionSignals } from "@/features/session-kernel/signals";
import { SessionDataHub } from "@/features/session-kernel/kernel/data-hub";
import { SessionRailSlot } from "@/features/session-kernel/plugins/mounts/session-rail-slot";
import type {
  SessionKernelContext,
  PluginBlock,
  PluginMessage,
  PluginSearchMatch,
} from "@/features/session-kernel/plugins/types";
import { RenameSessionDialog } from "@/components/sessions/rename-session-dialog";
import { RenameTaskSessionDialog } from "@/components/sessions/rename-task-session-dialog";
import { ChatInput, type ChatInputHandle, type StagedGuideApi } from "@/components/sessions/chat-input";
import { StreamingMessage } from "@/components/sessions/streaming-message";
import { clearImageCache, InlineImages, stripImagePrompt } from "@/components/sessions/inline-image";
// 会话二级树（T3）：侧边栏任务会话区
// 任务模式右侧栏（减法重构：仅渲染任务步骤面板 + 治理面 + 画布，主会话区复用 chat-page）。
// 任务图数据：chat-page 顶层无条件持有（无 graph 时无副作用），主区 run 流与侧边栏共享。
import { useTaskGraph, type NodeRunLookupSource } from "@/features/task-instance/graph/use-task-graph";
// T8-P1 三段合流：执行段的「流程执行」分隔线 + 会话区「是否开始执行」确认卡。
import { PhaseDivider } from "@/components/sessions/conversation-content";
import {
  TaskPlanCard,
  TaskNodeCards,
  TaskStepsCard,
  TaskSummaryCard,
} from "@/features/task-workspace/task-flow-cards";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MessageSquare, X, Pencil, RotateCw, FolderOpen, ArrowRight, ArrowLeftRight, ChevronDown, PictureInPicture2, Cpu,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Suspense } from "react";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { useFileViewer } from "@/components/file-viewer";
import { cn } from "@/lib/utils";
import { openFloatingSession } from "@/lib/floating-window";
import {
  buildInteractionInsertions,
  commitAssistantWithInteractions,
  type InteractionInsertion,
} from "@/lib/deferred-user-message";
import { AgentLogo, AgentSwitcher, useAgent } from "@/agents";
import { logTaskPhaseDebug } from "@/features/task-instance/task-phase-debug";
import { shouldRenderGlobalChatInput } from "./chat-page-layout";
import { useTaskInstanceSync } from "./use-task-instance-sync";
import { useAccessMode } from "./use-access-mode";
import { ChatSidebar } from "./chat-sidebar";
import { useSessionSelection } from "./use-session-selection";
import { useChatScroll } from "./use-chat-scroll";
import { useTaskSessionLoad } from "./use-task-session-load";
import { useTaskExecutionStage } from "./use-task-execution-stage";
import { useTaskSessionRouting } from "./use-task-session-routing";
import { getSessionDraft, setSessionDraft } from "@/lib/input-history";
import { getSessionUsage, setSessionUsage } from "@/lib/session-usage";
import { SessionComposerTrailing } from "@/features/session-kernel/plugins/mounts/session-composer-trailing";
import { UserTextWithPills, useSessionToolNames } from "@/components/sessions/embedded-tools";
import { useModelPicker } from "@/features/chat-core/use-model-picker";
import { useCompaction } from "@/features/chat-core/use-compaction";
import { useMessageSearch } from "@/features/chat-core/use-message-search";
import { ThinkingLevelSelect } from "@/components/sessions/thinking-level-select";
import {
  buildAssistantContentFromStreamState,
  filterInvisibleUserMessages,
  TerminalIcon,
  uniqueSessionsById,
  type TaskLaunchPhase,
} from "./chat-page-utils";
import { type TaskLaunchInstanceSummary } from "@/features/task-instance/types";
import type {
  Message,
  Project,
  ProjectMeta,
  Session,
  SessionSearchResult,
} from "@/types";


export function ChatPage({
  currentProject,
  currentProjectMeta,
  onRefresh,
  sessionNames,
  refetchNames,
  onSwitchProject,
  onProjectSessionsLoadingChange,
  navigateToSession,
  onNavigateAgentModels,
  pipelineLaunch,
  onPipelineLaunchConsumed,
  pluginCreateLaunch,
  onPluginCreateLaunchConsumed,
}: {
  currentProject: Project | null;
  currentProjectMeta?: ProjectMeta;
  onRefresh: () => Promise<number>;
  sessionNames: Record<string, string> | null;
  refetchNames: (silent?: boolean) => Promise<Record<string, string>>;
  onSwitchProject: () => void;
  onProjectSessionsLoadingChange?: (loading: boolean) => void;
  navigateToSession?: string | null;
  /** v0.9.2 需求10：未配置模型时「前往配置」——跳管理页模型设置并
   * 定位到当前会话智能体（agent 切换由 App 层注入）。 */
  onNavigateAgentModels?: () => void;
  /** v0.9.3 需求13 C4-slice2c：pipeline 插件「作为任务启动」（App 层已切
   * jishu agent 与会话页）；key 变化时预填 /jishu-pipeline 命令并聚焦。 */
  pipelineLaunch?: { key: number; pluginId: string; name: string } | null;
  /** 需求9 #8：pipelineLaunch 消费完成回调（App 层清 state，防重挂重预填）。 */
  onPipelineLaunchConsumed?: () => void;
  /** v0.9.7 需求3 C1：描述需求创建插件（App 层已切 jishu agent 与会话页）；
   * key 变化时开新会话并预填创作指令（草稿态可改）。 */
  pluginCreateLaunch?: { key: number; text: string } | null;
  /** 需求9 #8：pluginCreateLaunch 消费完成回调（App 层清 state，防重挂重预填）。 */
  onPluginCreateLaunchConsumed?: () => void;
}) {
  const { t } = useTranslation();
  // v0.7.0 需求一：会话作用域状态（chatAgentId 替代全局 activeId）。
  const { agents, chatAgentId, chatAgent, chatCapabilities: capabilities, setChatAgent, healthLoading } = useAgent();
  // 兼容别名：active / activeId 在本文件大量使用，统一指向会话作用域。
  const activeId = chatAgentId;
  const active = chatAgent;
  const projectId = currentProject?.encoded_name ?? null;
  const projectPathForSettings = currentProject?.path ?? null;
  const supportsModelPicker = active?.config_surface.kind === "model_store"
    ? (active.config_surface.supports_picker ?? false)
    : false;
  // P-3（需求2）：统一权限入口 —— 由 adapter capability（permission_modes）驱动，
  // 提供方决定读写路径：project_settings=agent 项目设置 / hub_tool_mode=Hub 工具模式 /
  // agent_config=agent 自己的配置文件。禁止按 agentId 分支。
  const permissionModes = active?.permission_modes ?? [];
  const permissionModeProvider = active?.permission_mode_provider ?? null;
  // ── M3：访问/权限模式域迁 use-access-mode（三提供方加载/派生/变更保存/
  // 刷新键；置于 modelPicker 之前——其刷新回调引用 refreshAccessMode）。 ──
  const {
    canSwitch: supportsAccessModeSwitch,
    options: accessModeOptions,
    value: accessModeValue,
    label: accessModeLabel,
    approvalAlwaysHidden,
    handleChange: handleAccessModeChange,
    refresh: refreshAccessMode,
  } = useAccessMode({
    activeId,
    permissionModes,
    permissionModeProvider,
    projectPath: projectPathForSettings,
  });
  // 应用内确认/提示弹窗（替代系统原生 confirm/message，样式与应用统一）。
  // 注意：解构必须先于所有把 confirmDialog/alertDialog 写进 useCallback
  // 依赖数组的 handler——依赖数组在渲染期求值，靠后的 const 会触发 TDZ
  // （测试期修复：Cannot access 'alertDialog' before initialization）。
  const { confirm: confirmDialog, alert: alertDialog, dialogNode: confirmDialogNode } = useConfirmDialog();
  // 需求1 A7：thinking 档位当前值（优先取会话内 thinking_level_changed
  // 事件回传的生效值，回退 Hub 持久化值）。候选档位已改由 useModelPicker
  // 按当前模型派生（v0.8.0 需求3 聚合 IPC）。
  const [liveThinkingLevel, setLiveThinkingLevel] = useState<string | null>(null);
  const thinkingLevelValue = liveThinkingLevel ?? active?.thinking_level ?? null;
  const handleThinkingLevelChange = useCallback(async (level: string) => {
    if (!activeId) return;
    setLiveThinkingLevel(level);
    try {
      await invokeCommand("set_agent_thinking_level", {
        agentId: activeId,
        sessionId: selectedSessionRef.current,
        level,
      });
    } catch (err) {
      console.error("Failed to set thinking level:", err);
    }
  }, [activeId]);

  // 切换 agent 时清除会话内生效值（下一轮事件/Hub 持久化值接管显示）。
  useEffect(() => {
    setLiveThinkingLevel(null);
  }, [activeId]);

  // 需求1 A3：上下文压缩（capability CONTEXT_COMPACT 门控）。v0.8.0
  // 需求3：压缩控制域拆分至 use-compaction（IPC 与状态内聚）。
  const supportsCompact = capabilities?.has("CONTEXT_COMPACT") ?? false;
  const compaction = useCompaction(activeId, supportsCompact);
  const { compacting, autoCompaction: autoCompactionPref } = compaction;
  const handleCompactSession = useCallback(async () => {
    devLog("ipc", "手动压缩会话（compact_chat）", { session: selectedSessionRef.current });
    const sessionId = selectedSessionRef.current;
    if (!sessionId || sessionId === "new" || compacting) return;
    try {
      // v0.9.6 需求2：传 agentId/projectPath——无活跃进程的历史会话由后端
      // 先静默连接（resume）再压缩（「先连接会话再压缩」）。
      await compaction.runCompact(sessionId, null, {
        agentId: activeId,
        projectPath: currentProject?.path ?? null,
      });
    } catch (err) {
      console.error("Compact failed:", err);
      void alertDialog({ title: "压缩失败", description: String(err) });
    }
  }, [compacting, alertDialog, compaction, activeId, currentProject]);
  const handleAutoCompactionChange = useCallback(async (enabled: boolean) => {
    if (!activeId) return;
    try {
      await compaction.setAuto(enabled);
    } catch (err) {
      console.error("Set auto compaction failed:", err);
      void alertDialog({ title: "设置自动压缩失败", description: String(err) });
    }
  }, [activeId, alertDialog]);

  // Mid-turn steer (inject guidance without stopping output) is possible for
  // transports with a native steer channel: Pi-RPC (`steer` command, real
  // mid-turn injection + `steer_injected` event) and Codex app-server
  // (`turn/steer`). ACP (claude-code / acp_preferred) has NO mid-turn steer —
  // its `steer_chat` just queues a follow-up prompt for the next turn and
  // never emits `steer_injected`, so the steer UI path (optimistic bubble +
  // turn_complete commit) never fires and the guide is lost. For ACP, guide
  // must fall back to stop+send (handled by chat-input.tsx's default path),
  // which matches ACP's actual "steer = new prompt" semantics.
  const supportsSteer = active?.transport === "pi_rpc" || active?.transport === "codex_app_server";
  // Fresh mirror for the mount-only agent-event listener (whose useEffect deps
  // are [], so it closes over a stale `supportsSteer`). Updated every render.
  const supportsSteerRef = useRef(supportsSteer);
  supportsSteerRef.current = supportsSteer;

  // selectedSession: null or real backend UUID — never fake IDs
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  // 输入历史/草稿作用域（A6）：草稿按 项目+会话 维度，历史按项目维度。
  const draftSessionKey = projectId ? `${projectId}:${selectedSession ?? "new"}` : null;
  const [sessionMessages, setSessionMessages] = useState<Message[]>([]);
  const [renameOpen, setRenameOpen] = useState(false);
  // 正在重命名的任务会话；为 null 时弹窗关闭。用对象引用区分"重命名哪个任务会话"。
  const [renameTaskTarget, setRenameTaskTarget] = useState<TaskLaunchInstanceSummary | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  // 三阶段任务容器（TaskPhaseContainer）状态。唯一任务界面。
  const [taskModeActive, setTaskModeActive] = useState(false);
  // 任务模式下选中的节点（步骤栏高亮 + 主区切换为该节点会话）。null = 未选节点。
  const [taskSelectedNodeId, setTaskSelectedNodeId] = useState<string | null>(null);
  // v0.7.0 需求二-问题3：选中节点会话绑定的 agent_id（节点子代理可能是非 jishu-self，
  // 加载节点会话消息需用此 agent_id 而非主会话的 activeId）。
  const [taskNodeSessionAgentId, setTaskNodeSessionAgentId] = useState<string | null>(null);
  // 任务侧边栏显隐（执行阶段的「显示/隐藏步骤栏」切换，P4c）。需求/规划阶段不显示侧边栏（P4a）。
  const [taskLaunchOpen, setTaskLaunchOpen] = useState(false);
  const [taskLaunchReadOnly, setTaskLaunchReadOnly] = useState(false);
  const [taskLaunchPhase, setTaskLaunchPhase] = useState<TaskLaunchPhase>("requirements");
  const [activeTaskInstanceId, setActiveTaskInstanceId] = useState<string | null>(null);
  const [activeTaskRequirementFile, setActiveTaskRequirementFile] = useState<string | null>(null);
  const [selectedTaskSkillId, setSelectedTaskSkillId] = useState("jishu-conductor-dev");
  // 记录上次已知 status，用于检测变化。
  const lastKnownStatusRef = useRef<string | null>(null);
  const [regularSessionsOpen, setRegularSessionsOpen] = useState(true);

  // v0.8.0 需求3：模型选择域拆分至 use-model-picker——候选/档位来自聚合
  // IPC（get_model_picker_options，Pi 语义解析唯一化在后端），前端解析块
  // 与三份双源（model-types 解析 / PI_THINKING_LEVELS 常量）一并消除。
  const modelPicker = useModelPicker(activeId, supportsModelPicker, () => {
    refreshAccessMode();
  });
  const { options: modelOptions, activeValue: activeModelValue } = modelPicker;
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (modelMenuRef.current?.contains(event.target as Node)) return;
      setModelMenuOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  const messageAreaRef = useRef<HTMLDivElement>(null);
  // v0.9.1 需求5：当前阅读位置所在轮次（scroll-spy），驱动左缘横杠导航轨
  // 高亮，替代原 isUserMessageAbove 上箭头显隐。
  const activeIdRef = useRef<string | null>(activeId);
  const taskLaunchOpenRef = useRef(taskLaunchOpen);
  const taskLaunchPhaseRef = useRef<TaskLaunchPhase>(taskLaunchPhase);
  // 需求9 #4 补：任务首条 goal（prepareTaskLaunchMessage 包装时捕获）——
  // mark_session 建实例即写入标题（单步小任务 agent 不调 update_steps，
  // 步骤上报链不触发，标题会停在默认「新任务」）。
  const taskLaunchGoalRef = useRef<string | null>(null);
  // 阶段标签自动跟随：跟踪上次 current_phase（数据源为 refreshTaskLaunchSessions 的 3s
  // 轮询）。follow effect 据此前进检测；守卫 taskLaunchPhase===prev 同时防跨任务误跟随
  // 与打断手动回看。
  const activeTaskInstanceIdRef = useRef<string | null>(activeTaskInstanceId);
  // v0.7.0：记录当前选中的节点 id，用于短路重复点击（同一节点再点不触发任何逻辑）。
  const taskSelectedNodeIdRef = useRef<string | null>(taskSelectedNodeId);
  taskSelectedNodeIdRef.current = taskSelectedNodeId;
  // v0.7.0：记录上次轮询到的 instance active_run_id，检测 conductor 重试创建新 run。
  const lastInstanceRunIdRef = useRef<string | null>(null);
  // 进入任务模式需切到 Jishu Agent 时置 true：阻止 activeId 变化触发的清理 effect 重置任务模式状态
  const enteringTaskModeRef = useRef(false);
  const activeTaskRequirementFileRef = useRef<string | null>(activeTaskRequirementFile);
  const selectedTaskSkillIdRef = useRef(selectedTaskSkillId);
  // 减法重构：节点选择不再需要跨页面桥接 ref —— TaskSidebar 与任务树同处 chat-page，
  // 统一由 taskSelectedNodeId 这一个受控状态驱动（树高亮 / 侧边栏高亮 / 主区会话）。
  const chatInputRef = useRef<ChatInputHandle>(null);
  // Fresh project path for the agent-event listener (whose useEffect deps are
  // [], so it closes over a stale `currentProject`). Updated every render.
  const projectPathRef = useRef<string | null>(currentProject?.path ?? null);
  projectPathRef.current = currentProject?.path ?? null;
  const projectIdRef = useRef<string | null>(currentProject?.encoded_name ?? null);
  projectIdRef.current = currentProject?.encoded_name ?? null;
  // Imperative handle into ChatInput's staging area — used by Route 2 to
  // auto-send staged guides at turn_complete.
  const stagedApiRef = useRef<StagedGuideApi | null>(null);
  const selectedSessionRef = useRef<string | null>(null);
  // v0.9.2 需求6：最近一次流式解析出的真实 session id（新会话从 "new" 起步时，
  // selectedSession 要等 session_resolved 才回填；任务实例事件到达时用它匹配关联）。
  const lastRealSessionIdRef = useRef<string | null>(null);
  const visitedSessions = useRef(new Set<string>());
  const scrollMemory = useRef(new Map<string, number | "bottom">());
  const sessionMessagesRef = useRef(sessionMessages);
  sessionMessagesRef.current = sessionMessages;
  const newSessionStreamIdsRef = useRef<Set<string>>(new Set());
  // Records when a follow-up streaming state was (re)created for a session at
  // turn_complete — keyed by session id → start timestamp (ms). Covers two cases
  // that both start an empty "thinking" state for a PENDING reply after a turn
  // ends: (1) a manually-guided steer committed as a follow-up (followUpExpected),
  // and (2) Route 2 auto-sending staged guides. Used to detect and ignore a
  // spurious turn_complete that the ACP/agent process emits right after it is
  // (re)launched — before the real reply has begun. Without this guard that
  // early turn_complete drops the freshly-created "thinking" state, leaving a
  // blank gap until the reply's first token arrives.
  const pendingReplyStartedAtRef = useRef<Map<string, number>>(new Map());
  const refetchSessionsRef = useRef<((silent?: boolean) => Promise<Session[]>) | null>(null);
  // Holds the latest handleSelectSession so the navigateToSession effect always
  /**
   * Per-session messages cache. Keyed by canonical session id (the id we
   * started the stream with) AND by resolvedId once known. While a session is
   * streaming, we never re-fetch from JSONL on session switch — we use the
   * cached snapshot to avoid duplicating the user message that has already
   * been written to JSONL by the CLI but is also being rendered live by
   * `<StreamingMessage>` from the pending state.
   */
  // Steered user messages queued while the agent is mid-turn. They are NOT
  // inserted into sessionMessages immediately — doing so while the first
  // turn's assistant reply is still streaming (not yet committed to
  // sessionMessages) would place them ABOVE that reply. Instead they are
  // surfaced when the steer continuation's turn completes, slotted between
  // the first reply and the steer response (matching Pi's JSONL order).

  // v0.9.4 需求7 测试期修复三：停止时本地已提交标记。停止链路的时序真相：
  // abort_chat 快速返回（不等 agent_settled）→本地 onAbort 先于
  // TurnComplete(Aborted) 执行。若本地 drop 流，晚到的 TurnComplete 被
  // pushTracked 拒绝，重发收口（steering 重发）永远不执行（用户实测：
  // 引导 B+停止 → B 消失）。改为：本地提交后不 drop、只设此标记；
  // turn_complete(Aborted) 到达时凭标记跳过重复提交，但收口照常。
  // v0.9.5 需求2 测试期修正（会话 01a0ed19 实证）：值语义从「时刻」改为
  // 「回合令牌」（streamStore.turnToken）——同回合重复点停止永久幂等，
  // 新回合（新 start）令牌不同自动放行；旧 10s 墙钟窗口过期后同一滞留
  // 流会再次提交（spawn 期停止后用户连点 6 次、第 4 次落在窗口外 →
  // 用户消息重复渲染，实证根因）。
  const abortLocalCommitRef = useRef<Map<string, number>>(new Map());
  // v0.9.4 需求7 测试期重构：steer 队列（外部单例）变更驱动占位重渲染。
  useSyncExternalStore(steerCoordinator.subscribe, steerCoordinator.getVersion, steerCoordinator.getVersion);
  // Live display of steered user messages, scoped per session (v0.9.2 需求4：
  // 此前为单一全局数组，任何会话视图都会渲染其他会话的引导占位——对某个
  // 任务节点发引导会串到所有子节点会话）。Rendered AFTER the streaming
  // bubble (a steer is inserted mid-output, so it must appear below the
  // in-progress assistant reply). Each entry is removed when its turn
  // completes and the steer is committed into sessionMessages at its
  // correct position (between the prior reply and the steer's response).

  // M5：引导占位气泡的 pill 中文名映射（按当前会话加载）。
  const steerToolNames = useSessionToolNames(selectedSession ?? null);
  // Subscribe to streaming state for the currently-selected session. Drives
  // whether the streaming bubble is rendered and whether the input is in Stop mode.
  const currentStream = useSessionStream(selectedSession);

  // ── 簇A 滚动系统（v0.9.7 需求2 补充：迁自本文件 use-chat-scroll，零逻辑变更）──
  const {
    scrollAction,
    isAwayFromBottomRef,
    isAwayFromBottom,
    activeTurnIndex,
    turnSummaries,
    handleJumpToTurn,
    messageExpandSignal,
    handleScrollToBottom,
  } = useChatScroll({ messageAreaRef, sessionMessages, selectedSession });
  // ── 簇B 任务/节点会话加载（同上迁出 use-task-session-load）──
  const streamTextStarted = (currentStream?.text?.length ?? 0) > 0;
  useTaskSessionLoad({
    taskModeActive,
    selectedSession,
    projectId,
    taskSelectedNodeId,
    taskNodeSessionAgentId,
    activeId,
    streamTextStarted,
    messageAreaRef,
    scrollMemory,
    sessionMessagesRef,
    setSessionMessages,
  });
  // v0.8.0 需求6：正在输出的会话集合（含后台会话）。驱动会话列表行的加载动效；
  // 快照仅在集合成员变化时更新，流式内容增量不会引起列表重渲染。
  const streamingSessionIds = useStreamingSessionIds();
  // v0.8.0 需求4 补充：切换会话时自动收起右侧文件预览面板。
  const { openViewer, closeViewer } = useFileViewer();
  // 任务图数据：无条件持有（无 graph 时无副作用）。任务模式主区（run 流）与右侧 TaskSidebar 共享。
  const taskGraph = useTaskGraph();
  // v0.7.0：ref 镜像，供轮询回调（非 React 闭包）读 taskGraph 而不进入依赖数组。
  const taskGraphRef = useRef(taskGraph);
  taskGraphRef.current = taskGraph;

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    taskLaunchOpenRef.current = taskLaunchOpen;
  }, [taskLaunchOpen]);

  useEffect(() => {
    taskLaunchPhaseRef.current = taskLaunchPhase;
  }, [taskLaunchPhase]);

  useEffect(() => {
    activeTaskInstanceIdRef.current = activeTaskInstanceId;
  }, [activeTaskInstanceId]);

  useEffect(() => {
    activeTaskRequirementFileRef.current = activeTaskRequirementFile;
  }, [activeTaskRequirementFile]);

  useEffect(() => {
    selectedTaskSkillIdRef.current = selectedTaskSkillId;
  }, [selectedTaskSkillId]);

  // Single hook for current project's sessions
  const [listRefreshKey, setListRefreshKey] = useState(0);
  const { data: sessions, loading: sessionsLoading, setData: setSessions, refetch: refetchSessions } = useInvoke<Session[]>(
    projectId && activeId ? "list_sessions" : "",
    projectId && activeId ? { agentId: activeId, encodedName: projectId } : undefined,
    activeId + "_" + listRefreshKey,
  );
  // Ref mirror for use inside the mount-only stream listener closure.
  const sessionsRef = useRef<Session[] | null>(null);
  sessionsRef.current = sessions ?? null;

  // v0.9.4 需求6 v2：AI 会话标题生成完成信号 → 本地补丁。
  // v0.9.4 需求7 测试期修复：去掉随后的 setListRefreshKey 全列表重拉——本地补丁
  // 已即时更新 display_name，重拉纯冗余且非 silent（sessionsLoading 翻真引发
  // 布局抖动，用户实测「会话完成后刷新两次」的第二次）；标题不改排序，
  // 列表基线由下次自然加载对齐。
  useEffect(() => {
    return subscribeSessionSignals((signal) => {
      if (signal.type !== "session-titled") return;
      const cur = sessionsRef.current;
      if (cur) {
        setSessions(cur.map((s) => (s.id === signal.sessionId ? { ...s, display_name: signal.title } : s)));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // v0.9.0 需求7 D 域拆分：搜索状态组出界（useMessageSearch，纯移动）。
  // 解构别名保持既有 JSX 用名不变。
  const {
    query: searchQuery,
    setQuery: setSearchQuery,
    deferredQuery: deferredSearchQuery,
    searchResults,
    showMessageSearchControls,
    handleStatusChange: handleMessageSearchStatusChange,
    navigation: messageSearchNavigation,
    requestNavigation: requestMessageSearchNavigation,
    total: messageSearchTotal,
    label: messageSearchLabel,
  } = useMessageSearch({ sessions, selectedSession });
  // ── A5 簇①：任务实例同步钩子（装载/3s 轮询/事件刷新/快照应用） ──
  // 状态（taskLaunchSessions/nodeSessionIds）由钩子拥有；discover 经 ref 回填
  //（其定义依赖本钩子的列表 setter，位于下方）。
  const discoverConductorTaskRef = useRef<(sessionId: string) => Promise<unknown>>(async () => {});
  const { taskLaunchSessions, setTaskLaunchSessions, nodeSessionIds, applyTaskLaunchInstanceSnapshot } = useTaskInstanceSync({
    projectPath: projectPathForSettings,
    projectPathRef,
    taskGraphRef,
    activeTaskInstanceIdRef,
    lastInstanceRunIdRef,
    lastRealSessionIdRef,
    discoverConductorTaskRef,
    activeTaskResolved: useCallback((record: TaskLaunchInstanceSummary) => {
      setActiveTaskInstanceId(record.task_id);
      lastKnownStatusRef.current = record.status;
      // v0.9.7 需求2（R2 修复）：旧阶段跟随效应退役后 taskModeActive 失去
      // 置位触发器——任务实例绑定成功即激活任务模式（执行段/步骤卡的渲染门）。
      setTaskModeActive(true);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  });

  useEffect(() => {
    refetchSessionsRef.current = refetchSessions;
  }, [refetchSessions]);

  useEffect(() => {
    // Clear sessions when switching agents to avoid showing stale data from previous agent
    setSessions(null);
  }, [activeId, setSessions]);

  useEffect(() => {
    onProjectSessionsLoadingChange?.(Boolean(projectId && sessionsLoading));
  }, [projectId, sessionsLoading, onProjectSessionsLoadingChange]);

  useEffect(() => {
    return () => onProjectSessionsLoadingChange?.(false);
  }, [onProjectSessionsLoadingChange]);

  const taskLaunchSessionIds = useMemo(
    () => new Set(
      [
        ...taskLaunchSessions.flatMap((item) => [item.task_session_id]),
        ...nodeSessionIds,
      ].filter((value): value is string => Boolean(value)),
    ),
    [taskLaunchSessions, nodeSessionIds],
  );
  const regularSessions = useMemo(
    () => (sessions ?? []).filter((session) => !taskLaunchSessionIds.has(session.id)),
    [sessions, taskLaunchSessionIds],
  );

  // Build display session list with optimistic sessions prepended
  // ── 需求10 收官刀②：会话选择/加载与发送链迁 use-session-selection ──
  //（缓存优先/流式截断/滚动记忆/乐观会话/发送缓存播种/任务首条包装/通知定位；
  //  refreshSessionUsage 定义序在钩子后，经 ref 运行时取用）。
  const refreshSessionUsageRef = useRef<(sessionId: string) => void>(() => {});
  const {
    injectedLaunchSessionsRef,
    optimisticSessions,
    setOptimisticSessions,
    handleSelectSession,
    handleSelectSessionRef,
    prepareTaskLaunchMessage,
    handleMessageSent,
    handleSessionResolved,
  } = useSessionSelection({
    projectId,
    activeId,
    currentProject,
    sessions,
    setSessionMessages,
    sessionMessagesRef,
    setSelectedSession,
    selectedSessionRef,
    messageAreaRef,
    scrollMemory,
    visitedSessions,
    scrollAction,
    newSessionStreamIdsRef,
    setTaskModeActive,
    setTaskLaunchOpen,
    setTaskLaunchReadOnly,
    taskLaunchOpenRef,
    taskLaunchPhaseRef,
    taskLaunchGoalRef,
    activeTaskInstanceIdRef,
    activeTaskRequirementFileRef,
    lastKnownStatusRef,
    setActiveTaskInstanceId,
    setActiveTaskRequirementFile,
    setTaskSelectedNodeId,
    setTaskNodeSessionAgentId,
    closeViewer,
    refreshSessionUsageRef,
  });

  let displaySessions = regularSessions;
  if (deferredSearchQuery.trim() && sessions) {
    displaySessions = uniqueSessionsById(
      searchResults
        .map((r: SessionSearchResult) => sessions.find(s => s.id === r.sessionId))
        .filter((session): session is Session => {
          if (!session) return false;
          return !taskLaunchSessionIds.has(session.id);
        }),
    );
  } else if (!deferredSearchQuery.trim()) {
    displaySessions = uniqueSessionsById([...optimisticSessions, ...displaySessions]);
  }
  const displayTaskLaunchSessions = taskLaunchSessions.filter((taskSession) => {
    const query = deferredSearchQuery.trim().toLocaleLowerCase();
    if (!query) return true;
    return `${taskSession.title}\n${taskSession.skill_id}\n${taskSession.status}`
      .toLocaleLowerCase()
      .includes(query);
  });

  const showStartComposer = !!projectId && (!selectedSession || selectedSession === "new");
  const activeTaskLaunchInstance = useMemo(
    () => activeTaskInstanceId
      ? taskLaunchSessions.find((item) => item.task_id === activeTaskInstanceId) ?? null
      : null,
    [activeTaskInstanceId, taskLaunchSessions],
  );
  /** 按 task_id 反查完整的任务实例（侧边栏树只持有结构子集）。 */
  const findTaskInstance = useCallback(
    (taskId: string): TaskLaunchInstanceSummary | null =>
      taskLaunchSessions.find((item) => item.task_id === taskId) ?? null,
    [taskLaunchSessions],
  );
  // T7：taskLaunchPhaseStates（三阶段 tab 的 done/active/pending 派生）随 TaskPhaseNavBar 一并退役。
  // M3：访问/权限模式域已上移 use-access-mode（permissionModes 定义处）。
  // 需求9 #3：离开保存——标签切换（[projectId]）/agent 切换（[activeId]）的
  // 重置 effect 会绕过 handleSelectSession 内的保存点直接置 null，切回时
  // restore 到残留旧像素。置空前统一补存（与 use-session-selection.ts 同口径）。
  const saveCurrentScrollBeforeLeave = useCallback(() => {
    if (selectedSessionRef.current && messageAreaRef.current) {
      const el = messageAreaRef.current;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 100;
      scrollMemory.current.set(
        selectedSessionRef.current,
        atBottom ? "bottom" : el.scrollTop,
      );
    }
  }, []);

  // Clear session state when project changes
  useEffect(() => {
    saveCurrentScrollBeforeLeave();
    setSelectedSession(null);
    selectedSessionRef.current = null;
    setSessionMessages([]);
    setOptimisticSessions([]);
    setTaskModeActive(false);
    setTaskLaunchOpen(false);
    setTaskLaunchReadOnly(false);
    taskLaunchOpenRef.current = false;
    evictIdleSessionMessagesCache();
    newSessionStreamIdsRef.current.clear();
    clearImageCache();
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !activeId) return;
    // 若本次 agent 切换是为进入任务模式（自动切到 Jishu Agent），保留任务模式状态，仅刷新会话列表
    if (enteringTaskModeRef.current) {
      enteringTaskModeRef.current = false;
      setListRefreshKey(Date.now());
      refetchNames(true).catch(console.error);
      return;
    }
    saveCurrentScrollBeforeLeave();
    setSelectedSession(null);
    selectedSessionRef.current = null;
    setSessionMessages([]);
    setOptimisticSessions([]);
    setTaskModeActive(false);
    setTaskLaunchOpen(false);
    setTaskLaunchReadOnly(false);
    taskLaunchOpenRef.current = false;
    evictIdleSessionMessagesCache();
    newSessionStreamIdsRef.current.clear();
    setListRefreshKey(Date.now());
    refetchNames(true).catch(console.error);
  }, [activeId, projectId, refetchNames, saveCurrentScrollBeforeLeave]);

  // Navigate to a specific session (triggered by floating window restore)
  useEffect(() => {
    if (navigateToSession) {
      handleSelectSessionRef.current(navigateToSession);
    }
  }, [navigateToSession]);

  const handleRefresh = async () => {
    const newKey = await onRefresh();
    // v0.9.4 需求7 测试期修复（方案 B，用户裁决）：refreshKey 重拉已 silent 化
    //（消除自动刷新场景的 loading 抖动），手动刷新在此显式非 silent 重拉——
    // 保留 loading 转圈反馈。
    await refetchSessions();
    setListRefreshKey(newKey);
    refreshAccessMode();
  };
  // v0.8.0 需求1 A5：从当前会话末尾创建分支（capability SESSION_FORK 门控；
  // 仅 jishu-self——Pi 原生 clone RPC 复制整棵会话树并重绑进程）。后端返回
  // 分支会话 id 并把进程重挂到分支；此处以乐观条目挂载分支并切换加载历史，
  // 原会话条目与文件保留、后续可独立打开。流式中禁止（重绑竞态）。
  // handleSelectSession 在下方以普通函数定义，经回调体延迟引用（不进 deps）。
  const [forking, setForking] = useState(false);
  const handleForkSession = useCallback(async (sessionId: string) => {
    if (!activeId || !projectId || sessionId === "new" || forking) return;
    if (streamStore.isStreaming(sessionId)) {
      void alertDialog({
        title: t("sessions.forkFailedTitle", "创建分支失败"),
        description: t("sessions.forkStreamingHint", "会话正在回复中，请等待本轮完成后再创建分支"),
      });
      return;
    }
    setForking(true);
    try {
      const result = await invokeCommand<{ new_session_id: string }>(
        "fork_agent_session",
        {
          agentId: activeId,
          projectPath: currentProject?.path || "",
          sessionId,
        },
      );
      const newId = result?.new_session_id;
      if (!newId || newId === sessionId) {
        throw new Error(t("sessions.forkNoBranchId", "未返回分支会话 id"));
      }
      const session = sessions?.find(s => s.id === sessionId);
      const name = sessionNames?.[sessionId] || session?.display_name || sessionId.slice(0, 8);
      const forkEntry: Session = {
        id: newId,
        path: currentProject?.path || "",
        messages: [],
        display_name: `${name}${t("sessions.forkSuffix", " (分支)")}`,
        started_at: new Date().toISOString(),
        last_active: new Date().toISOString(),
      };
      setOptimisticSessions(prev => [forkEntry, ...prev.filter(s => s.id !== newId)]);
      // 分支历史在 Pi 侧 JSONL 已就绪，经 get_session_messages 加载（清掉可能
      // 残留的同 id 缓存，避免读到分支前的旧数据）。
      deleteCachedSessionMessages(newId);
      await handleSelectSession(newId);
    } catch (err) {
      console.error("Failed to fork session:", err);
      await alertDialog({ title: t("sessions.forkFailedTitle", "创建分支失败"), description: String(err) });
    } finally {
      setForking(false);
    }
  }, [activeId, projectId, forking, sessions, sessionNames, currentProject?.path, alertDialog, t]);

  // ── 斜杠命令面板（A2）：GUI 本地命令注册表，不透传给 agent ──────────────
  const hasSelectedSession = Boolean(selectedSession && selectedSession !== "new");
  // v0.8.0 需求1 A5：会话分支（capability SESSION_FORK；仅 jishu-self）。
  const supportsFork = capabilities?.has("SESSION_FORK") ?? false;
  const slashCommands = useMemo(
    () => [
      { name: "new", label: t("sessions.slashNew"), available: Boolean(projectId) },
      { name: "task", label: t("sessions.slashTask"), available: Boolean(projectId) },
      { name: "rename", label: t("sessions.slashRename"), available: hasSelectedSession },
      { name: "terminal", label: t("sessions.slashTerminal"), available: hasSelectedSession },
      { name: "float", label: t("sessions.slashFloat"), available: hasSelectedSession },
      { name: "compact", label: t("sessions.slashCompact"), available: hasSelectedSession && supportsCompact },
      { name: "fork", label: t("sessions.slashFork", "创建会话分支"), available: hasSelectedSession && supportsFork && !currentStream?.isStreaming },
    ],
    [hasSelectedSession, projectId, supportsCompact, supportsFork, currentStream?.isStreaming, t],
  );
  const handleSlashCommand = useCallback(
    (name: string) => {
      switch (name) {
        case "new":
          handleNewSession();
          break;
        case "task":
          handleOpenTaskConversation();
          break;
        case "rename":
          setRenameOpen(true);
          break;
        case "terminal":
          if (selectedSession) void handleResumeSession(selectedSession);
          break;
        case "float":
          if (selectedSession) handleFloatSession(selectedSession);
          break;
        case "compact":
          void handleCompactSession();
          break;
        case "fork":
          if (selectedSession) void handleForkSession(selectedSession);
          break;
      }
    },
    [selectedSession, handleCompactSession, handleForkSession],
  );

  const workModeOptions = useMemo(() => [
    { value: "chat", label: t("sessions.workMode.chat") },
    { value: "task", label: t("sessions.workMode.task") },
  ], [t]);
  // 任务模式引擎 = 内建 agent（builtin，adapter 声明）；当前 agent 是否
  // 支持任务模式看 TASK_MODE 能力位。v0.7.4 需求3 M2：替换 agentId 写死判断。
  const taskEngineAgent = useMemo(
    () => agents.find((agent) => agent.builtin) ?? null,
    [agents],
  );
  const taskModeAgentReady = Boolean(taskEngineAgent?.health.installed);
  const taskModeCanSend =
    taskModeAgentReady && (capabilities?.has("TASK_MODE") ?? false);

  // v0.9.3 需求13 C4-slice2c：pipeline 插件「作为任务启动」——App 层已切
  // jishu agent 并翻回会话页；此处按 key 预填 /jishu-pipeline 启动命令
  // （替换式回填，用户补目标后发送；重复 key 不重复回填）。
  // 需求9 #8：①追加改替换（旧草稿+新命令会累积）；②消费后回调清 App 态
  //（chat/manage 互斥渲染致 ChatPage 重挂、防重 ref 归零，App 态不清则
  // 重挂重预填并掀掉当前会话）。
  const pipelineLaunchRef = useRef(0);
  useEffect(() => {
    if (!pipelineLaunch || pipelineLaunch.key === pipelineLaunchRef.current) return;
    pipelineLaunchRef.current = pipelineLaunch.key;
    if (activeId !== "jishu-self") setChatAgent("jishu-self");
    chatInputRef.current?.setText(`/jishu-pipeline ${pipelineLaunch.pluginId} `);
    onPipelineLaunchConsumed?.();
  }, [pipelineLaunch, activeId, setChatAgent, onPipelineLaunchConsumed]);

  // M3：handleAccessModeChange 已迁 use-access-mode（上方解构）。

  useEffect(() => {
    if (!taskLaunchOpen || agents.length === 0) return;
    if (!taskModeAgentReady) {
      void alertDialog({
        title: "无法进入任务模式",
        description: "任务模式需要先安装 Jishu Agent。请到环境检测页面完成安装后再发起任务。",
      });
      return;
    }
    const engineId = taskEngineAgent?.id;
    if (engineId && activeId !== engineId) {
      // v0.7.0：会话作用域切换（任务模式属于会话场景）。
      // 标记本次切换是为进入任务模式，阻止上面的清理 effect 重置任务模式状态
      enteringTaskModeRef.current = true;
      setChatAgent(engineId);
    }
  }, [activeId, agents.length, setChatAgent, taskLaunchOpen, taskModeAgentReady, taskEngineAgent]);

  // ── 簇A 滚动系统：已迁 use-chat-scroll ──

  // v0.8.0 需求10：从 Hub SQLite（get_session_usage）拉取会话累计用量写入
  // 前端缓存。回合结束与会话打开两个时机调用；失败静默（保留旧缓存）。
  const refreshSessionUsage = (sessionId: string) => {
    invokeCommand<{
      input_tokens: number;
      output_tokens: number;
      cache_read: number;
      cache_write: number;
      total_cost: number;
      context_remaining: number | null;
      context_window_total: number | null;
      est_thinking: number;
      est_text: number;
      est_builtin_tool: number;
      est_mcp_tool: number;
      est_tool_results: number;
      tool_calls: number;
      segments: number;
      compactions: number;
      updated_at: number;
    }>("get_session_usage", { sessionId })
      .then((row) => {
        setSessionUsage(sessionId, {
          inputTokens: row.input_tokens ?? 0,
          outputTokens: row.output_tokens ?? 0,
          cacheRead: row.cache_read ?? 0,
          cacheWrite: row.cache_write ?? 0,
          totalCost: row.total_cost ?? 0,
          contextRemaining: row.context_remaining ?? null,
          contextWindowTotal: row.context_window_total ?? null,
          estThinking: row.est_thinking ?? 0,
          estText: row.est_text ?? 0,
          estBuiltinTool: row.est_builtin_tool ?? 0,
          estMcpTool: row.est_mcp_tool ?? 0,
          estToolResults: row.est_tool_results ?? 0,
          toolCalls: row.tool_calls ?? 0,
          segments: row.segments ?? 0,
          compactions: row.compactions ?? 0,
          updatedAt: row.updated_at ?? 0,
        });
      })
      .catch(() => {});
  };
  refreshSessionUsageRef.current = refreshSessionUsage;

  // v0.8.0 需求7：重挂载对账。agent-event 监听随组件卸载移除，卸载期间
  // 结束的回合收不到 turn_complete，streamStore 会永远停在 isStreaming
  // （气泡冻结、「刷新会话」被流式守卫拒绝、列表动效常转）。挂载时逐一
  // 询问后端回合真值（chat_turn_active）：已结束的丢弃流式状态并清其缓存
  // 条目，点击时重读 JSONL 拿完整历史；若正查看该会话则立即重载一次。
  useEffect(() => {
    const streamingIds = streamStore.getStreamingIds();
    if (streamingIds.length === 0) return;
    let cancelled = false;
    for (const sid of streamingIds) {
      invokeCommand<boolean>("chat_turn_active", { sessionId: sid })
        .then((active) => {
          if (cancelled || active) return;
          streamStore.drop(sid);
          deleteCachedSessionMessages(sid);
          if (selectedSessionRef.current === sid) {
            handleSelectSessionRef.current(sid);
          }
        })
        .catch(() => {
          // 查询失败（后端未就绪等）：保守保留本地状态——宁可有重复
          // 渲染，也不中断仍在进行的直播。
        });
    }
    return () => {
      cancelled = true;
    };
  }, []);

  // Listen for cross-page session open requests
  useEffect(() => {
    const onStorage = () => {
      try {
        const raw = localStorage.getItem("jishu:open-session");
        if (!raw) return;
        localStorage.removeItem("jishu:open-session");
        const { sessionId } = JSON.parse(raw) as { sessionId: string };
        if (sessionId && handleSelectSessionRef.current) {
          handleSelectSessionRef.current(sessionId);
        }
      } catch (e) {
        console.error("Failed to handle open-session event", e);
      }
    };
    window.addEventListener("storage", onStorage);
    // Also poll on mount (storage event only fires on OTHER windows)
    onStorage();
    const interval = setInterval(onStorage, 500);
    return () => {
      window.removeEventListener("storage", onStorage);
      clearInterval(interval);
    };
  }, []);

  // ── 簇B 任务/节点会话加载：已迁 use-task-session-load ──

  const handleNewSession = async () => {
    if (!projectId) return;

    // v0.8.0 需求4 补充：新建会话同样视为切换，收起右侧预览。
    closeViewer();
    // v0.9.3 测试期修复22：同时显式收起会话侧栏（产物中心等 sidebar-panel
    // 形态）——用户实测 A 会话 HTML 预览后点「新对话」，右半空白占位
    //（openId 未清；插件自治收起链在组件测试中为绿，实机仍复现，改为
    // 壳层确定性收起，与 closeViewer 同语义）。
    closeSessionSidebar();

    setTaskModeActive(false);
    setTaskLaunchOpen(false);
    setTaskLaunchReadOnly(false);
    taskLaunchOpenRef.current = false;
    activeTaskInstanceIdRef.current = null;
    activeTaskRequirementFileRef.current = null;
    lastKnownStatusRef.current = null;
    setActiveTaskInstanceId(null);
    setActiveTaskRequirementFile(null);
    closeSessionSidebar();
    setSelectedSession("new");
    selectedSessionRef.current = "new";
    setSessionMessages([]);

    requestAnimationFrame(() => {
      chatInputRef.current?.focus();
    });
  };

  // A5 簇②：handleOpenTaskConversation 已迁 use-task-session-routing（下方解构；
  // 本处之前的闭包引用（handleSlashCommand）按运行时取值，无 TDZ）。

  const handleResumeSession = async (sessionId: string) => {
    setLoadingSessionId(sessionId);
    try {
      const existing = await invokeCommand<{ pid: number; project_path: string; started_at: string } | null>(
        "find_session_terminal", { sessionId }
      );
      if (existing) {
        try {
          await invokeCommand<boolean>("focus_session_terminal", { sessionId });
        } catch (err) {
          console.warn("Failed to focus session terminal:", err);
        }
        setLoadingSessionId(null);
        return;
      }
      const session = sessions?.find(s => s.id === sessionId);
      const cwd = session?.project_path || currentProject?.path;
      if (!cwd) return;
      const pid = await invokeCommand<number>("open_in_terminal", {
        agentId: activeId ?? "",
        projectPath: cwd,
        resumeSessionId: sessionId,
      });
      await invokeCommand("register_terminal_session", {
        sessionId, pid, projectPath: cwd,
        agentId: activeId ?? "",
      });
    } catch (err) {
      console.error("Failed to resume session:", err);
    } finally {
      setLoadingSessionId(null);
    }
  };

  // v0.7.4 需求1 B4：删除常规会话（capability SESSION_DELETE 门控；入口在
  // 会话右键菜单）。删除当前打开的会话后自动新建空会话。
  const handleDeleteSession = useCallback(async (sessionId: string) => {
    if (!activeId || !projectId) return;
    const session = sessions?.find(s => s.id === sessionId);
    const name = sessionNames?.[sessionId] || session?.display_name || sessionId.slice(0, 8);
    const confirmed = await confirmDialog({
      title: t("sessions.deleteTitle"),
      description: t("sessions.deleteConfirm", { name }),
      variant: "destructive",
    });
    if (!confirmed) return;
    try {
      await invokeCommand("delete_agent_session", {
        agentId: activeId,
        sessionId,
        encodedName: projectId,
      });
      setOptimisticSessions(prev => prev.filter(s => s.id !== sessionId));
      setListRefreshKey(k => k + 1);
      if (selectedSession === sessionId) {
        void handleNewSession();
      }
    } catch (err) {
      console.error("Failed to delete session:", err);
      await alertDialog({ title: "删除会话失败", description: String(err) });
    }
  }, [activeId, projectId, sessions, sessionNames, confirmDialog, alertDialog, t, selectedSession]);

  // v0.9.7 需求3 C1：描述需求创建插件——App 层已切 jishu agent 与会话页；
  // 此处按 key 开新会话并预填创作指令（草稿态可改；延迟一拍等新会话输入
  // 框挂载，pipelineLaunch 同款 key 防重复）。需求9 #8：①restoreTexts 追加
  // 改 setText 替换（第二次点创建时 localStorage 旧草稿+新预填会累积两份）；
  // ②消费后回调清 App 态（重挂重预填/掀会话，见 pipelineLaunch 注释）。
  const pluginCreateLaunchRef = useRef(0);
  useEffect(() => {
    if (!pluginCreateLaunch || pluginCreateLaunch.key === pluginCreateLaunchRef.current) return;
    pluginCreateLaunchRef.current = pluginCreateLaunch.key;
    void handleNewSession();
    const prefill = t("chat.pluginCreatePrefill", {
      defaultValue:
        "我想创建一个插件：{{text}}\n请先阅读 jishu-plugin-authoring 技能，与我确认关键设计点后开始实现。",
      text: pluginCreateLaunch.text,
    });
    window.setTimeout(() => {
      chatInputRef.current?.setText(prefill);
      chatInputRef.current?.focus();
    }, 200);
    onPluginCreateLaunchConsumed?.();
  }, [pluginCreateLaunch, handleNewSession, t, onPluginCreateLaunchConsumed]);

  // v0.8.0 需求5：刷新会话（右键菜单与会话头部按钮统一入口，作用于指定
  // 会话）。反馈三层：refreshingSessionId 驱动头部按钮/被刷新行的旋转动画、
  // 最短 400ms 呈现（快于视觉阈值时不再“无感”）、失败经 alertDialog 弹窗。
  const [refreshingSessionId, setRefreshingSessionId] = useState<string | null>(null);
  const handleRefreshSession = useCallback(async (sessionId: string) => {
    if (!sessionId || sessionId === "new" || !projectId || !activeId) return;
    if (refreshingSessionId === sessionId) return;
    // 与头部按钮的禁用条件同源：会话存在流式状态（本轮未收尾）时拒绝重载，
    // 否则 JSONL 半截内容会与直播气泡重叠（重复行）。此处给出弹窗反馈而非
    // 静默返回——菜单点击必须可感知。
    if (streamStore.hasState(sessionId)) {
      void alertDialog({
        title: t("sessions.refreshBlockedTitle", "暂时无法刷新"),
        description: t("sessions.refreshDisabledWhileStreaming"),
      });
      return;
    }
    setRefreshingSessionId(sessionId);
    const startedAt = Date.now();
    try {
      const [msgs] = await Promise.all([
        invokeCommand<Message[]>("get_session_messages", {
          agentId: activeId,
          sessionId,
          encodedName: projectId,
        }),
        // 最短呈现 400ms：保证旋转/高亮反馈可被肉眼捕捉。
        new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, 400 - (Date.now() - startedAt)))),
      ]);
      const visibleMessages = filterInvisibleUserMessages(msgs);
      setCachedSessionMessages(sessionId, visibleMessages);
      if (selectedSessionRef.current === sessionId) {
        setSessionMessages(visibleMessages);
      }
      // 同时刷新列表元数据（名称/排序/活跃时间）——非选中会话刷新时列表
      // 变化即点击反馈的一部分。
      setListRefreshKey((k) => k + 1);
    } catch (e) {
      console.error(e);
      void alertDialog({
        title: t("sessions.refreshFailedTitle", "刷新会话失败"),
        description: String(e),
      });
    } finally {
      setRefreshingSessionId(null);
    }
  }, [refreshingSessionId, projectId, activeId, alertDialog, t]);

  const handleFloatSession = useCallback((sessionId: string) => {
    const name = sessionNames?.[sessionId]
      || sessions?.find(s => s.id === sessionId)?.display_name
      || sessionId.slice(0, 8);
    openFloatingSession(sessionId, name, activeId || "", currentProject?.encoded_name || "", active?.display_name);
  }, [sessionNames, sessions, activeId, active, currentProject]);

  // A5 簇①：applyTaskLaunchInstanceSnapshot 已迁 use-task-instance-sync（上方解构）。

  // conductor 驱动的任务发现：首条消息激活 conductor 后，conductor 异步创建 TaskInstance（写入 requirement_session_id）。
  // 轮询任务列表按 requirement_session_id 匹配到该任务后，打开三阶段工作台（此处不标记 launch 会话，避免重复建任务；标记由流式 chunk 处理按需触发，见 task_launch_mark_session 内联调用）。
  // 用 projectPathRef.current（非 state）+ deps=[]，使其引用稳定，可在 mount-only 的
  // stream listener 闭包内安全调用而不捕获陈旧的 projectPath。
  const discoverConductorTask = useCallback(async (sessionId: string) => {
    const projectRoot = projectPathRef.current;
    if (!projectRoot || !sessionId) return;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const items = await invokeCommand<TaskLaunchInstanceSummary[]>(
          "task_launch_list_sessions",
          { projectRoot },
        );
        const found = items.find((item) => item.task_session_id === sessionId);
        if (found) {
          logTaskPhaseDebug("conductor-task:discovered", {
            taskId: found.task_id,
            sessionId,
          });
          // 仅关联任务实例（供 follow effect 监听 current_phase），不切换 UI：需求/规划讨论
          // 继续留在 taskLaunch 界面，由 follow effect 在阶段推进时按阶段切标签/工作台
          // （openTaskPhaseWorkspace，execution 分支自行设置 taskContainer*）。此处若
          // setTaskModeActive(true) 会把需求讨论强行拽入 TaskPhaseContainer，触发 useChatSession
          // 加载 requirement session 失败（Pi session not found）+ TaskPhaseContainer 重复挂载
          // （分隔线两次、卡"思考中"）。
          setActiveTaskInstanceId(found.task_id);
          activeTaskInstanceIdRef.current = found.task_id;
          setSelectedTaskSkillId(found.skill_id || "jishu-conductor-dev");
          selectedTaskSkillIdRef.current = found.skill_id || "jishu-conductor-dev";
          lastKnownStatusRef.current = found.status;
          setTaskLaunchSessions(items);
          return;
        }
      } catch (error) {
        console.warn("discoverConductorTask poll failed:", error);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    logTaskPhaseDebug("conductor-task:not-found", { sessionId });
  }, []);
  // A5 簇①：同步钩子的事件关联经此 ref 取发现函数（定义序在钩子之后，运行时回填）。
  discoverConductorTaskRef.current = discoverConductorTask;

  // v0.9.2 测试期修复：离开会话页（切管理页等，chat-page 卸载）时收起会话
  // 侧栏。面板本体由 chat-page 承载随卸载消失，但顶开 margin 在 app 层
  //（ViewerPushRow 读 session-sidebar 壳层状态）——不收起则管理页布局被
  // 压去一半、原侧栏位置空白（用户实测）。会话侧栏是会话区语义，随宿主
  // 页面生命周期收起，不做跨页面残留。
  useEffect(() => () => closeSessionSidebar(), []);

  // v0.9.2 测试期（插件机制）：agent 工具事件 → 内核信号管线。preview_html
  // 等工具经 hub_invoke 校验后广播 session-plugin-preview；内核转发为
  // file-preview-request 信号（严格走信号总线），插件（产物中心）经
  // event-hook 消费并自行决定拉起面板——内核不感知具体插件。
  useEffect(() => {
    const unlisten = listen<{ file?: string; url?: string; session_id?: string }>("session-plugin-preview", (event) => {
      // v0.9.3 测试期：url 模式（前端 dev server 预览，如 http://localhost:5173）
      // 优先于 file——产物中心按 http 前缀分流为 iframe 直连。
      const target = event.payload?.url ?? event.payload?.file;
      if (typeof target === "string" && target) {
        emitSessionSignal({
          type: "file-preview-request",
          file: target,
          sessionId: event.payload?.session_id ?? undefined,
        });
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // A5 簇①：task-instance-changed 监听已迁 use-task-instance-sync。

  // T7：openTaskChatPhase（需求/规划走旧 chat 路径）已随三阶段形态退役——
  // 所有阶段统一由 openTaskPhaseWorkspace 进入「会话页 + 任务侧边栏」形态。
  // A5 簇②：openTaskPhaseWorkspace / handleTaskSelectNode / handleTaskNodeSessionChange
  // 已迁 use-task-session-routing（下方解构）。

  // v0.9.2 需求2 M3-5：节点会话机制自 TaskSidebar 移植（侧栏退役）——
  // 选中节点变化时查其 attempt 会话并回填主区；run 状态回写任务实例。
  const taskInstanceState = useTaskInstance({
    projectRoot: currentProject?.path ?? "",
    initialTaskId: activeTaskLaunchInstance?.task_id ?? null,
  });
  useEffect(() => {
    if (activeTaskLaunchInstance?.task_id) {
      taskInstanceState.openTask(activeTaskLaunchInstance.task_id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTaskLaunchInstance?.task_id]);

  // v0.9.2 测试期修复（M3-5 侧栏退役时漏移植）：进入执行阶段时加载任务图——
  // 原 TaskSidebar 的职责；缺失时 snapshot 恒空，方案卡/全景/子任务卡全部
  // 落到空态（"流程尚未生成步骤"）。经 ref 读 taskGraph 防死循环（同上注释）。
  // v0.9.2 二次修复：依赖加 taskModeActive——切走再切回时 graph 被清理但
  // current_phase/graph_id 未变致 effect 不重触发，nodeRuns 恒空 → 节点恒显示
  // "尚未开始执行"。
  useEffect(() => {
    if (
      taskModeActive &&
      activeTaskLaunchInstance?.graph_id &&
      activeTaskLaunchInstance.graph_id !== taskGraphRef.current.graph?.graph_id
    ) {
      taskGraphRef.current
        .loadGraph(activeTaskLaunchInstance.graph_id)
        .catch(console.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskModeActive, activeTaskLaunchInstance?.graph_id]);
  // v0.9.3 需求1 P2-2：useNodeSession 只消费 node_run_id/node_id/status/
  // attempt_count 四字段（NodeRunLookupSource 最小形状），内部 NodeRun 状态
  // 结构满足，不再双重 cast 伪装完整 RunProjection（原先其余字段在 hook 内
  // 零消费，属死重）。
  const boardProjection = useMemo<NodeRunLookupSource | null>(() => {
    const runId = taskGraph.displayedRunId ?? activeTaskLaunchInstance?.active_run_id ?? null;
    if (!runId || !activeTaskLaunchInstance?.graph_id) return null;
    return { node_runs: taskGraph.nodeRuns };
  }, [activeTaskLaunchInstance?.graph_id, activeTaskLaunchInstance?.active_run_id, taskGraph.displayedRunId, taskGraph.nodeRuns]);
  const boardNodeSession = useNodeSession({
    projection: boardProjection,
    onNodeSession: taskInstanceState.updateNodeSession,
  });
  const boardRunId = taskGraph.displayedRunId ?? activeTaskLaunchInstance?.active_run_id ?? null;
  useEffect(() => {
    taskInstanceState.selectNode(taskSelectedNodeId);
    if (!taskSelectedNodeId || !boardRunId) return;
    // v0.9.2 测试期二次返工（节点会话派发信息缺失）：本 effect 只在
    // nodeId/runId/attempt_count/status 变化时触发；节点刚启动时 session_id
    // 常常尚未由 Pi RPC SessionResolved 落库——此刻查询拿到 null 后再无
    // 重试触发（status 长期停在 running），主区卡 "pending-node" 占位直到
    // 节点终态才恢复。节点仍在执行且会话未回填时按 2s 轮询，直到拿到
    // session_id 或节点终态为止。
    const nodeStatus = taskGraph.nodeRuns[taskSelectedNodeId]?.status ?? null;
    const nodeActive = nodeStatus === "leased" || nodeStatus === "running";
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      const info = await boardNodeSession.fetchNodeSession(taskSelectedNodeId).catch((e) => {
        console.error(e);
        return null;
      });
      if (cancelled) return;
      if (nodeActive && (!info || info.session_id == null)) {
        timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskSelectedNodeId, boardRunId,
    taskSelectedNodeId ? taskGraph.nodeRuns[taskSelectedNodeId]?.attempt_count ?? 0 : 0,
    taskSelectedNodeId ? taskGraph.nodeRuns[taskSelectedNodeId]?.status ?? null : null]);
  useEffect(() => {
    if (!taskSelectedNodeId) {
      handleTaskNodeSessionChange(null);
      return;
    }
    const info = taskInstanceState.nodeSessionMap[taskSelectedNodeId];
    handleTaskNodeSessionChange(info ? { session_id: info.session_id, agent_id: info.agent_id } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskSelectedNodeId, taskInstanceState.nodeSessionMap]);
  useEffect(() => {
    if (taskGraph.runStatus && boardRunId) {
      taskInstanceState.syncRunStatus(boardRunId, taskGraph.runStatus);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskGraph.runStatus, boardRunId]);

  // v0.9.2 需求2 M3：全景画布入口——信号递增唤起页面级画布 overlay（M3-5 起
  // overlay 由页面持有；侧栏已退役）。
  const [taskBoardSignal, setTaskBoardSignal] = useState(0);
  const [taskBoardOpen, setTaskBoardOpen] = useState(false);
  useEffect(() => {
    if (taskBoardSignal > 0) setTaskBoardOpen(true);
  }, [taskBoardSignal]);

  // v0.9.2 需求2 M3-5：画布内指定节点执行者（自侧栏迁移；run 进行中禁止）。
  const handleBoardAssignAgent = useCallback(
    async (nodeId: string, agentId: string, roleId: string) => {
      if (taskGraph.activeRunId) return;
      try {
        await taskGraph.applyCommands([
          {
            op: "update_node",
            command_id: `assign-${nodeId}-${Date.now().toString(36)}`,
            node_id: nodeId,
            patch: {
              agent_assignment_constraint: {
                role_id: roleId,
                locked_agent_id: agentId,
                allowed_agent_ids: [],
                denied_agent_ids: [],
                required_capabilities: [],
              },
            },
          },
        ]);
      } catch (err) {
        console.error("Failed to assign agent:", err);
      }
    },
    [taskGraph],
  );

  // v0.9.2 需求2 M3：取消整个流程（二次确认在内核侧承担——插件面板只发命令）。
  const handleTaskCancelRun = useCallback(() => {
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("task.execution.cancelRunTitle", "取消任务执行"),
        description: t("task.execution.cancelRunConfirm", "进行中的子任务将全部停止，已完成的节点结果保留。确定取消？"),
        variant: "destructive",
      });
      if (!confirmed) return;
      taskGraphRef.current.cancelRun().catch((e) => console.warn("cancel run failed:", e));
    })();
  }, [confirmDialog, t]);

  // 失败节点干预（handleRetryNode/handleSkipNode）：已迁 use-task-execution-stage。


  // ── A5 簇②③：任务会话导流钩子（新建任务对话/工作模式切换/任务工作台/
  // 节点选择与回填 + 任务面板 ctx——流程全景插件的数据面）。任务态 state 仍在
  // 页面（读写面横跨发送链/流式管线/JSX），此处收拢动作与派生。 ──
  // 需求2 追加：任务不询问模式（Pi settings taskNoAsk——runner ask_user
  // 自动放行 + 工具审批跳过 + 纪律注入三处同源）。
  const [taskNoAsk, setTaskNoAsk] = useState(false);
  useEffect(() => {
    invokeCommand<boolean>("get_task_no_ask")
      .then(setTaskNoAsk)
      .catch(() => setTaskNoAsk(false));
  }, []);
  const handleTaskNoAskChange = useCallback((enabled: boolean) => {
    setTaskNoAsk(enabled); // 乐观更新；失败回滚
    invokeCommand<boolean>("set_task_no_ask", { enabled })
      .then((v) => setTaskNoAsk(v))
      .catch(() => setTaskNoAsk(!enabled));
  }, []);

  const {
    handleOpenTaskConversation,
    handleWorkModeChange,
    openTaskSession,
    handleTaskSelectNode,
    handleTaskNodeSessionChange,
    taskPanelCtx,
  } = useTaskSessionRouting({
    setTaskModeActive,
    setTaskLaunchOpen,
    setTaskLaunchReadOnly,
    setTaskLaunchPhase,
    setActiveTaskInstanceId,
    setActiveTaskRequirementFile,
    setSelectedTaskSkillId,
    setTaskSelectedNodeId,
    setTaskNodeSessionAgentId,
    taskLaunchOpenRef,
    taskLaunchPhaseRef,
    activeTaskInstanceIdRef,
    activeTaskRequirementFileRef,
    lastKnownStatusRef,
    taskSelectedNodeIdRef,
    enteringTaskModeRef,
    activeId,
    taskModeActive,
    activeTaskLaunchInstance,
    taskSelectedNodeId,
    taskGraph,
    nodeSessionMap: taskInstanceState.nodeSessionMap,
    closeSessionSidebar,
    setSelectedSession,
    selectedSessionRef,
    setSessionMessages,
    chatInputRef,
    handleTaskCancelRun,
    setTaskBoardSignal,
    taskEngineAgent,
    taskModeAgentReady,
    setChatAgent,
    confirmDialog,
    alertDialog,
  });

  // v0.9.2 需求1：已启用会话插件集合（plugins-changed 热刷新）。
  const enabledSessionPlugins = useEnabledSessionPlugins();

  // v0.9.2 底座增强：当前会话消息的完整块投影（工具调用/思考/交互/图片/
  // 分隔线均可见——统计/阅读/导出类插件的数据面）。
  const ctxMessages = useMemo<PluginMessage[]>(
    () =>
      sessionMessages.map((msg) => ({
        role: msg.role,
        blocks: msg.content.map((block): PluginBlock => {
          switch (block.type) {
            case "text":
              return { type: "text", text: block.text };
            case "thinking":
              return { type: "thinking", thinking: block.thinking };
            case "tool_use":
              return {
                type: "tool_use",
                id: block.id,
                text: block.name,
                input:
                  typeof block.input === "object" && block.input !== null
                    ? (block.input as Record<string, unknown>)
                    : {},
              };
            case "tool_result":
              return {
                type: "tool_result",
                id: block.tool_use_id,
                output:
                  typeof block.content === "string"
                    ? block.content
                    : JSON.stringify(block.content),
                isError: (block as { is_error?: boolean }).is_error ?? false,
                // 需求12：结构化 details 透传（rpiv-todo 全量任务快照等）——
                // 待办看板插件消费。
                details:
                  (block as { details?: Record<string, unknown> }).details &&
                  typeof (block as { details?: Record<string, unknown> }).details === "object"
                    ? ((block as { details?: Record<string, unknown> }).details as Record<string, unknown>)
                    : undefined,
              };
            case "interaction":
              return {
                type: "interaction",
                text: block.prompt,
                options: (block.options ?? []).map((o) => ({
                  id: o.option_id,
                  label: o.label,
                })),
                answer: block.answer ?? undefined,
              };
            case "phase_divider":
              return { type: "phase_divider", text: block.phase };
            default:
              return { type: "text", text: "" };
          }
        }),
      })),
    [sessionMessages],
  );

  // v0.9.2 底座增强：流式状态投影（阅读模式/实时监控类插件消费）。
  const ctxStreamState = useMemo(() => {
    if (!currentStream) return null;
    return {
      isStreaming: currentStream.isStreaming,
      text: currentStream.text ?? "",
      retry: currentStream.autoRetry
        ? {
            attempt: currentStream.autoRetry.attempt,
            max: currentStream.autoRetry.maxAttempts,
            reason: currentStream.autoRetry.errorMessage,
          }
        : null,
      error: currentStream.error || null,
      steerTexts: currentStream.steerTexts ?? [],
    };
  }, [currentStream]);

  // v0.9.2 底座增强：会话元信息（agent/模型/思考档/上下文占用）。
  const ctxSessionMeta = useMemo(
    () => ({
      agentId: chatAgentId,
      agentName: chatAgent?.display_name ?? null,
      model: activeModelValue ?? null,
      thinkingLevel: thinkingLevelValue,
      contextUsed: (() => {
        const u = getSessionUsage(selectedSession ?? "");
        return u?.inputTokens != null && u?.outputTokens != null
          ? u.inputTokens + u.outputTokens
          : null;
      })(),
      contextTotal: getSessionUsage(selectedSession ?? "")?.contextWindowTotal ?? null,
      // v0.9.2 测试期：插件解析 tool_use 相对路径用（html-preview 会话产物）。
      projectPath: currentProject?.path ?? null,
      // 插件跨会话读取子节点会话产物（get_session_messages 的 encodedName 键）。
      projectEncodedName: currentProject?.encoded_name ?? null,
    }),
    [chatAgentId, chatAgent, activeModelValue, thinkingLevelValue, selectedSession, currentProject],
  );

  // v0.9.2 底座增强：消息搜索（搜索插件消费）。
  const searchMessages = useCallback(
    (query: string): PluginSearchMatch[] => {
      if (!query.trim()) return [];
      const matches: PluginSearchMatch[] = [];
      const q = query.toLowerCase();
      ctxMessages.forEach((msg, mi) => {
        msg.blocks.forEach((block, bi) => {
          const text =
            block.type === "text"
              ? block.text ?? ""
              : block.type === "tool_use"
                ? block.text ?? ""
                : "";
          const idx = text.toLowerCase().indexOf(q);
          if (idx >= 0) {
            matches.push({
              messageIndex: mi,
              blockIndex: bi,
              excerpt: text.slice(Math.max(0, idx - 20), idx + q.length + 40),
            });
          }
        });
      });
      return matches;
    },
    [ctxMessages],
  );

  // v0.9.2 底座增强：滚动到指定消息（搜索跳转）。消息按行分组渲染
  //（assistant 组多消息一行），data-message-index 记录行首消息下标，
  // 查找时取「行首 ≤ 目标 index 的最后一行」。
  const scrollToMessage = useCallback((messageIndex: number) => {
    const el = messageAreaRef.current;
    if (!el) return;
    const rows = Array.from(
      el.querySelectorAll<HTMLElement>('[data-turn-scope="main"] [data-message-index]'),
    );
    let best: HTMLElement | null = null;
    for (const row of rows) {
      const idx = Number(row.dataset.messageIndex);
      if (Number.isNaN(idx)) continue;
      if (idx <= messageIndex) {
        best = row;
      } else {
        break;
      }
    }
    if (best) {
      best.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, []);

  // v0.9.2 底座增强：插入文本到输入框（Prompt 模板/引导指令类插件消费）。
  const insertToComposer = useCallback((text: string) => {
    chatInputRef.current?.restoreTexts([text]);
    chatInputRef.current?.focus();
  }, []);

  // 子节点会话标题（resolveSessionInfo 消费——用量面板等按会话 id 取标题）：
  // 以 node_id→title 为源，再经 nodeSessionMap 折算出 session_id→title 索引。
  // 左侧任务树不再展示子会话（2026-09-11 用户裁决），此映射改为看板/面板侧
  // 唯一的标题来源；此前树侧曾按 session_id 查 node_id 键控表，恒落空回退
  // 截断 id，本次一并修正。
  const nodeTitleBySessionId = useMemo(() => {
    const byNodeId: Record<string, string> = {};
    for (const n of taskGraph.snapshot?.nodes ?? []) {
      byNodeId[n.node_id] = n.title;
    }
    const bySessionId: Record<string, string> = {};
    for (const [nodeId, info] of Object.entries(taskInstanceState.nodeSessionMap)) {
      if (info.session_id && byNodeId[nodeId]) {
        bySessionId[info.session_id] = byNodeId[nodeId];
      }
    }
    return bySessionId;
  }, [taskGraph.snapshot, taskInstanceState.nodeSessionMap]);

  // v0.9.3 需求3（P1-3）：会话内核数据枢纽——ctx.subscribe 各数据面的真订阅
  // 宿主（监听器集合 + 最新快照）。hub 生命周期 = 页面实例（useRef 惰性建），
  // ctx 重建只重放快照，订阅不丢；数据变更经下方 publish effects 逐个回调。
  // v0.9.3 需求10 A4：审批/交互队列剥离为 hook（纯搬迁；审批面经数据枢纽
  // 发布为插件可消费能力）。置于 ctx 构造前——projection 进 seed。
  const {
    pendingApprovals,
    setPendingApprovals,
    setPendingInteractions,
    approvalResolving,
    activeApproval,
    approvalDescKey,
    activeInteraction,
    handleInteractionSubmit,
    resolveActiveApproval,
  } = useChatApprovals({ selectedSession, handleMessageSent, activeIdRef, projectPathRef });
  // 审批面投影 + 发布（插件消费：审批中心类组合插件）。
  const approvalProjection = useMemo(
    () =>
      pendingApprovals.map((a) => ({
        sessionId: a.sessionId,
        requestId: a.requestId,
        kind: a.approvalKind ?? "",
      })),
    [pendingApprovals],
  );

  const dataHubRef = useRef<SessionDataHub | null>(null);
  if (!dataHubRef.current) dataHubRef.current = new SessionDataHub();
  const dataHub = dataHubRef.current;

  // v0.9.2 需求1：会话内核上下文——插件的唯一取数/命令入口（05 §3.2）。
  useEffect(() => {
    dataHub.publishApprovals(approvalProjection);
  }, [approvalProjection, dataHub]);

  const sessionKernelCtx = useMemo<SessionKernelContext>(
    () => {
      // ctx 构造即 seed：晚订阅者回放到的永远是当前值；seed 不通知既有
      // 订阅者（通知职责归下方 publish effects，避免 ctx 重建引发重复回调）。
      dataHub.seed({
        messages: ctxMessages,
        streamState: ctxStreamState,
        sessionMeta: ctxSessionMeta,
        turns: turnSummaries,
        approvals: approvalProjection,
      });
      return {
      approvals: approvalProjection,
      turns: turnSummaries,
      activeTurnIndex,
      scrollToTurn: handleJumpToTurn,
      searchMessages,
      scrollToMessage,
      insertToComposer,
      switchSession: (id: string) => void handleSelectSession(id),
      openFileViewer: (path: string) => openViewer({ kind: "file", path }),
      // v0.9.2 测试期：插件展开自己面板的命令（event-hook 收到信号拉起面板，
      // 如 file-preview-request）；经 shell 的激活性落点，由宿主按形态生效。
      openPanel: (pluginId: string) => requestPanelActivation(pluginId),
      closePanel: () => requestPanelClose(),
      // v0.9.3 需求8：压缩命令面（上下文水位环插件消费——自内置渲染迁出）。
      compactSession: () => void handleCompactSession(),
      isCompacting: compacting,
      capabilities: { compact: supportsCompact },
      autoCompaction: autoCompactionPref ?? null,
      setAutoCompaction: (enabled) => void handleAutoCompactionChange(enabled),
      confirmDialog: (opts) => confirmDialog(opts),
      // v0.9.4 需求12：插件底座日志能力（dev 日志中心，plugin 类别）。
      devLog: (message, data) => devLog("plugin", message, data),
      task: taskPanelCtx,
      sessionId: selectedSession && selectedSession !== "new" ? selectedSession : null,
      sessionTitle:
        selectedSession && selectedSession !== "new"
          ? sessions?.find((item) => item.id === selectedSession)?.display_name ?? null
          : null,
      messages: ctxMessages,
      streamState: ctxStreamState,
      sessionMeta: ctxSessionMeta,
      // v0.9.3 需求3（P1-3）：真订阅——四个数据面经 SessionDataHub（注册即回放
      // 快照，数据变更 publish 逐个回调，退订真实移除）；events 通道复用信号
      // 总线（本就是真订阅）。v0.9.2 的「cb 调一次返回 no-op」假订阅删除。
      subscribe: {
        messages: (cb) => dataHub.subscribeMessages(cb),
        streamState: (cb) => dataHub.subscribeStreamState(cb),
        sessionMeta: (cb) => dataHub.subscribeSessionMeta(cb),
        turns: (cb) => dataHub.subscribeTurns(cb),
        approvals: (cb) => dataHub.subscribeApprovals(cb),
        events: (cb) => subscribeSessionSignals(cb),
      },
      resolveSessionInfo: (sessionId: string) => {
        const taskSession = taskLaunchSessions.find(
          (item) => item.task_session_id === sessionId,
        );
        if (taskSession) return { title: taskSession.title, kind: "task" };
        if (nodeSessionIds.includes(sessionId)) {
          return { title: nodeTitleBySessionId[sessionId] ?? sessionId.slice(0, 12), kind: "node" };
        }
        const session = sessions?.find((item) => item.id === sessionId);
        if (session) {
          return {
            title: sessionNames?.[sessionId] || session.display_name || sessionId.slice(0, 12),
            kind: "session",
          };
        }
        return null;
      },
      };
    },
    [turnSummaries, activeTurnIndex, handleJumpToTurn, taskPanelCtx, selectedSession, sessions, ctxMessages, ctxStreamState, ctxSessionMeta, searchMessages, scrollToMessage, insertToComposer, taskLaunchSessions, nodeSessionIds, nodeTitleBySessionId, sessionNames, confirmDialog, openViewer, dataHub],
  );

  // v0.9.3 需求3：数据面变更 → 枢纽 publish（订阅者逐个回调）。
  useEffect(() => {
    dataHub.publishMessages(ctxMessages);
  }, [dataHub, ctxMessages]);
  useEffect(() => {
    dataHub.publishStreamState(ctxStreamState);
  }, [dataHub, ctxStreamState]);
  useEffect(() => {
    dataHub.publishSessionMeta(ctxSessionMeta);
  }, [dataHub, ctxSessionMeta]);
  useEffect(() => {
    dataHub.publishTurns(turnSummaries);
  }, [dataHub, turnSummaries]);

  // v0.9.2 需求1 M4：信号桥（内核事件 → 已启用插件 event-hook）。
  // 任务失败信号：run 状态转 failed 时发射。
  const prevRunStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const status = taskPanelCtx?.runStatus ?? null;
    const prev = prevRunStatusRef.current;
    prevRunStatusRef.current = status;
    if (status === "failed" && prev !== "failed" && taskPanelCtx) {
      emitSessionSignal({ type: "task-run-failed", taskId: taskPanelCtx.taskId, title: taskPanelCtx.title });
    }
  }, [taskPanelCtx]);

  // 退出任务模式时清理图数据，避免残留 run 状态。
  // 注意：不依赖 taskGraph（每次渲染是新对象，会导致死循环），通过 ref 调用。
  useEffect(() => {
    if (!taskModeActive) {
      taskGraphRef.current.clearGraph();
      setTaskBoardOpen(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskModeActive]);

  // 任务模式 + 执行阶段 + 未选节点 = 三段合流视图：
  // conductor 会话（需求 + 规划）→「流程执行」分隔线 →（未启动：确认卡 / 已启动：run 事件流）。
  // T8-P1：这里**不再**替换主区，只是在会话流末尾追加执行段，输入框保持可用。
  // v0.9.7 需求2：执行段呈现条件放宽——有图任务走 run 卡；无图单对话流任务
  // 走 runner 步骤卡（stages_json 数据源）。
  const taskRunnerCard = useMemo(
    () => parseRunnerCard(activeTaskLaunchInstance?.stages_json),
    [activeTaskLaunchInstance?.stages_json],
  );
  // 需求9 #1：无图 runner 任务全步骤终态且无待答问题 = 任务收尾——
  // 「流程执行」分隔线与空态方案卡不再渲染（去阶段化遗留的有图渲染链，
  // 任务完成后切回会话时空态文案+分隔线残留即此）。
  const taskRunnerFinished =
    !activeTaskLaunchInstance?.graph_id &&
    taskRunnerCard.steps.length > 0 &&
    taskRunnerCard.steps.every((s) => s.status === "done" || s.status === "failed") &&
    !taskRunnerCard.pendingQuestion;
  const taskExecutionMode =
    taskModeActive &&
    !taskSelectedNodeId &&
    !taskRunnerFinished &&
    (Boolean(activeTaskLaunchInstance?.graph_id) ||
      taskRunnerCard.steps.length > 0 ||
      Boolean(taskRunnerCard.pendingQuestion));
  // 已完成 / 已存在但终态的 run 重进时，restoreLatestRun 把 activeRunId 置 null、只保留
  // displayedRunId（= activeRunId ?? lastRunId）。必须用 displayedRunId 兜底，否则：
  // - 重进已完成任务 → 回退成「是否开始执行」卡，且分隔线下的执行内容被挡住不显示；
  // - live 跑完那一刻 pollRunProjection 清 activeRunId，也会闪回开始卡。
  const taskRunStarted = Boolean(taskGraph.displayedRunId ?? activeTaskLaunchInstance?.active_run_id);

  // ── 簇C 任务执行段（v0.9.7 需求2 补充：迁自本文件 use-task-execution-stage）──
  const {
    execStarting,
    execStartError,
    taskPlanNodes,
    taskFlowNodes,
    nodeActionBusy,
    showExecutionStartPrompt,
    handleConfirmPlan,
    handleStartExecutionFromChat,
    handlePlanAssignAgent,
    handleRetryNode,
    handleSkipNode,
    setExecPromptDismissedTaskId,
  } = useTaskExecutionStage({
    taskExecutionMode,
    taskRunStarted,
    activeTaskLaunchInstance,
    taskGraph,
    taskGraphRef,
    boardRunId,
    projectPath: currentProject?.path ?? null,
    agents,
    confirmDialog,
    isAwayFromBottomRef,
    messageAreaRef,
    sessionMessagesLength: sessionMessages.length,
  });


  // 选中一个还没跑过的步骤时，主区给出明确占位——否则会继续显示上一个会话，
  // 用户以为点击没生效（需求：「点击右侧每一行都能看到每一条的执行情况」）。
  // v0.7.0 需求二-问题3：改按 node run 状态判定。只有完全不存在或状态为
  // blocked/ready 才算"未开始"；一旦状态进入 leased/running（即使 session_id 暂为 null），
  // 让出主区给节点会话渲染（显示流式占位而非"未开始"），避免节点内容延迟到完成才显示。
  const selectedNodeRun = taskSelectedNodeId ? taskGraph.nodeRuns[taskSelectedNodeId] : undefined;
  const taskSelectedNodeNotStarted =
    taskModeActive &&
    !!taskSelectedNodeId &&
    (!selectedNodeRun ||
     selectedNodeRun.attempt_count <= 0 ||
     selectedNodeRun.status === "blocked" ||
     selectedNodeRun.status === "ready");
  // v0.7.0 需求二-问题3：节点已进入 leased/running 但 session_id 尚未由 Pi RPC
  // SessionResolved 回填（selectedSession 为 "pending-node" 占位）。此时主区显示
  // "正在建立会话"占位，而非主流程会话内容，避免节点会话和主流程混在一起。
  const taskSelectedNodeStarting = selectedSession === "pending-node";

  // T8-P10：节点会话的流式输出与常规会话**同一套机制**——
  // `agent-event` → `streamStore` → `useSessionStream` → `StreamingMessage`。
  // 先前 orchestrator 的节点子代理只把事件推进 runtime_bridge 的 channel emitter
  // （供执行引擎消费），从不到达 webview，所以前端无从流式；P9 曾用轮询重读 JSONL 兜底，
  // 那是「另一套机制」，已废弃。现在由 Tauri 层向 orchestrator 注入 NodeEventSink
  // （见 lib.rs setup / runtime_bridge），节点事件与聊天事件走同一条 `agent-event` 通道，
  // 前端无需任何节点专用刷新逻辑。

  // ── 簇C 任务执行段逻辑：已迁 use-task-execution-stage ──



  // taskLaunch 切标签时的阶段锚点定位：discuss/plan 同一 conductor 会话，切标签需滚到
  // 对应 PhaseDivider（data-phase），而非总会话顶部。仅在 taskLaunchPhase 变化时定位，
  // 不打扰用户在当前标签内的浏览。TaskPhaseContainer 路径由 PhaseConversationShell 自身处理。
  // ⚠️ prevLaunchPhaseRef 只在定位成功后更新——流式期间或消息未加载时不标记完成，
  // 等 isStreaming 变 false 或 sessionMessages.length 变化后自动重试。
  const prevLaunchPhaseRef = useRef<TaskLaunchPhase | null>(null);
  useEffect(() => {
    if (!taskLaunchOpen || taskModeActive) return;
    if (!selectedSession || selectedSession === "new") return;
    if (prevLaunchPhaseRef.current === taskLaunchPhase) return;
    if (currentStream?.isStreaming) return; // 流式中不抢滚动，等结束后重试
    const anchor = taskLaunchPhase === "requirements" ? "discuss" : "plan";
    const container = messageAreaRef.current;
    if (!container) return;
    const el = container.querySelector(`[data-phase="${anchor}"]`);
    if (el) {
      el.scrollIntoView({ block: "start" });
      prevLaunchPhaseRef.current = taskLaunchPhase;
    } else if (anchor === "discuss") {
      // discuss 锚点对应会话顶部；divider 尚未产生则滚顶（总是成功）。
      container.scrollTop = 0;
      prevLaunchPhaseRef.current = taskLaunchPhase;
    } else if (sessionMessages.length > 0) {
      // PhaseDivider 是流式瞬态块，不持久化——消息已加载但元素不存在 → 滚到底部（规划内容在末尾）。
      container.scrollTop = container.scrollHeight;
      prevLaunchPhaseRef.current = taskLaunchPhase;
    }
    // sessionMessages.length === 0 且元素未找到 → 消息尚在加载，等下次 dep 变化重试。
  }, [taskLaunchOpen, taskModeActive, taskLaunchPhase, selectedSession, currentStream?.isStreaming, sessionMessages.length]);

  /** 5f：/plugin <id>——共享实现（plugin-quick-run，命令面板 5e 同源）。 */
  const handleTaskLaunchBeforeSend = useCallback(async (_message: string) => {
    // 5f：/plugin <id> 本地命令（面板展开/默认动作）——不发给 agent。
    const pluginMatch = /^\/plugin\s+(\S+)\s*$/.exec(_message.trim());
    if (pluginMatch) {
      const fired = await runPluginQuickAction(pluginMatch[1], selectedSession);
      if (!fired) {
        console.warn(`[slash] /plugin ${pluginMatch[1]} 未命中可触发的插件或动作`);
      }
      return true;
    }
    // conductor 驱动的任务模式：首条消息由 prepareTaskLaunchMessage 包装为 /jishu-task 命令激活 conductor，
    // 无需前端拦截或技能安装检查（conductor 扩展随 Hub 启动自动部署）。消息正常发送。
    return false;
  }, []);

  // Stream listener (mount-only). Each chunk is routed into the per-session
  // store entry via streamStore.push, regardless of which session is currently
  // selected — that's what makes parallel streaming work.
  // v0.9.3 需求10 / M1①：agent-event 管线迁 kernel/event-pipeline（见模块头），
  // 壳层只组装依赖并挂载（mount-only，refs/setters——与原 effect 同语义）。
  useEffect(
    () =>
      startAgentEventPipeline({
        activeIdRef,
        activeTaskInstanceIdRef,
        chatInputRef,
        injectedLaunchSessionsRef,
        isAwayFromBottomRef,
        lastRealSessionIdRef,
        messageAreaRef,
        newSessionStreamIdsRef,
        pendingReplyStartedAtRef,
        abortLocalCommitRef,
        projectIdRef,
        projectPathRef,
        refetchSessionsRef,
        selectedSessionRef,
        selectedTaskSkillIdRef,
        sessionsRef,
        stagedApiRef,
        supportsSteerRef,
        taskLaunchOpenRef,
        taskLaunchPhaseRef,
        taskLaunchGoalRef,
        visitedSessions,
        setLiveThinkingLevel,
        setOptimisticSessions,
        setPendingApprovals,
        setPendingInteractions,
        setSelectedSession,
        setSessionMessages,
        applyTaskLaunchInstanceSnapshot,
        refreshSessionUsage,
        discoverConductorTask,
        t,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Derive display name for the current session
  const displayName = selectedSession
    ? (sessionNames?.[selectedSession] || sessions?.find(s => s.id === selectedSession)?.display_name || optimisticSessions.find(s => s.id === selectedSession)?.display_name || selectedSession.slice(0, 8))
    : "";
  // 选中节点会话时，主区头部显示节点标题（任务名），而非节点会话的裸 display_name（"1"/"2"）。
  const nodeHeaderTitle =
    taskModeActive && taskSelectedNodeId
      ? taskGraph.snapshot?.nodes.find((n) => n.node_id === taskSelectedNodeId)?.title ?? displayName
      : displayName;
  const projectDisplayName = currentProjectMeta?.custom_name || currentProject?.name || t("sessions.noProject");
  const projectPath = currentProject?.path ?? "";
  const activeModelLabel = activeModelValue
    ? modelPicker.labelFor(activeModelValue)
    : (t("sessions.activeModel") || "Pick model");
  // 模型选择器+水位圆环（v0.7.3 需求2 收尾）：移至发送按钮左侧同一行（trailingControls）。
  const modelTrailingControls = (
    supportsModelPicker ? (
        // v0.8.0 需求4 补充：min-w-0 + flex-wrap（去 shrink-0）——聊天区被
        // 预览顶窄时模型名/思考档/水位环在右侧组内折行，而不是向左溢出
        // 盖住会话模式 chip（重叠缺陷修复）。
        <span ref={modelMenuRef} className="relative inline-flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          {/* v0.8.0 需求4 补充（用户定序）：水位圆环 | 模型 | 思考强度——
              模型居中，圆环在其左（未对话/无用量数据时不渲染），思考档在其右。
              行宽 <560px 时模型名与思考档标签切换为图标（@container 由
              ChatInput 底部行声明，作用于整组）。
              v0.9.3 需求8：水位环迁移为 session.context-ring 插件（composer-
              trailing 挂载点，插件页可停用）。 */}
          <SessionComposerTrailing ctx={sessionKernelCtx} />
          {modelOptions.length === 0 ? (
            /* v0.9.2 需求10：黄色提示文案改为「前往配置」按钮——点击直达
               管理页模型设置并定位当前会话智能体（App 层切 manageAgent）。 */
            <button
              type="button"
              onClick={() => onNavigateAgentModels?.()}
              title={t("sessions.modelNotConfigured")}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 text-xs text-amber-500 transition-fast hover:bg-amber-500/20"
            >
              <Cpu className="h-3 w-3" />
              {t("sessions.goModelConfig")}
            </button>
          ) : (
            <>
              <button
                type="button"
                aria-label={t("sessions.activeModel") || "Active model"}
                aria-haspopup="menu"
                aria-expanded={modelMenuOpen}
                title={activeModelLabel}
                onClick={() => setModelMenuOpen((open) => !open)}
                className={cn(
                  "inline-flex h-7 max-w-[11rem] items-center gap-1.5 rounded-md text-xs font-mono text-muted-foreground transition-fast hover:bg-accent/30 hover:text-foreground",
                  modelMenuOpen && "bg-accent/30 text-foreground",
                )}
              >
                <Cpu className="hidden h-3.5 w-3.5 @max-[559px]:inline-flex" />
                <span className="min-w-0 truncate @max-[559px]:hidden">{activeModelLabel}</span>
                <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", modelMenuOpen && "rotate-180")} />
              </button>
              {modelMenuOpen && (
                <div className="absolute bottom-full right-0 mb-1 z-50 max-h-64 w-[230px] overflow-y-auto rounded-lg border border-border bg-popover p-2 shadow-lg">
                  {modelOptions.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      title={o.value}
                      onClick={() => {
                        setModelMenuOpen(false);
                        void modelPicker.select(o.value);
                      }}
                      className={cn(
                        "flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs font-mono transition-fast hover:bg-accent/60",
                        o.value === activeModelValue ? "font-medium text-foreground" : "text-muted-foreground",
                      )}
                    >
                      <span className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        o.value === activeModelValue ? "bg-primary" : "bg-transparent",
                      )} />
                      <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          {/* 思考强度居模型右侧（v0.8.0 需求4 补充用户定序）。 */}
          <ThinkingLevelSelect
            levels={modelPicker.thinkingLevels}
            value={thinkingLevelValue}
            onChange={(level) => void handleThinkingLevelChange(level)}
          />
        </span>
      ) : null
  );

  const startComposerFooter = currentProject ? (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/40 bg-muted/45 px-4 py-2.5 text-xs text-muted-foreground">
      {projectPath && (
        <span className="inline-flex min-w-0 items-center gap-1">
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[var(--icon-folder)]" />
          <span className="min-w-0 max-w-[45%] truncate text-left font-mono text-[0.92em]" title={`${t("sessions.projectPath")}: ${projectPath}`}>
            {projectPath}
          </span>
          {/* 单个左右堆叠箭头图标：进入项目管理页（切换项目） */}
          <button
            type="button"
            onClick={onSwitchProject}
            title={t("sessions.switchProject")}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-fast hover:bg-accent/45 hover:text-foreground"
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
          </button>
        </span>
      )}
      {!supportsModelPicker && (
        /* v0.9.3 需求8：水位环迁移为 session.context-ring 插件（无模型行位点）。 */
        <SessionComposerTrailing ctx={sessionKernelCtx} />
      )}
      {/* v0.7.0 需求一：原静态智能体展示位改为可切换（AgentSwitcher 受控）。
          新会话可切换（切换 = 新建会话）；任务态只有 jishu agent 可用，保持静态展示。 */}
      {taskLaunchOpen ? (
        <span className="inline-flex min-w-0 items-center gap-1.5" title={active?.display_name ?? ""}>
          {active ? <AgentLogo agentId={active.id} size={14} /> : null}
          <span className="truncate">{active?.display_name ?? t("sessions.currentAgent")}</span>
        </span>
      ) : (
        <AgentSwitcher value={activeId} onChange={setChatAgent} dropUp>
          {active && (
            <span className="truncate">{active.display_name}</span>
          )}
        </AgentSwitcher>
      )}
    </div>
  ) : null;

  return (
    <BlockRenderersProvider enabled={enabledSessionPlugins}>
    <PluginSignalBridge enabled={enabledSessionPlugins} ctx={sessionKernelCtx} />
    <div className="flex h-full">
      <ChatSidebar
        currentProject={currentProject}
        projectDisplayName={projectDisplayName}
        projectId={projectId}
        projectPath={projectPathForSettings}
        sidebarCollapsed={sidebarCollapsed}
        setSidebarCollapsed={setSidebarCollapsed}
        taskLaunchOpen={taskLaunchOpen}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        showMessageSearchControls={showMessageSearchControls}
        messageSearchLabel={messageSearchLabel}
        messageSearchTotal={messageSearchTotal}
        requestMessageSearchNavigation={requestMessageSearchNavigation}
        searchResults={searchResults}
        displaySessions={displaySessions}
        sessionNames={sessionNames}
        selectedSession={selectedSession}
        streamingSessionIds={streamingSessionIds}
        refreshingSessionId={refreshingSessionId}
        regularSessionsOpen={regularSessionsOpen}
        setRegularSessionsOpen={setRegularSessionsOpen}
        canForkSession={Boolean(capabilities?.has("SESSION_FORK"))}
        canDeleteSession={Boolean(capabilities?.has("SESSION_DELETE"))}
        forking={forking}
        displayTaskLaunchSessions={displayTaskLaunchSessions}
        activeTaskInstanceId={activeTaskInstanceId}
        activeTaskInstanceIdRef={activeTaskInstanceIdRef}
        findTaskInstance={findTaskInstance}
        openTaskSession={openTaskSession}
        onLaunchMenuPlugin={(prompt) => {
          void handleNewSession();
          window.setTimeout(() => {
            chatInputRef.current?.restoreTexts([prompt]);
            chatInputRef.current?.focus();
          }, 200);
        }}
        handleTaskCancelRun={handleTaskCancelRun}
        setTaskLaunchSessions={setTaskLaunchSessions}
        confirmDialog={confirmDialog}
        handleNewSession={handleNewSession}
        handleRefresh={handleRefresh}
        handleOpenTaskConversation={handleOpenTaskConversation}
        handleSelectSession={handleSelectSession}
        handleFloatSession={handleFloatSession}
        handleResumeSession={handleResumeSession}
        handleForkSession={handleForkSession}
        handleDeleteSession={handleDeleteSession}
        handleRefreshSession={handleRefreshSession}
        setRenameOpen={setRenameOpen}
        setRenameTaskTarget={setRenameTaskTarget}
      />

      {/* Right: Chat area */}
      <div className="relative flex-1 flex flex-col min-w-0 bg-background">
        {/* v0.9.2 需求1 P4 + v0.9.4 需求7 测试期（用户裁决）：贴边挂件宿主
            定位于「标题以下会话区」（top 避开标题栏、上下留固定间隔）——
            导航条在该区间居中，不顶格。 */}
        <div className="absolute left-0 top-24 bottom-10 w-6 pointer-events-none">
          <SessionRailSlot ctx={sessionKernelCtx} />
        </div>
        {/* 新建任务对话（TaskInstance 尚未创建）的顶栏：标题 + 关闭。
            减法重构：TaskHeaderBar 已随 TaskWorkspace 退役，这里用内联顶栏保留关闭能力，
            不引入独立组件；任务激活后主区沿用 chat-page 常规会话头。 */}
        {projectId && taskLaunchOpen && !taskModeActive ? (
          <div
            className="flex items-center justify-between px-5 h-[44px] border-b border-border/30"
            style={{ background: "var(--color-layer-1)" }}
          >
            <span className="font-medium text-sm truncate">
              {activeTaskLaunchInstance?.title ?? t("tasks.startTask", "新任务")}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => {
                logTaskPhaseDebug("launch-nav:close", {
                  taskId: activeTaskInstanceIdRef.current,
                  activePhase: taskLaunchPhaseRef.current,
                  status: activeTaskLaunchInstance?.status ?? null,
                });
                setTaskLaunchOpen(false);
                setTaskLaunchReadOnly(false);
                taskLaunchOpenRef.current = false;
                setActiveTaskInstanceId(null);
                setActiveTaskRequirementFile(null);
                activeTaskInstanceIdRef.current = null;
                activeTaskRequirementFileRef.current = null;
                lastKnownStatusRef.current = null;
              }}
              title={t("common.close", "关闭")}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : null}
        {!projectId ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
            <div className="h-14 w-14 rounded-2xl bg-muted flex items-center justify-center">
              <MessageSquare className="h-7 w-7 text-[var(--icon-message)]" />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm">{t("sessions.noProject")}</span>
              <button
                onClick={onSwitchProject}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm text-primary hover:bg-primary/10 transition-fast font-medium"
              >
                <span className="leading-none pt-[1px]">{t("sessions.switchProject")}</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ) : showStartComposer ? (
          // Start-composer view: the heading + centered ChatInput are rendered
          // in the unified ChatInput block below (kept in ONE React element
          // position across start-composer and active-session views so the
          // ChatInput instance — and its stagedMessagesBySession state — is
          // preserved across session switches). This branch collapses the
          // message area so the unified block can take flex-1 and center.
          <div className="hidden" />
        ) : (
          <>
            {!taskLaunchOpen ? (
              <>
            {/* Session header */}
            {selectedSession && selectedSession !== "new" ? (
              <div className="flex items-center justify-between px-5 h-[44px] border-b border-border/30" style={{ background: "var(--color-layer-1)" }}>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-medium text-sm truncate">{nodeHeaderTitle}</span>
                  <span className="text-[11px] text-muted-foreground/50 font-mono shrink-0">{selectedSession.slice(0, 8)}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => handleFloatSession(selectedSession)}
                    title={t("sessions.float", "悬浮窗口")}
                  >
                    <PictureInPicture2 className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => void handleRefreshSession(selectedSession)}
                    disabled={Boolean(currentStream) || refreshingSessionId === selectedSession}
                    title={currentStream ? t("sessions.refreshDisabledWhileStreaming") : t("sessions.refreshSession", "刷新会话")}
                  >
                    <RotateCw className={cn("h-3.5 w-3.5", refreshingSessionId === selectedSession && "animate-spin")} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => handleResumeSession(selectedSession)}
                    disabled={loadingSessionId === selectedSession}
                    title={t("sessions.openTerminal")}
                  >
                    <TerminalIcon className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon-xs" onClick={() => setRenameOpen(true)} title={t("sessions.rename")}>
                    <Pencil className="h-3 w-3" />
                  </Button>
                  {/* v0.9.2 需求1 M4：插件头部动作宿主（会话导出等轻动作）。 */}
                  <SessionPluginActions ctx={sessionKernelCtx} enabled={enabledSessionPlugins} />
                </div>
              </div>
            ) : (
              <div className="px-5 h-[44px] flex items-center border-b border-border/30" style={{ background: "var(--color-layer-1)" }}>
                <span className="font-medium text-sm text-muted-foreground">{t("sessions.newChat")}</span>
              </div>
            )}
              </>
            ) : null}
              {/* Messages */}
              <div className="relative flex-1 min-h-0">
                {/* v0.9.2 需求1：停靠面板宿主（五槽位/浮动/快捷图标）——通用容器，
                    无已显示面板时零渲染；M3 任务流程全景为首个真实面板。 */}
                <SessionPanelLayer ctx={sessionKernelCtx} />
                {/* v0.9.2 测试期：侧边栏面板宿主（sidebar-panel 挂载形态，挤压式
                    布局；与悬浮宿主平行，由能力中心统一调度）。 */}
                <SessionSidebarLayer ctx={sessionKernelCtx} />
                {/* v0.9.7 需求6 F2（P2-15）：产物引用上下文——校验基准
                    project_root 来自 currentProject（不依赖进程表），sessionId
                    用 selectedSession；projectPath 判空（null 时仅绝对路径可点）。 */}
                <SessionArtifactContext.Provider
                  value={{ projectPath: currentProject?.path ?? null, sessionId: selectedSession }}
                >
                <div ref={messageAreaRef} className="h-full overflow-y-auto">
                {taskSelectedNodeNotStarted ? (
                  // 选中的步骤还没执行过——直接说明，而不是把上一段会话继续摆在这里。
                  <div className="mx-auto w-full max-w-[var(--message-content-max-width)] px-4 py-8 text-center text-[12px] text-muted-foreground">
                    {t("task.execution.nodeNotStarted")}
                  </div>
                ) : taskSelectedNodeStarting ? (
                  // v0.7.0 需求二-问题3：节点正在执行但会话尚未建立（session_id 待 Pi RPC 回填）。
                  // 显示占位而非主流程会话，避免节点会话和主流程混在一起。
                  <div className="mx-auto w-full max-w-[var(--message-content-max-width)] px-4 py-8 text-center text-[12px] text-muted-foreground">
                    {t("task.execution.nodeStarting")}
                  </div>
                ) : selectedSession && selectedSession !== "new" ? (
                  // v0.9.1 需求5：data-turn-scope="main" 圈定主会话列表——横杠
                  // 导航轨的轮次定位/滚动侦测只在此作用域内查询，任务执行投影
                  // 的第二个 MessageView 不参与计数。无样式普通块级 div，
                  // 不影响内层 mx-auto 居中布局。
                  <div data-turn-scope="main">
                    <MessageView
                      messages={sessionMessages}
                      sessionId={selectedSession}
                      searchQuery={searchQuery}
                      searchNavigation={messageSearchNavigation}
                      onSearchStatusChange={handleMessageSearchStatusChange}
                      flat
                      scrollContainerRef={messageAreaRef}
                      expandSignal={messageExpandSignal}
                    />
                  </div>
                ) : null}
                {/* T8-P1 三段合流（需求六）：执行阶段不是独立页面，而是在上方 conductor 会话
                    （需求 + 规划）末尾接一条「流程执行」分隔线，再往下追加执行内容——
                    未启动时是「是否开始执行」确认卡，已启动后是 run 事件流。 */}
                {taskExecutionMode ? (
                  <>
                    <div className="mx-auto w-full max-w-[var(--message-content-max-width)] px-4">
                      <PhaseDivider phase="execute" title={t("task.phase.execution", "流程执行")} />
                    </div>
                    {/* v0.9.7 需求2：runner 步骤卡——无图单对话流任务的主任务卡
                        （灯语言 + ask_user 待决策高亮）；有图任务未启动 run 时
                        与方案卡并存靠下（以方案卡为先）。 */}
                    {!activeTaskLaunchInstance?.graph_id && !taskRunStarted && (
                      <TaskStepsCard
                        steps={taskRunnerCard.steps}
                        pendingQuestion={taskRunnerCard.pendingQuestion}
                      />
                    )}
                    {taskRunStarted ? (
                      /* v0.9.2 测试期修复（终态渲染两遍流程）：run 终态时节点卡列表
                         与汇总卡的节点行重复展示同一套流程（用户实测「显示两遍」）。
                         终态只渲染汇总卡——其节点行自带状态图标/标题/执行 agent，
                         且整行可点击进入会话；节点卡列表仅承担执行中的实时呈现。 */
                      taskGraph.runStatus && ["completed", "failed", "cancelled"].includes(taskGraph.runStatus) ? (
                        <TaskSummaryCard
                          runStatus={taskGraph.runStatus}
                          nodes={taskFlowNodes}
                          onSelectNode={handleTaskSelectNode}
                          onRetryNode={(nodeId) => void handleRetryNode(nodeId)}
                          onSkipNode={(nodeId) => void handleSkipNode(nodeId)}
                          nodeActionBusy={nodeActionBusy}
                        />
                      ) : (
                        <TaskNodeCards
                          nodes={taskFlowNodes}
                          onSelectNode={handleTaskSelectNode}
                        />
                      )
                    ) : activeTaskLaunchInstance?.graph_id ? (
                      showExecutionStartPrompt ? (
                      /* v0.9.2 需求2 M3-2：方案卡——勾选执行哪些子任务后确认。
                         需求9 #1：仅限有图任务——无图 runner 任务的 snapshot 恒空，
                         空态方案卡（「流程尚未生成步骤…」）与任务形态不符。 */
                      <TaskPlanCard
                        nodes={taskPlanNodes}
                        canStart={Boolean(taskGraph.revision?.revision_id)}
                        starting={execStarting}
                        error={execStartError}
                        onConfirm={(selectedIds) => void handleConfirmPlan(selectedIds)}
                        onDismiss={() =>
                          setExecPromptDismissedTaskId(activeTaskLaunchInstance?.task_id ?? null)
                        }
                        onOpenCanvas={() => setTaskBoardSignal((n) => n + 1)}
                        assignableAgents={agents}
                        agentsLoading={healthLoading}
                        onAssignAgent={(nodeId, agentId) => void handlePlanAssignAgent(nodeId, agentId)}
                      />
                    ) : (
                      /* v0.9.2 测试期修复：收起方案卡后不再死路——提供恢复入口
                         （原侧栏「开始执行」替代路径已随 M3-5 退役）。
                         布局与其他执行段卡片同构（独立块 + 按钮在文字下方）。 */
                      <div className="mx-auto w-full max-w-[var(--message-content-max-width)] px-4 py-2">
                        <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5">
                          <div className="text-[12px] text-muted-foreground">
                            {t(
                              "task.execution.awaitingStart",
                              "流程尚未开始。可继续在下方对话中调整流程。",
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => setExecPromptDismissedTaskId(null)}
                            className="mt-2 flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-background px-2.5 text-[12px] text-foreground/80 transition-fast hover:bg-accent hover:text-foreground"
                          >
                            {t("task.execution.showPlanCard", "返回执行流程")}
                          </button>
                        </div>
                      </div>
                      )
                    ) : null}
                  </>
                ) : null}
                {/* Only show StreamingMessage while the stream is active.
                    Once isStreaming flips to false the turn is complete and the
                    committed messages are already rendered by MessageView above —
                    keeping the streaming preview would duplicate interaction cards
                    and other content. */}
                {currentStream?.isStreaming && selectedSession && selectedSession !== "new" && !taskSelectedNodeNotStarted && (
                  <StreamingMessage
                    key={selectedSession}
                    sessionId={selectedSession}
                    isComplete={false}
                    scrollContainerRef={messageAreaRef}
                    agentDisplayName={active?.display_name}
                  />
                )}
              {/* Live placeholders for guided (steer) messages that have NOT
                  yet been injected. Shown the instant the user clicks "guide",
                  positioned AFTER the streaming bubble so they sit at the guide
                  position (below the in-progress reply). Once Pi delivers a
                  steer at a tool-call gap (steer_injected marker) it is rendered
                  INLINE inside <StreamingMessage> (via steerTexts) at its real
                  split position, so we drop it from this bottom block to avoid
                  showing it twice — `steerTexts.length` guides have moved
                  inline. The remaining (not-yet-injected) guides stay here until
                  the turn completes, at which point turn_complete commits them
                  into sessionMessages and drops them from this list. */}
                {(() => {
                if (!selectedSession || selectedSession === "new") return null;
                const steerInjectedCount = currentStream?.steerTexts?.length ?? 0;
                // v0.9.4 需求7 测试期重构：占位从 SteerCoordinator 队列派生
                //（单一真源；已注入数随流内 steerTexts 前置隐藏）。
                const queueKey = steerCoordinator.isEmpty(selectedSession)
                  && currentStream?.resolvedId
                  ? currentStream.resolvedId
                  : selectedSession;
                const visible = steerCoordinator.queueOf(queueKey)
                  .slice(steerInjectedCount)
                  .map((item) => ({
                    role: "user" as const,
                    // v0.9.4 需求8 补充：stage 文本即发送文本（含附件标记块），
                    // 占位文本剥标记显示，附件经 InlineImages 渲染缩略。
                    content: [{
                      type: "text" as const,
                      // 剥标记后为空（纯图片引导）→ 通用附件提示，不回退原文
                      //（用户实测：标记块全文被 || 回退显示）。
                      text: stripImagePrompt(item.text) || (item.text.includes("JISHU_HUB_IMAGES") ? t("sessions.imageOnlyBubble", "📎 发送了附件") : item.text),
                      tool_ids: item.toolIds ?? [],
                    }],
                    attachmentsText: item.text,
                    timestamp: 0,
                  }));
                if (visible.length === 0) return null;
                return (
                  <div className="mx-auto w-full max-w-[var(--message-content-max-width)] space-y-2 px-4 py-1">
                    {visible.map((msg, i) => {
                      const textBlock = msg.content.find((c) => c.type === "text");
                      const text = textBlock?.text ?? "";
                      const attachmentsText = (msg as { attachmentsText?: string }).attachmentsText ?? "";
                      const steerToolIds = (textBlock && textBlock.type === "text" ? textBlock.tool_ids : undefined) ?? [];
                      return (
                        <div
                          key={`pending-steer-${steerInjectedCount + i}`}
                          className="w-full flex justify-end"
                          data-user-message="true"
                        >
                          <div className="max-w-[88%] min-w-0 flex flex-col items-end">
                            <div className="flex items-center gap-2 mb-0.5 text-[11px]">
                              <span className="font-medium text-muted-foreground">{t("sessions.user")}</span>
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-600 dark:text-amber-500">
                                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                                {t("sessions.steered")}
                              </span>
                            </div>
                            <div
                              className="rounded-xl px-3 py-2 bg-[var(--message-user-bg)] text-[var(--message-user-fg)] overflow-hidden min-w-0 max-w-full"
                              style={{ fontSize: "var(--font-size-prose)" }}
                            >
                              <InlineImages text={attachmentsText} />
                              <UserTextWithPills text={text} toolIds={steerToolIds} toolNames={steerToolNames} />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
                </div>
                </SessionArtifactContext.Provider>
              </div>
          </>
        )}
        {/* Unified ChatInput — rendered in ONE React element position across
            the start-composer view and the active-session view. Keeping the
            component instance stable (same parent, same child slot, no key)
            preserves its stagedMessagesBySession state across session switches;
            previously two separate <ChatInput> instances in mutually-exclusive
            branches unmounted/remounted on switch, losing staged guides.
            Layout adapts via conditional
            sibling elements + className — ChatInput itself never moves. */}
        {/* T8-P1：执行阶段**不再**隐藏输入——用户需要能在会话区让主进程调整流程（需求六）。
            仅当任务模式下确实没有可发送目标时才隐藏：没有 conductor 会话，或选中的步骤
            还没跑过（此时发消息会落到上一段会话，属于误发）。 */}
        {shouldRenderGlobalChatInput({
          projectId,
          taskModeActive: taskModeActive && (!selectedSession || taskSelectedNodeNotStarted),
        }) && (
          <div className={showStartComposer
            ? "flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10"
            : "relative shrink-0"
          }>
            {showStartComposer ? (
              <h1 className="mb-14 w-full max-w-[var(--message-content-max-width)] text-center text-[2rem] font-medium leading-tight tracking-normal text-foreground">
                {taskLaunchOpen
                  ? t("tasks.createPrompt", { project: projectDisplayName })
                  : t("sessions.startPrompt", { project: projectDisplayName })}
              </h1>
            ) : isAwayFromBottom ? (
              <button
                onClick={handleScrollToBottom}
                className="absolute -top-10 left-1/2 -translate-x-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-border/40 bg-background/80 text-muted-foreground shadow-sm backdrop-blur-sm transition-all hover:bg-accent hover:text-foreground hover:border-border/60 hover:shadow-md opacity-60 hover:opacity-100"
                title={t("sessions.scrollToBottom", "滚动到底部")}
              >
                <ChevronDown className="h-4 w-4" strokeWidth={2.5} />
              </button>
            ) : null}
            <ChatInput
              ref={chatInputRef}
              sessionId={selectedSession === "new" ? null : selectedSession}
              projectPath={currentProject?.path ?? null}
              agentId={activeId}
              stagedApiRef={stagedApiRef}
              onMessageSent={handleMessageSent}
              onSessionResolved={handleSessionResolved}
              onBeforeSend={handleTaskLaunchBeforeSend}
              prepareMessageForAgent={prepareTaskLaunchMessage}
              allowFiles={capabilities ? (capabilities.has("FILE_INPUT") || capabilities.has("IMAGE_INPUT")) : true}
              agentDisplayName={active?.display_name}
              disabled={taskLaunchOpen && (!taskModeCanSend || taskLaunchReadOnly)}
              initialDraft={getSessionDraft(draftSessionKey)}
              historyScope={projectId}
              onDraftChange={(v) => setSessionDraft(draftSessionKey, v)}
              slashCommands={slashCommands}
              trailingControls={modelTrailingControls}
              onSlashCommand={handleSlashCommand}
              containerClassName={showStartComposer ? "mx-auto w-full max-w-[var(--message-content-max-width)] px-0 pb-0 pt-0" : undefined}
              panelClassName={showStartComposer ? "rounded-[22px] border-border/70 bg-card/98 shadow-[0_18px_48px_rgba(0,0,0,0.10)]" : undefined}
              contextFooter={startComposerFooter}
              workModeLabel={t("sessions.workMode.label")}
              workModeOptions={workModeOptions}
              // 工作模式显示反映「当前会话处于任务上下文」的两种形态：任务
              // 发起弹窗（taskLaunchOpen）或已打开任务工作台（taskModeActive，
              // 含重进打开已有任务——修复重进后输入框误显示会话模式）。切换
              // 到会话模式走 handleWorkModeChange 的全量重置（两者均覆盖）。
              workModeValue={
                taskLaunchOpen ||
                taskModeActive ||
                // 需求9 #5：「⚡不询问」chip 绑定会话身份而非易失 UI 状态——
                // 切会话/点桌面通知会重置 taskModeActive，但任务会话本体
                // （settings.json 的 taskNoAsk 仍生效）应保持不询问入口可切换。
                taskLaunchSessionIds.has(selectedSession ?? "")
                  ? "task"
                  : "chat"
              }
              onWorkModeChange={handleWorkModeChange}
              taskNoAsk={taskNoAsk}
              onTaskNoAskChange={handleTaskNoAskChange}
              accessModeLabel={accessModeLabel}
              accessModeTitle={supportsAccessModeSwitch ? t("sessions.accessMode") : t("sessions.accessModeReadOnly")}
              accessModeReadOnly={!supportsAccessModeSwitch}
              accessModeOptions={accessModeOptions}
              accessModeValue={accessModeValue ?? undefined}
              onAccessModeChange={handleAccessModeChange}
              interactionRequest={activeInteraction?.request}
              onInteractionSubmit={handleInteractionSubmit}
              onAbort={async () => {
                if (selectedSession) {
                  const state = streamStore.getState(selectedSession);
                  const finalKey = state?.resolvedId ?? selectedSession;
                  // v0.9.5 需求2 测试期修正（会话 01a0ed19 实证）：停止幂等改
                  // 「回合令牌」比对（废弃 v0.9.4 需求7 修复六的 10s 墙钟窗口）。
                  // 实证链：spawn 期（②正在赶来）停止后终结者可滞后数十秒（握手
                  // 预算 150s），期间②气泡与停止键不撤 → 用户连点 6 次，第 4 次
                  //（首次提交后 13.1s）落在 10s 窗口外 → 同一滞留流再次本地提交
                  // pendingUserMessage → 用户消息重复渲染。同令牌（同回合）永久
                  // 跳过；新回合（新 start 铸新令牌）自动放行，不依赖时间假设。
                  {
                    const committedToken = abortLocalCommitRef.current.get(finalKey)
                      ?? abortLocalCommitRef.current.get(selectedSession);
                    if (committedToken !== undefined && committedToken === state?.turnToken) {
                      devLog("session", "onAbort 幂等命中（跳过重复提交）", { session: selectedSession });
                      return;
                    }
                  }
                  if (state) {
                    // v0.9.4 需求13：纯压缩流（压缩 divider 起的续流）停止时
                    // 跳过本地提交——无可提交的回合内容（pending=null、无
                    // partial 文本/思考/工具），提交只会产生一条"压缩中…"
                    // 占位消息，与压缩结束沿统一提交的"已压缩/已取消"divider
                    // 形成双条。pi 的 abort 含 abortCompaction：取消后
                    // compaction_end(aborted) → pipeline 终结沿统一收口。
                    const isPureCompaction = state.pendingUserMessage === null
                      && state.text === "" && state.thinking === ""
                      && state.tools.length === 0 && state.steerTexts.length === 0
                      && state.content.length > 0
                      && state.content.every((b) => b.type === "phase_divider" && b.phase === "compaction");
                    if (isPureCompaction) {
                      devLog("session", "onAbort 纯压缩流（跳过本地提交，等待压缩取消收口）", { session: finalKey });
                      abortLocalCommitRef.current.set(finalKey, state.turnToken);
                      if (selectedSession !== finalKey) {
                        abortLocalCommitRef.current.set(selectedSession, state.turnToken);
                      }
                      return;
                    }
                    const newMessages: Message[] = [];
                    if (state.pendingUserMessage) {
                      newMessages.push({
                        role: "user",
                        content: [{ type: "text", text: state.pendingUserMessage }],
                        timestamp: Date.now(),
                      });
                    }
                    const assistantContent = buildAssistantContentFromStreamState(state);
                    const interactionInsertions = buildInteractionInsertions({
                      assistantContent,
                      interactionSplits: state.interactionSplits,
                      includePending: true,
                    });
                    // v0.9.4 需求7 缺陷一：已注入 steer 的交错提交必须在本地
                    //（停止时）完成——晚到的 TurnComplete(Aborted) 依赖事件
                    // 异步到达，用户新消息可能先 append，导致 steer 落位在
                    // 新消息之后（顺序错乱）。与 turn_complete 的 interaction
                    // 分支同构（steerInsertions 参数）。
                    const steerSplits = Array.from(new Set(state.steerSplits))
                      .filter((idx) => idx > 0 && idx < state.content.length)
                      .sort((a, b) => a - b);
                    // 注入事实以流内 steerTexts 为准（steer_injected 已同步
                    // 消费 coordinator 队列）。
                    const injectedSteerTexts = state.steerTexts ?? [];
                    const midSteerCount = Math.min(steerSplits.length, injectedSteerTexts.length);
                    const committed = commitAssistantWithInteractions({
                      assistantContent,
                      interactionInsertions,
                      steerInsertions: steerSplits.slice(0, midSteerCount).map((index, i) => ({
                        index,
                        text: injectedSteerTexts[i],
                      })),
                      error: state.error,
                    });
                    newMessages.push(...committed.messages);
                    // 消费已注入 steer 的队列与 live 占位（与交错提交等量；
                    // 未注入的残留交给 steer_queue_cleared 对账/重发，及
                    // TurnComplete(Aborted) 兕底，此处不动）。
                    if (midSteerCount > 0) {
                      steerCoordinator.consume(
                        steerCoordinator.isEmpty(finalKey) ? selectedSession : finalKey,
                        midSteerCount,
                      );
                    }

                    if (newMessages.length > 0) {
                      const baseMessages =
                        getCachedSessionMessages(finalKey)
                        ?? getCachedSessionMessages(selectedSession)
                        ?? [];
                      const updated = [...baseMessages, ...newMessages];
                      setCachedSessionMessages(finalKey, updated);
                      if (selectedSession !== finalKey) {
                        setCachedSessionMessages(selectedSession, updated);
                      }
                      setSessionMessages(updated);
                    }

                    if (interactionInsertions.length > 0) {
                      const sessionList = sessionsRef.current;
                      const sessionPath = sessionList?.find(s => s.id === finalKey)?.path
                        ?? sessionList?.find(s => s.id === selectedSession)?.path
                        ?? "";
                      invokeCommand("persist_interaction_blocks", {
                        agentId: activeId ?? "",
                        sessionPath,
                        sessionId: finalKey,
                        encodedName: projectId,
                        interactions: interactionInsertions.map((ins: InteractionInsertion) => ({
                          index: ins.index,
                          request_id: ins.requestId ?? null,
                          prompt: ins.prompt,
                          options: ins.options,
                          answer: ins.answer,
                          selected_options: ins.selectedOptions ?? [],
                          origin: ins.origin ?? null,
                        })),
                      }).catch((err: unknown) => {
                        console.warn("Failed to persist interaction blocks after abort:", err);
                      });
                    }

                    // Persist the in-progress assistant text/thinking of this
                    // aborted turn so it survives a refresh (twin of the call
                    // in the turn_complete(Aborted) handler). Idempotent on the
                    // backend, so the two racing paths never double-write.
                    if (state.text || state.thinking) {
                      const sessionList = sessionsRef.current;
                      const partialSessionPath = sessionList?.find(s => s.id === finalKey)?.path
                        ?? sessionList?.find(s => s.id === selectedSession)?.path
                        ?? "";
                      invokeCommand("persist_partial_assistant", {
                        agentId: activeId ?? "",
                        sessionPath: partialSessionPath,
                        sessionId: finalKey,
                        encodedName: projectId,
                        text: state.text,
                        thinking: state.thinking,
                      }).catch((err: unknown) => {
                        console.warn("Failed to persist partial assistant after abort:", err);
                      });
                    }
                    // v0.9.4 需求7 测试期重构：本地提交后**不再 drop**（旧 drop 在
                    // TurnComplete(Aborted) 到达前杀流，晚到终结者被 pushTracked
                    // 拒绝 → 重发收口永远不执行，用户实测引导 B+停止后 B 消失）。
                    // 改设标记：turn_complete(Aborted) 凭标记跳过重复提交，收口
                    //（steering 重发）照常——turn_complete 是唯一回合终结者。
                    devLog("session", "onAbort 本地提交+标记", { session: finalKey });
                    abortLocalCommitRef.current.set(finalKey, state.turnToken);
                    if (selectedSession !== finalKey) {
                      abortLocalCommitRef.current.set(selectedSession, state.turnToken);
                    }
                    // v0.9.5 需求2 测试期修复（会话 01a0ed19 实证）：②「正在赶来」
                    //（spawn 握手期：零事件/零内容/连接未解析）停止的本地终结。
                    // 此阶段无回合可收口——后端 abort_chat 走 ACP cancel 通道仅
                    // 入队（连接循环握手完成后才处理，预算 150s），终结者可滞后
                    // 数十秒；旧逻辑不 drop → ②气泡（含 pendingUserMessage 用户
                    // 消息）与已提交的本地副本即时双渲染，且停止键永驻诱导用户
                    // 反复点击。此处提交（仅用户消息，无回合内容可提交）后立即
                    // drop：气泡/停止键/列表动效同步撤下。晚到的 session_resolved
                    // 照常推进会话键解析（别名/resolvedOnce/乐观行升级与流状态
                    // 无关）；若 pi 竟先吐内容，pushTracked 以新回合自起续流
                    //（pending=null，无重复用户消息）；晚到的终结者无状态可终结
                    //（生命周期事件不能起续流）→ 静默跳过，无重复提交。
                    const isSpawnPhaseStream = state.isStreaming
                      && !state.hasReceivedEvent && !state.sessionResolved
                      && state.content.length === 0
                      && state.text === "" && state.thinking === ""
                      && state.tools.length === 0 && state.steps.length === 0
                      && state.steerTexts.length === 0
                      && state.interactionSplits.length === 0
                      && state.autoRetry === null && state.retryFailed === null
                      && state.error === "";
                    if (isSpawnPhaseStream) {
                      streamStore.drop(finalKey);
                      if (selectedSession !== finalKey) {
                        streamStore.drop(selectedSession);
                      }
                      devLog("session", "onAbort spawn 期终结（本地 drop：无回合可收口，②气泡/停止键立即撤下）", { session: finalKey });
                    }
                  }

                  setPendingInteractions((current) =>
                    current.filter((item) => item.sessionId !== selectedSession),
                  );
                  if (
                    !state
                    && !hasCachedSessionMessages(selectedSession)
                  ) {
                    // A null `state` here means the abort-originated
                    // turn_complete (e.g. Claude Code's ACP cancel, which races
                    // this callback) already committed the turn's content from
                    // the stream state and dropped it — so the cache (and thus
                    // sessionMessages) is already authoritative and complete.
                    // Re-fetching from the backend would clobber that with JSONL
                    // that lags the live stream for a cancelled turn, visibly
                    // rolling back already-shown content (Claude-Code-specific).
                    // The aborted-turn turn_complete commit (which now uses
                    // includePending, covering pending interactions) is the
                    // source of truth, so we only fall back to the backend when
                    // we genuinely have nothing cached for this session.
                    try {
                      const msgs = await invokeCommand<Message[]>("get_session_messages", {
                        agentId: activeId ?? "",
                        sessionId: selectedSession,
                        encodedName: projectId,
                      });
                      const visibleMessages = filterInvisibleUserMessages(msgs);
                      setCachedSessionMessages(selectedSession, visibleMessages);
                      setSessionMessages(visibleMessages);
                    } catch (e) {
                      console.error("Failed to refresh messages after abort", e);
                    }
                  }
                }
              }}
              onGuideStaged={async (content: string, toolIds?: string[]) => {
                if (!selectedSession || selectedSession === "new") return;
                // Pi-RPC delivers the guide as a real mid-turn injection
                // (steer_chat + steer_injected event). ACP (claude-code) has no
                // mid-turn steer — steer_chat just queues a follow-up prompt and
                // never injects — so skip it; the guide still queues below and
                // becomes a real message when the user stops or the reply
                // completes (Route 2 / turn_complete commit).
                if (supportsSteer) {
                  await invokeCommand("steer_chat", {
                    sessionId: selectedSession,
                    message: content,
                  });
                }
                // Queue for commit at turn_complete AND show live now.
                // Rendered after the streaming bubble (see pendingSteerDisplay
                // below) so it sits below the in-progress reply; committed into
                // sessionMessages between that reply and the guide's response
                // when the turn completes (or sent by Route 2 if it wasn't a
                // real mid-turn injection).
                // v0.9.4 需求7 测试期重构：登记入 SteerCoordinator（占位由队列
                // 派生，双状态同步问题根除）。
                steerCoordinator.stage(selectedSession, content, toolIds);
              }}
            />
          </div>
        )}
      </div>

      {/* 任务模式：右侧任务侧边栏。减法重构——唯一区别于普通会话页的组件；
          主会话区（上方 MessageView/ChatInput）原样复用 chat-page，不做任何复制。
          P4a：仅执行阶段显示；P4c：可被「隐藏步骤栏」收起。 */}
      {/* v0.9.2 需求2 M3-5：TaskSidebar 退役——步骤呈现归全景面板（session.flow
          插件）与会话内子任务卡，画布 overlay 上移到页面级（全景面板「画布」
          入口经 taskBoardSignal 唤起）。 */}
      {taskBoardOpen && taskModeActive && activeTaskLaunchInstance?.graph_id ? (
        <Suspense fallback={null}>
          <FlowBoardOverlay
            taskTitle={activeTaskLaunchInstance.title}
            graphId={activeTaskLaunchInstance.graph_id}
            runStarted={Boolean(taskGraph.activeRunId ?? activeTaskLaunchInstance.active_run_id)}
            runStatus={taskGraph.runStatus}
            selectedNodeId={taskSelectedNodeId}
            onSelectNode={handleTaskSelectNode}
            onNodeDoubleClick={(nodeId) => {
              setTaskBoardOpen(false);
              handleTaskSelectNode(nodeId);
            }}
            onOpenMainSession={() => {
              setTaskBoardOpen(false);
              handleTaskSelectNode(null);
            }}
            onClose={() => setTaskBoardOpen(false)}
            taskGraph={taskGraph}
            onStartRun={handleStartExecutionFromChat}
            agents={agents.map((agent) => ({ id: agent.id, display_name: agent.display_name }))}
            agentsLoading={healthLoading && agents.length === 0}
            defaultAgentId={normalizeAgentId(activeTaskLaunchInstance.planner_agent_id)}
            selectedNodeSession={
              taskSelectedNodeId
                ? taskInstanceState.nodeSessionMap[taskSelectedNodeId] ?? null
                : null
            }
            onAssignAgent={handleBoardAssignAgent}
          />
        </Suspense>
      ) : null}

      <RenameSessionDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        sessionId={selectedSession ?? ""}
        currentName={displayName}
        onRenamed={refetchNames}
      />
      <RenameTaskSessionDialog
        open={renameTaskTarget !== null}
        onOpenChange={(open) => { if (!open) setRenameTaskTarget(null); }}
        currentName={renameTaskTarget?.title ?? ""}
        onSubmit={async (name) => {
          if (!renameTaskTarget || !projectPathForSettings) return;
          try {
            const updated = await invokeCommand<TaskLaunchInstanceSummary>("task_launch_rename_task", {
              projectRoot: projectPathForSettings,
              taskId: renameTaskTarget.task_id,
              title: name,
            });
            setTaskLaunchSessions((current) => current.map((item) => item.task_id === updated.task_id ? updated : item));
          } catch (error) {
            void alertDialog({ title: "重命名失败", description: `重命名失败：${String(error)}` });
          }
        }}
      />
      {confirmDialogNode}
      <Dialog
        open={Boolean(activeApproval)}
        onOpenChange={(open) => {
          if (!open && activeApproval && !approvalResolving) {
            void resolveActiveApproval(false);
          }
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("sessions.permissionTitle")}</DialogTitle>
            <DialogDescription>{t(approvalDescKey)}</DialogDescription>
          </DialogHeader>
          <pre className="max-h-72 overflow-auto rounded-md border border-border/60 bg-muted/50 p-3 text-xs whitespace-pre-wrap break-all">
            {JSON.stringify(activeApproval?.payload ?? {}, null, 2)}
          </pre>
          <DialogFooter className="flex-wrap gap-2 sm:flex-nowrap">
            <Button
              variant="outline"
              disabled={approvalResolving}
              onClick={() => void resolveActiveApproval(false)}
            >
              {t("sessions.permissionReject")}
            </Button>
            <Button
              variant="outline"
              disabled={approvalResolving}
              onClick={() => void resolveActiveApproval(true, false)}
            >
              {t("sessions.permissionApproveOnce")}
            </Button>
            {/* 变更前审批档（full-approve）策略链不含 Once 记忆（每次变更都
                确认），「始终允许」在该档不生效——隐藏第三键。 */}
            {approvalAlwaysHidden ? null : (
              <Button
                disabled={approvalResolving}
                onClick={() => void resolveActiveApproval(true, true)}
              >
                {approvalResolving
                  ? t("sessions.permissionResolving")
                  : t("sessions.permissionApproveAlways")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </BlockRenderersProvider>
  );
}

import {
  evictIdleSessionMessagesCache,
  getCachedSessionMessages,
  setCachedSessionMessages,
  deleteCachedSessionMessages,
  hasCachedSessionMessages,
} from "@/features/session-kernel/kernel/session-cache";
import { startAgentEventPipeline } from "@/features/session-kernel/kernel/event-pipeline";
import { useChatApprovals } from "./chat-approvals";
