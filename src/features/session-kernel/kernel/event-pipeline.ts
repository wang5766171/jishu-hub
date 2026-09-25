/**
 * agent-event 管线（v0.9.3 需求10 / M1①，自 chat-page.tsx mount-only 监听
 * 整体迁出，逐字搬迁零行为变化）。
 *
 * 职责：agent-event 流式块 → 会话路由（当前 agent 或正在查看的会话）→
 * streamStore 推送 / 会话缓存维护（别名/截断/回写）/ 乐观会话列表刷新 /
 * 审批与交互请求排队 / 任务实例信号发射 / steer 占位与回合收尾（引导重发/
 * 暂存领取）。并行流式的基础：块按 session 路由进各自 store 条目，与当前
 * 选中会话无关。
 *
 * 依赖注入：监听体只引用 refs 与稳定 setter（原 useEffect 即 mount-only +
 * refs 设计），deps 对象由壳层组装；返回清理函数（语义同原 effect cleanup）。
 *
 * 分层注：chat-page-utils 的纯函数/类型暂经页面模块导入（历史错位，后续
 * 随 M 线推进上移到 components/sessions——见需求10 方案）。
 */
import { listen } from "@tauri-apps/api/event";
import type { MutableRefObject, Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { AgentEventPayload } from "@/types";
import { streamStore } from "@/hooks/use-stream-store";
import { invokeCommand } from "@/hooks/use-invoke";
import type { Message, Session } from "@/types";
import type { TaskLaunchInstanceSummary } from "@/features/task-instance/types";
import { logTaskPhaseDebug } from "@/features/task-instance/task-phase-debug";
import { interactionRequestFromEvent } from "@/lib/conversation-interaction";
import {
  buildInteractionInsertions,
  commitAssistantWithInteractions,
} from "@/lib/deferred-user-message";
import {
  buildAssistantContentFromStreamState,
  extractRealSessionId,
  uniqueSessionsById,
  type PendingChatApproval,
  type PendingChatInteraction,
  type TaskLaunchPhase,
} from "@/pages/chat-page-utils";
import type { ChatInputHandle, StagedGuideApi } from "@/components/sessions/chat-input";
import {
  getCachedSessionMessages,
  setCachedSessionMessages,
} from "./session-cache";
import { emitSessionSignal } from "../signals";
import { steerCoordinator } from "./steer-coordinator";
import { devLog } from "@/lib/dev-log";

/** v0.9.4 需求6 v2：AI 标题生成前端触发一次守卫（会话 id 维度，进程内）。 */
const titledOnce = new Set<string>();

export interface AgentEventPipelineDeps {
  // —— refs（监听体只读 .current）——
  activeIdRef: MutableRefObject<string | null>;
  activeTaskInstanceIdRef: MutableRefObject<string | null>;
  chatInputRef: MutableRefObject<ChatInputHandle | null>;
  injectedLaunchSessionsRef: MutableRefObject<Set<string>>;
  isAwayFromBottomRef: MutableRefObject<boolean>;
  lastRealSessionIdRef: MutableRefObject<string | null>;
  messageAreaRef: MutableRefObject<HTMLDivElement | null>;
  newSessionStreamIdsRef: MutableRefObject<Set<string>>;
  pendingReplyStartedAtRef: MutableRefObject<Map<string, number>>;
  /** v0.9.4 需求7 测试期重构：停止时本地乐观提交标记（会话 key → 时刻）。
   * turn_complete(Aborted) 凭此跳过重复提交，但收口（重发/drop）照常。 */
  abortLocalCommitRef: MutableRefObject<Map<string, number>>;
  projectIdRef: MutableRefObject<string | null>;
  projectPathRef: MutableRefObject<string | null>;
  refetchSessionsRef: MutableRefObject<((silent?: boolean) => Promise<Session[]>) | null>;
  selectedSessionRef: MutableRefObject<string | null>;
  selectedTaskSkillIdRef: MutableRefObject<string>;
  sessionsRef: MutableRefObject<Session[] | null>;
  stagedApiRef: MutableRefObject<StagedGuideApi | null>;
  supportsSteerRef: MutableRefObject<boolean>;
  taskLaunchOpenRef: MutableRefObject<boolean>;
  taskLaunchPhaseRef: MutableRefObject<TaskLaunchPhase>;
  visitedSessions: MutableRefObject<Set<string>>;
  // —— 稳定 setter ——
  setLiveThinkingLevel: Dispatch<SetStateAction<string | null>>;
  setOptimisticSessions: Dispatch<SetStateAction<Session[]>>;
  setPendingApprovals: Dispatch<SetStateAction<PendingChatApproval[]>>;
  setPendingInteractions: Dispatch<SetStateAction<PendingChatInteraction[]>>;
  setSelectedSession: Dispatch<SetStateAction<string | null>>;
  setSessionMessages: Dispatch<SetStateAction<Message[]>>;
  // —— 壳层回调（useCallback 稳定引用）——
  applyTaskLaunchInstanceSnapshot: (record: TaskLaunchInstanceSummary) => void;
  refreshSessionUsage: (sessionId: string) => void;
  discoverConductorTask: (sessionId: string) => Promise<void>;
  t: TFunction;
}

export function startAgentEventPipeline(deps: AgentEventPipelineDeps): () => void {
  let unlistenFn: (() => void) | null = null;
  let cancelled = false;
  // v0.9.4 需求8：工具进度节流表（`${cid}\x1f${call_id}` → 上次放行时刻）。
  const toolProgressThrottle = new Map<string, number>();
  // v0.9.4 需求12：thinking 聚合观测表（think-<cid> → start/last）
  const thinkingAggRef = new Map<string, { start: number; last: number }>();
  listen<AgentEventPayload>("agent-event", (event) => {
      const payload = event.payload;
      const chunks = Array.isArray(payload) ? payload : [payload];

      for (const chunk of chunks) {
        // Ignore chunks for agents we're not currently using — UNLESS the chunk
        // belongs to the session we're currently viewing. Execution-phase node
        // sub-agent sessions run under a different agent_id than the active
        // (conductor) agent, but when the user opens a node session we must
        // stream its output live instead of waiting for a manual refresh (T8-P8).
        if (
          chunk.agent_id !== deps.activeIdRef.current &&
          chunk.session_id !== deps.selectedSessionRef.current
        ) {
          continue;
        }

        const cid = chunk.session_id;

        // v0.9.4 需求12：dev 日志（关键 chunk；高频 delta 不逐条）。
        if (chunk.data.kind !== "text_delta" && chunk.data.kind !== "thinking") {
          devLog("pipeline", `chunk ${chunk.data.kind}`, {
            session: cid,
            agent: chunk.agent_id,
            detail: "reason" in chunk.data ? String((chunk.data as { reason?: string }).reason ?? "")
              : "call_id" in chunk.data ? String((chunk.data as { call_id?: string }).call_id ?? "")
              : undefined,
          });
        }
        // thinking 聚合观测（用户实测：模型思考 50s+ 无感知）——首条记开始、
        // 每 15s 记持续、结束（tool_use_start/text）记总时长。
        if (chunk.data.kind === "thinking") {
          const tk = `think-${cid}`;
          const now = Date.now();
          const st = thinkingAggRef.get(tk);
          if (!st) {
            thinkingAggRef.set(tk, { start: now, last: now });
            devLog("pipeline", "模型开始思考", { session: cid });
          } else if (now - st.last > 15_000) {
            st.last = now;
            devLog("pipeline", `模型思考中…已持续 ${Math.round((now - st.start) / 1000)}s`, { session: cid });
          }
        } else if (chunk.data.kind === "tool_use_start" || chunk.data.kind === "text_delta") {
          const tk = `think-${cid}`;
          const st = thinkingAggRef.get(tk);
          if (st) {
            devLog("pipeline", `模型思考结束（持续 ${Math.round((Date.now() - st.start) / 1000)}s）`, { session: cid });
            thinkingAggRef.delete(tk);
          }
        }

        // v0.9.4 需求8：工具进度节流（per call_id 200ms）——bash 类长时工具
        // 的行级输出事件高频，逐事件打 store 会冲击渲染；进度语义允许
        // 200ms 粒度。表随管线生命周期（stop 时清）。

        if (chunk.data.kind === "tool_use_progress") {
          const key = `${cid}\x1f${chunk.data.call_id}`;
          const now = Date.now();
          const last = toolProgressThrottle.get(key);
          if (last !== undefined && now - last < 200) {
            continue;
          }
          toolProgressThrottle.set(key, now);
        }

        if (chunk.data.kind === "approval_request") {
          // v0.9.2 需求1 M4：审批信号（桌面通知等 event-hook 插件消费）。
          emitSessionSignal({
            type: "approval-request",
            sessionId: cid,
            agentId: chunk.agent_id,
          });
          const approval: PendingChatApproval = {
            sessionId: cid,
            requestId: chunk.data.request_id,
            approvalKind: chunk.data.approval_kind,
            payload: chunk.data.payload,
          };
          deps.setPendingApprovals((current) => {
            const exists = current.some(
              (item) =>
                item.sessionId === approval.sessionId
                && item.requestId === approval.requestId,
            );
            return exists ? current : [...current, approval];
          });
        }

        if (chunk.data.kind === "interaction_request") {
          const request = interactionRequestFromEvent(chunk.data);
          deps.setPendingInteractions((current) => {
            const next: PendingChatInteraction = {
              agentId: chunk.agent_id,
              sessionId: cid,
              request,
            };
            const exists = current.some(
              (item) =>
                item.agentId === next.agentId
                && item.sessionId === next.sessionId
                && item.request.requestId === next.request.requestId,
            );
            return exists ? current : [...current, next];
          });
        }

        // v0.9.4 需求7 测试期重构：会话键解析（cid → resolvedId 优先）。
  const finalKeyRef = (cid: string): string => streamStore.getState(cid)?.resolvedId ?? cid;
  // v0.9.4 需求7 测试期重构：clear_queue 对账全量入 SteerCoordinator。
        // steering（用户引导）进 pendingResend（Abort 终结时重发——用户期望
        // 「引导被回复」而非作废）；followUp 回填输入框（v0.9.1 语义）。
        // 占位即队列投影，reconcileCleared 内部同步消化（含展开变形兑底）。
        if (chunk.data.kind === "steer_queue_cleared") {
          const finalKey = streamStore.getState(cid)?.resolvedId ?? cid;
          const queueKey = steerCoordinator.isEmpty(finalKey) ? cid : finalKey;
          const { followUps } = steerCoordinator.reconcileCleared(
            queueKey,
            chunk.data.texts,
            chunk.data.follow_up_texts ?? [],
          );
          // followUp 部分维持 v0.9.1 回填语义（仅正查看的会话，切走不越权改草稿）。
          if (
            followUps.length > 0
            && (cid === deps.selectedSessionRef.current || cid === streamStore.getState(cid)?.resolvedId)
          ) {
            deps.chatInputRef.current?.restoreTexts(followUps);
          }
          continue;
        }

        // v0.9.4 需求7 测试期重构补丁：steer 注入事实落地时消费队列——pi 的
        // steering 是「turn 边界转新 turn」形态（A 无工具 gap 时 B 不 fold 进
        // 当前 turn），且 hub 将多 turn 的 TurnComplete 缓冲合并为最后一个，
        // 旧的「turn_complete 时按队列消费」永远不触发 → 队列残留 → 占位
        // 永挂底部 + steer user 消息不提交（用户实测 B 一直在最下面）。
        // 注入事实以 steer_injected 到达为准（流内 steerTexts 同步记录），
        // 消费精确匹配队首文本；提交路径（turn_complete 交错）同步改为以
        // 流内 steerTexts 为源。
        if (chunk.data.kind === "steer_injected") {
          const queueKey0 = steerCoordinator.isEmpty(finalKeyRef(cid)) ? cid : finalKeyRef(cid);
          steerCoordinator.consumeInjected(queueKey0, chunk.data.content);
        }

        // 需求1 A7：会话内 thinking 生效值（Pi clamp 后）回传。
        if (chunk.data.kind === "thinking_level_changed") {
          deps.setLiveThinkingLevel(chunk.data.level);
        }

        // v0.8.0 需求10：上下文压缩状态——压缩进度由内容流中的两态分隔线
        // （压缩中… → 已压缩）呈现；此处在压缩结束沿即时刷新圆环用量
        // （record_compaction 已把水位更新为 窗口-压缩后规模），会话完成
        // 后 turn_complete 沿再刷新一次。
        if (chunk.data.kind === "compaction_status") {
          if (!chunk.data.active) {
            const st0 = streamStore.getState(cid);
            const usageSid = st0?.resolvedId ?? cid;
            void deps.refreshSessionUsage(usageSid);
            // v0.9.4 需求13：压缩流程不发 turn_complete（它是 operation 不是
            // turn）——压缩引发的纯压缩流（divider 到达时 pushTracked 自动
            // start，pending=null）在 active=false（权威结束信号）到达时终结：
            // divider 按回放形态（JSONL compaction entry → assistant 消息单
            // divider）提交进缓存，再 drop。否则"处理中"永挂 + 压缩结束后
            // 停止打空（pi 已空闲，无 turn_complete(Aborted) 收尾）。
            if (
              st0 && st0.pendingUserMessage === null && st0.text === ""
              && st0.thinking === "" && st0.tools.length === 0
              && st0.steerTexts.length === 0 && !st0.error
            ) {
              const finalKey = st0.resolvedId ?? cid;
              const divider = [...st0.content]
                .reverse()
                .find((b) => b.type === "phase_divider" && b.phase === "compaction");
              if (divider) {
                const base = getCachedSessionMessages(finalKey)
                  ?? getCachedSessionMessages(cid) ?? [];
                setCachedSessionMessages(finalKey, [...base, {
                  role: "assistant" as const,
                  content: [divider],
                  timestamp: Date.now(),
                }]);
              }
              streamStore.drop(finalKey);
              devLog("pipeline", "压缩结束：终结纯压缩流（divider 已提交缓存）", { session: finalKey });
            }
          }
          continue;
        }

        // Detect resolved session id and register it as an alias before pushing
        // (so subsequent chunks under the real id route to the same entry).
        const realId = extractRealSessionId(chunk.data);
        if (realId) {
          deps.lastRealSessionIdRef.current = realId;
          // 同 id 解析（无别名切换）同样标记连接建立。
          streamStore.markSessionResolved(realId);
        }
        if (realId && realId !== cid) {
          streamStore.alias(cid, realId);
          // v0.9.4 需求12 测试期修复：连接建立（②→③ 权威切换信号）。
          streamStore.markSessionResolved(cid);
          // 新任务讨论关联：用 Pi 真实 session id（= conductor 写入任务的 requirement_session_id）
          // 触发 discover。ChatInput 的 onSessionResolved 拿的是 send_message 同步返回值（新 session
          // 仍为 pending），匹配不到 conductor 写的真 id；只有此处 session_resolved 事件携带真 id。
          // v0.9.2 需求6：去掉 deps.taskLaunchOpenRef 门控——会话模式（未开发起器）下
          // conductor 同样会创建任务实例，需要同样的发现通道（匹配按
          // requirement_session_id 精确比对，非 conductor 会话不会误关联）。
          if (!deps.activeTaskInstanceIdRef.current) {
            logTaskPhaseDebug("launch-link:resolve", {
              pendingId: cid,
              realId,
              phase: deps.taskLaunchPhaseRef.current,
            });
            deps.discoverConductorTask(realId).catch((e) =>
              console.warn("deps.discoverConductorTask failed:", e),
            );
          }
          // R2: 仅当已关联真任务（activeTaskInstanceId 非空）时才 mark。为空说明
          // Conductor 建的真任务尚未被 deps.discoverConductorTask 发现，此时 mark 会让后端
          // mark_task_stage_session 的 unwrap_or_else 生成 uuid 占位任务（title="新任务"、
          // 无图），导致会话列表出现两条数据。跳过 mark，交由 deps.discoverConductorTask 按
          // requirement_session_id 关联真任务；会话 id 由 Conductor 扩展 conductor_sync_phase
          // 权威写入，不依赖此处 mark。
          if (deps.taskLaunchOpenRef.current && deps.activeTaskInstanceIdRef.current) {
            const projectRoot = deps.projectPathRef.current;
            if (projectRoot) {
              invokeCommand<TaskLaunchInstanceSummary>("task_launch_mark_session", {
                projectRoot,
                taskId: deps.activeTaskInstanceIdRef.current,
                sessionId: realId,
                skillId: deps.selectedTaskSkillIdRef.current,
                phase: deps.taskLaunchPhaseRef.current,
                title: null,
              })
                .then((record) => {
                  deps.applyTaskLaunchInstanceSnapshot(record);
                })
                .catch((error) => console.warn("Failed to mark task launch session:", error));
            }
          }

          // Promote the optimistic session id to the real one in the UI.
          deps.setOptimisticSessions(prev => uniqueSessionsById(prev.map(s => s.id === cid ? { ...s, id: realId } : s)));
          if (deps.newSessionStreamIdsRef.current.has(cid)) {
            deps.newSessionStreamIdsRef.current.add(realId);
          }
          // Move messages cache entry from pending id to real id (and keep
          // both keys pointing at the same array for safety).
          const cached = getCachedSessionMessages(cid);
          if (cached) setCachedSessionMessages(realId, cached);
          // Migrate queued steer messages too. A user can guide (steer) while
          // a tool-bearing turn is running — often BEFORE the session id
          // resolves — so the steer is queued under the pending id. Without
          // this migration, turn_complete (which looks up by the resolved id
          // once known) would miss the queue, leaving the live "已引导"
          // placeholder stuck even though Pi already processed the steer
          // (visible only after a JSONL refresh).
          const queuedSteers = steerCoordinator.queueOf(cid);
          if (queuedSteers.length > 0) {
            steerCoordinator.moveKey(cid, realId);
          }
          // 占位从队列派生（SteerCoordinator），moveKey 已同步——无需换键。
          // Migrate launch-injection marker: if the pending id was already
          // injected with launch instruction, the real id is too (same session).
          if (deps.injectedLaunchSessionsRef.current.has(cid)) {
            deps.injectedLaunchSessionsRef.current.add(realId);
          } else if (deps.taskLaunchOpenRef.current) {
            // 兜底：任务模式下首条消息发送时 selectedSession 往往还是 null/"new"，
            // prepareTaskLaunchMessage 不会把 pending id 加入 set（786 行的 if 不满足），
            // 导致上面的迁移找不到 pending id、real id 永不入 set。此后用户在任务会话里
            // 发的任何消息都会被误判为首条、重新包装成 /jishu-task 命令——而 Conductor
            // 命令 handler 见 phase !== "idle" 直接 return，Pi 不启动任何 run，界面卡死
            // 在"思考中"。任务模式 session resolve 时无条件把 real id 标记为已激活，确保
            // 后续消息原样透传给已激活的 Conductor。
            deps.injectedLaunchSessionsRef.current.add(realId);
          }
          deps.setPendingInteractions((current) =>
            current.map((item) =>
              item.agentId === chunk.agent_id && item.sessionId === cid
                ? { ...item, sessionId: realId }
                : item,
            ),
          );
          if (deps.selectedSessionRef.current === cid) {
            deps.setSelectedSession(realId);
            deps.selectedSessionRef.current = realId;
            deps.visitedSessions.current.add(realId);
          }
        }

        // Phase dividers and interaction requests may legitimately arrive after
        // a prior run's stream state was dropped; lifecycle-only events may not
        // create an empty continuation stream.
        if (!streamStore.pushTracked(cid, chunk)) {
          continue;
        }

        if (chunk.data.kind === "turn_complete") {
          // v0.9.4 需求6 v2：回合完成后触发 AI 标题生成（一次/会话；后端幂等
          // ——已有 session_info 即跳过，用户重命名不覆盖；失败静默回落规则
          // 截断标题）。仅 jishu-self（pi 原生 JSONL 通道）。
          if (chunk.agent_id === "jishu-self") {
            const titledKey = streamStore.getState(cid)?.resolvedId ?? cid;
            if (!titledOnce.has(titledKey)) {
              titledOnce.add(titledKey);
              void invokeCommand<string | null>("session_generate_title", { sessionId: titledKey })
                .then((title) => {
                  if (title) emitSessionSignal({ type: "session-titled", sessionId: titledKey, title });
                })
                .catch((e) => console.warn('[session-title] generate failed:', e));
            }
          }
          // v0.9.2 需求1 M4：后台会话回合完成信号（正在查看的会话不打扰）。
          if (cid !== deps.selectedSessionRef.current) {
            emitSessionSignal({
              type: "turn-complete",
              sessionId: cid,
              agentId: chunk.agent_id,
              error: chunk.data.reason === "Error",
            });
          }
          // Build final assistant/user messages from the accumulated state.
          const state = streamStore.getState(cid);
          const finalKey = state?.resolvedId ?? cid;
          // v0.8.0 需求10：用量以 Hub SQLite 为权威（Rust turn_end 记账，
          // 与页面在场无关）；回合结束后拉取最新行刷新前端缓存（圆环数据源）。
          void deps.refreshSessionUsage(finalKey);
          // Spurious-completion guard: when a follow-up streaming state was just
          // created at the end of a turn (a manually-guided steer committed as a
          // follow-up, or Route 2 auto-sending staged guides), the (re)launched
          // ACP/agent process can emit early turn_complete events (Complete,
          // Error, …) before its real reply has begun — carrying no assistant
          // text. Processing them would drop the freshly-created "thinking"
          // state, leaving a blank gap until the real reply's first token.
          // Detect them (follow-up started recently + no text produced) and skip:
          // keep the state so the pending reply fills it naturally. The marker
          // is retained across skips so consecutive spurious completions are all
          // ignored; it is cleared only when a genuine completion (with text) is
          // processed below, or expires after the window.
          const pendingReplyStartedAt = deps.pendingReplyStartedAtRef.current.get(finalKey)
            ?? deps.pendingReplyStartedAtRef.current.get(cid);
          // state must exist (an aborted turn whose state was already dropped by
          // handleAbort is null here and must NOT be skipped — its queued steers
          // still need committing). content/tools may hold ACP startup noise so
          // only text/thinking gate this.
          const hasNoReplyText = Boolean(state)
            && !(state!.text.length || state!.thinking.length);
          // 需求15：显式失败（Error/MaxTokens 结束或已记录错误文本）不是伪完成
          // ——快速失败（如 codex 模型 400 秒拒）曾被 2s 防伪守卫吞掉：不提交
          // 任何消息，流式态结束后用户消息与错误一起"消失"。失败必提交。
          const explicitFailure =
            chunk.data.reason === "Error"
            || chunk.data.reason === "MaxTokens"
            // v0.9.4 需求7 测试期修复二：Aborted 是用户主动动作的结果，必然
            // 真实（重发后 2s 内再引导+停止的二次 Abort 曾被守卫吞掉——引导
            // 丢失且重发 thinking 流无人 drop）——不受伪完成守卫约束。
            || chunk.data.reason === "Aborted"
            || Boolean(state?.error);
          if (
            pendingReplyStartedAt !== undefined
            && Date.now() - pendingReplyStartedAt < 2000
            && hasNoReplyText
            && !explicitFailure
          ) {
            continue;
          }
          const isNewSessionStream =
            deps.newSessionStreamIdsRef.current.has(cid)
            || deps.newSessionStreamIdsRef.current.has(finalKey);
          // For transports without mid-turn steer (ACP), a queued guide that
          // couldn't be injected is sent as a real new message. Set in the
          // no-tool branch below; the actual streamStore.start + send_message
          // runs after this turn's drop(cid), so the new stream isn't cleared.
          let guideToSendAfterDrop: string | null = null;
          const newMessages: Message[] = [];
          if (state?.pendingUserMessage) {
            newMessages.push({
              role: "user",
              content: [{ type: "text", text: state.pendingUserMessage }],
              timestamp: Date.now(),
            });
          }
          // Build the assistant content blocks for this turn. When Pi
          // delivers a steer mid-turn (at a tool-call gap) it folds the
          // steer's reply into the SAME turn — so a single turn_complete can
          // hold [reply1a, steer, reply1b] worth of content, accumulated in
          // arrival order. `steerSplits` records the content-array index at
          // each injection point; we split there and interleave the queued
          // steers so the live order matches the JSONL Pi persists.
          const steerQueueKey = steerCoordinator.isEmpty(finalKey) ? cid : finalKey;
          devLog("pipeline", "turn_complete 处理", {
            session: cid, finalKey, reason: chunk.data.reason,
            steerSplits: (state?.steerSplits ?? []).length,
            steerTexts: (state?.steerTexts ?? []).length,
            queue: steerCoordinator.textsOf(steerQueueKey).length,
            localCommitted: deps.abortLocalCommitRef.current.has(finalKey) || deps.abortLocalCommitRef.current.has(cid),
          });
          // v0.9.4 需求7 测试期重构补丁：提交源改为流内 steerTexts（注入事实）。
          // pi 的 steering 是「turn 边界转新 turn」形态 + hub 缓冲合并多 turn 的
          // TurnComplete——前端只见一次终结，注入的兑现以 steer_injected 到达为
          // 准（store.steerTexts，coordinator 队列同刻消费）；队列此刻只承载
          // 未注入的残留（防御路径）。
          const steerTexts = state?.steerTexts ?? [];
          const queuedSteers = steerCoordinator.textsOf(steerQueueKey);
          // ── Build interactionInsertions with REAL indices ───────────────────
          // The snapshot `item.index` (content.length at interaction_request time)
          // goes stale once the agent emits more content after the request.
          // Instead, after we've built the final assistantContent, re-scan it to
          // find each answered interaction's tool_use block and use its REAL index.
          // Sanitize + sort: each split marks the start of a new segment.
          const steerSplits = Array.from(new Set(state?.steerSplits ?? []))
            .filter((idx) => idx > 0 && idx < (state?.content.length ?? 0))
            .sort((a, b) => a - b);

          // True when a committed steer will be answered in a FOLLOW-UP turn
          // (a leftover not delivered mid-turn, or the appended steer in a
          // no-tool turn). Drives the pre-created "thinking" state below.
          let followUpExpected = false;

          const assistantContent = buildAssistantContentFromStreamState(state);
          // An aborted turn (e.g. the user hit Stop on Claude Code's ACP
          // transport, which emits TurnComplete(Aborted)) must still embed any
          // pending, UNANSWERED interaction — otherwise the question vanishes
          // the moment the stream state is dropped. On normal completion there
          // are no pending interactions, so includePending only affects aborts.
          const isAbortedTurn = chunk.data.reason === "Aborted";
          const interactionInsertions = buildInteractionInsertions({
            assistantContent,
            interactionSplits: state?.interactionSplits ?? [],
            includePending: isAbortedTurn,
          });

          // v0.9.4 需求7 测试期重构：队列消费/占位清理统一收敛 SteerCoordinator
          //（占位即队列投影，单一真源，不再手工配对）。
          const consumeSteerFromQueue = (count: number) => {
            steerCoordinator.consume(steerQueueKey, count);
          };
          const dropLivePlaceholders = (_count: number) => {
            /* 占位从队列派生，consume 已同步消化 */
          };
          if (interactionInsertions.length > 0) {
            const midSteerCount = Math.min(steerSplits.length, steerTexts.length);
            const committed = commitAssistantWithInteractions({
              assistantContent,
              interactionInsertions,
              steerInsertions: steerSplits.slice(0, midSteerCount).map((index, i) => ({
                index,
                text: steerTexts[i],
              })),
              error: state?.error,
            });
            newMessages.push(...committed.messages);
            consumeSteerFromQueue(midSteerCount);
            dropLivePlaceholders(midSteerCount);

            const leftover = steerCoordinator.textsOf(steerQueueKey);
            if (leftover.length > 0) {
              if (isAbortedTurn) {
                // v0.9.4 需求7 缺陷二兕底：abort 后 pi 队列已被 clear_queue
                // 作废，follow-up 回复不会来临——不提交、不预创建无超时
                // thinking 态，改走真实重发（guideToSendAfterDrop 下游自己
                // 提交 guide 消息 + send_message）。
                guideToSendAfterDrop = leftover[0];
              } else {
                newMessages.push({
                  role: "user",
                  content: [{ type: "text", text: leftover[0] }],
                  timestamp: Date.now(),
                });
                followUpExpected = true;
              }
              consumeSteerFromQueue(1);
              dropLivePlaceholders(1);
            }
          } else if (steerSplits.length > 0 && steerTexts.length > 0) {
            // TOOL-BEARING turn with mid-turn steers: split the accumulated
            // content at each injection point and interleave the steers
            // between segments — yielding [reply1a, steer, reply1b] instead of
            // [reply1a+reply1b, steer], matching the JSONL order.
            const midCount = Math.min(steerSplits.length, steerTexts.length);
            let prevIdx = 0;
            for (let i = 0; i < midCount; i++) {
              const seg = assistantContent.slice(prevIdx, steerSplits[i]);
              if (seg.length > 0) {
                newMessages.push({ role: "assistant", content: seg, timestamp: Date.now() });
              }
              newMessages.push({
                role: "user",
                content: [{ type: "text", text: steerTexts[i] }],
                timestamp: Date.now(),
              });
              prevIdx = steerSplits[i];
            }
            // Tail segment (after the final mid-turn steer); errors attach here.
            const tail = assistantContent.slice(prevIdx);
            // v0.9.1 需求14 测试期：失败持久化——重试耗尽提交 error 分隔线
            // （与 pi_session 的 JSONL 投影同形，重载后视图一致）。
            if (state?.retryFailed) {
              tail.push({ type: "phase_divider", phase: "error", title: `请求失败：${state.retryFailed.finalError}` });
            } else if (state?.error) tail.push({ type: "text", text: state.error });
            if (tail.length > 0) {
              newMessages.push({ role: "assistant", content: tail, timestamp: Date.now() });
            }
            consumeSteerFromQueue(midCount);
            dropLivePlaceholders(midCount);

            // Pi delivers steers one-at-a-time; any queue entry left after the
            // mid-turn steers was queued too late to be folded in and will be
            // processed as a follow-up turn. Commit it now (appended after the
            // tail) so it lands BEFORE its response, which arrives in the next
            // turn_complete — mirroring the no-tool FIFO behavior below.
            const leftover = steerCoordinator.textsOf(steerQueueKey);
            if (leftover.length > 0) {
              if (isAbortedTurn) {
                // v0.9.4 需求7 缺陷二兕底：同 interaction 分支——abort 后
                // follow-up 不会来临，改真实重发，不预创建 thinking。
                guideToSendAfterDrop = leftover[0];
              } else {
                newMessages.push({
                  role: "user",
                  content: [{ type: "text", text: leftover[0] }],
                  timestamp: Date.now(),
                });
                followUpExpected = true;
              }
              consumeSteerFromQueue(1);
              dropLivePlaceholders(1);
            }
          } else {
            // No mid-turn steer injection: commit the turn as a single
            // assistant message, then append one queued steer FIFO. With Pi's
            // default one-at-a-time steering the steer is answered in a
            // separate follow-up turn, so appending it here lands it between
            // this reply and the next — [reply, steer, steerResponse].
            if (state?.retryFailed) {
              // v0.9.1 需求14 测试期：重试耗尽——error 分隔线（同 JSONL 投影）。
              assistantContent.push({
                type: "phase_divider",
                phase: "error",
                title: `请求失败：${state.retryFailed.finalError}`,
              });
            } else if (state?.error) {
              assistantContent.push({ type: "text", text: state.error });
            } else if (
              explicitFailure
              && assistantContent.length === 0
              && (chunk.data.reason === "Error" || chunk.data.reason === "MaxTokens")
            ) {
              // 需求15：无任何回复内容的失败（协议层未单独下发 Error 事件，
              // 仅 TurnComplete 携带失败原因）也要可见——通用错误气泡兜底。
              assistantContent.push({
                type: "text",
                text: deps.t("sessions.turnFailedBubble", "本轮对话失败（{{reason}}），请检查模型与账号配置后重试")
                  .replace("{{reason}}", chunk.data.reason),
              });
            }
            if (assistantContent.length > 0) {
              newMessages.push({ role: "assistant", content: assistantContent, timestamp: Date.now() });
            }
            if (queuedSteers.length > 0) {
              if (deps.supportsSteerRef.current && !isAbortedTurn) {
                // Pi-RPC 正常完成：the queued steer is answered in a follow-up
                // turn. Commit it as a user message now; the response arrives in
                // the next turn_complete. followUpExpected pre-creates a "thinking"
                // state so the gap isn't blank.
                // v0.9.4 需求7 缺陷二兕底：Abort 路径不适用此保证（pi 队列
                // 已被 clear_queue 作废），走真实重发分支。
                newMessages.push({
                  role: "user",
                  content: [{ type: "text", text: queuedSteers[0] }],
                  timestamp: Date.now(),
                });
                followUpExpected = true;
                consumeSteerFromQueue(1);
                dropLivePlaceholders(1);
              } else {
                // No mid-turn steer (ACP/claude-code): the queued guide was
                // never injected, so no follow-up reply will come. Send it as a
                // real new message (mirrors Route 2) so the agent actually
                // processes it. Do NOT commit it as a user message here —
                // send_message's own turn_complete will commit guide+reply
                // naturally (committing now would duplicate it). The actual
                // streamStore.start + send_message runs AFTER the drop below
                // (same as Route 2) — otherwise this turn's drop(cid) would
                // clear the freshly-started stream.
                const guideText = queuedSteers[0];
                consumeSteerFromQueue(1);
                dropLivePlaceholders(1);
                guideToSendAfterDrop = guideText;
              }
            }
          }

          // v0.9.4 需求7 测试期重构：本地乐观提交防重——停止时 onAbort 先于
          // 本事件执行（abort_chat 快速返回），已本地提交过 partial/交错内容
          //（abortLocalCommitRef 标记）。此处跳过重复提交，但下方的收口
          //（steering 重发）、流 drop、标记清理照常——turn_complete 仍是唯一
          // 回合终结者。
          const freshLocalCommit = (key: string): boolean => {
            const at = deps.abortLocalCommitRef.current.get(key);
            return at !== undefined && Date.now() - at < 5_000;
          };
          if (isAbortedTurn && (freshLocalCommit(finalKey) || freshLocalCommit(cid))) {
            newMessages.length = 0;
          }
          // Resolve the base messages from the cache (preferring real id).
          const baseMessages =
            getCachedSessionMessages(finalKey)
            ?? getCachedSessionMessages(cid)
            ?? [];
          const updated = [...baseMessages, ...newMessages];
          setCachedSessionMessages(finalKey, updated);
          if (cid !== finalKey) setCachedSessionMessages(cid, updated);

          // Persist interaction blocks to JSONL (best-effort). The session's
          // `path` field is the JSONL file location for existing sessions; new
          // sessions may only have the project directory, in which case we skip
          // the write (the interaction data is still in the cache, and the
          // session loader filters interaction tool_use blocks on reload).
          if (interactionInsertions.length > 0) {
            const sessionList = deps.sessionsRef.current;
            const sessionPath = sessionList?.find(s => s.id === finalKey)?.path
              ?? sessionList?.find(s => s.id === cid)?.path
              ?? "";
            invokeCommand("persist_interaction_blocks", {
              agentId: deps.activeIdRef.current ?? "",
              sessionPath,
              sessionId: finalKey,
              encodedName: deps.projectIdRef.current,
              interactions: interactionInsertions.map(ins => ({
                index: ins.index,
                request_id: ins.requestId ?? null,
                prompt: ins.prompt,
                options: ins.options,
                answer: ins.answer,
                selected_options: ins.selectedOptions ?? [],
                origin: ins.origin ?? null,
              })),
            }).catch((err: unknown) => {
              console.warn("Failed to persist interaction blocks:", err);
            });
          }

          // Persist the in-progress assistant text/thinking of an ABORTED turn
          // so it survives a refresh. Claude Code's transcript is owned by the
          // external `claude` CLI, which writes at message-completion
          // boundaries and ABANDONS an interrupted message — so the JSONL a
          // refresh reads would otherwise lack the partial the user already
          // saw (opencode/jishu no-op their adapter: they persist their own
          // store incrementally). Best-effort + idempotent: the backend strips
          // anything Claude already durably wrote, so the racing onAbort path
          // re-calling this is a safe no-op.
          if (isAbortedTurn && (state?.text || state?.thinking)) {
            const sessionList = deps.sessionsRef.current;
            const partialSessionPath = sessionList?.find(s => s.id === finalKey)?.path
              ?? sessionList?.find(s => s.id === cid)?.path
              ?? "";
            invokeCommand("persist_partial_assistant", {
              agentId: deps.activeIdRef.current ?? "",
              sessionPath: partialSessionPath,
              sessionId: finalKey,
              encodedName: deps.projectIdRef.current,
              text: state?.text ?? "",
              thinking: state?.thinking ?? "",
            }).catch((err: unknown) => {
              console.warn("Failed to persist partial assistant after abort:", err);
            });
          }

          // If the user is currently viewing this session, reflect the update
          // immediately. Otherwise the cache will be used the next time they
          // switch back to this session (without a JSONL reload).
          const viewed = deps.selectedSessionRef.current;
          const shouldKeepFollowingOutput = !deps.isAwayFromBottomRef.current;
          if (viewed === cid || viewed === finalKey) {
            deps.setSessionMessages(updated);
          }

          // Convert the streaming bubble into the formal MessageView row in a
          // single paint. drop() schedules the normal external-store update;
          // forcing a synchronous flush here can remove the live row before
          // React commits its formal Markdown replacement.
          streamStore.drop(cid);
          deps.abortLocalCommitRef.current.delete(finalKey);
          deps.abortLocalCommitRef.current.delete(cid);
          if ((viewed === cid || viewed === finalKey) && shouldKeepFollowingOutput) {
            // The live turn and its committed Markdown use different DOM
            // subtrees. Wait for both the stream-store notification and the
            // Markdown layout before fixing the viewport at the output end.
            // If the user scrolled up, preserve their reading position.
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                const currentViewed = deps.selectedSessionRef.current;
                if (currentViewed !== cid && currentViewed !== finalKey) return;
                const scrollEl = deps.messageAreaRef.current;
                if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
              });
            });
          }
          // This was a genuine completion (had text, or the follow-up window
          // elapsed) — clear the spurious-completion marker so it does not
          // suppress a later legitimate turn_complete for this session.
          deps.pendingReplyStartedAtRef.current.delete(finalKey);
          deps.pendingReplyStartedAtRef.current.delete(cid);

          // v0.9.4 需求7 测试期修复：Abort 回合终结兑底闸门——steer 队列/占位
          // 的清理此前全靠各提交路径精确配对，任何一条漏清（事件丢失/文本
          // 展开变形/时序交错）都会残留「已引导」占位僵尸（流 drop 后
          // steerTexts 归零，占位隐藏失效全部重现，用户实测双条）。Abort 后
          // pi 队列已被 clear_queue 作废，残留无意义，此处清零。仅限 Abort：
          // 正常完成的多条引导第 2+ 条留在队列等 pi 的 follow-up turn，其
          // turn_complete 自会提交，不能误杀。（followUpExpected /
          // guideToSendAfterDrop 的新流在下方 start，不受影响。）
          if (isAbortedTurn) {
            // v0.9.4 需求7 测试期重构收口：暂存重发（SteerCoordinator
            // pendingResend）与队列残留兑底（事件丢失场景）合并去重后走
            // 真实重发通道（顺序：原回合已提交，B 重发在后）。两个候选键
            // 各取一次（takeResend 一次性语义，取空无副作用）。
            const resend = [
              ...steerCoordinator.takeResend(finalKey),
              ...steerCoordinator.takeResend(cid),
            ];
            devLog("pipeline", "Abort 收口：重发合并", { resend: resend.length, hasGuide: guideToSendAfterDrop !== null });
            if (resend.length > 0) {
              const merged = new Set([...(guideToSendAfterDrop !== null ? [guideToSendAfterDrop] : []), ...resend]);
              guideToSendAfterDrop = [...merged].join("\n\n");
            }
            // Abort 终结清零：pi 队列已作废，残留即僵尸（占位随队列投影消失）。
            steerCoordinator.resetAborted(steerQueueKey);
            if (cid !== steerQueueKey) steerCoordinator.resetAborted(cid);
          }

          if (followUpExpected) {
            // A committed steer will be answered in a FOLLOW-UP turn (a
            // leftover not delivered mid-turn in a tool turn, or the appended
            // steer in a no-tool turn). Pre-create an empty streaming state so
            // the "thinking" indicator shows immediately and PERSISTS until the
            // agent actually responds — otherwise there's a blank gap until the
            // response's first chunk re-activates the state via the
            // content-chunk guard above. Mid-turn steers are folded into the
            // committed segments above, so they do NOT trigger this. Use the
            // resolved key + re-alias cid so response chunks route correctly
            // after the drop cleared the alias map.
            //
            // No timeout: the response turn is guaranteed (Pi delivers the
            // queued steer one-at-a-time), so the state is always resolved —
            // either content arrives (fills it; the indicator is naturally
            // replaced by the reply) or the response turn's turn_complete
            // fires (drops the state, covering empty or error responses). An
            // arbitrary cutoff would kill the indicator before a slow model's
            // first token, exactly the bug we're fixing.
            streamStore.start(finalKey, null);
            if (cid !== finalKey) streamStore.alias(finalKey, cid);
            deps.pendingReplyStartedAtRef.current.set(finalKey, Date.now());
          }

          // ACP (no mid-turn steer): a queued guide that couldn't be injected
          // is sent as a real new message now that this turn's drop has settled.
          // Mirrors Route 2 — start the stream + record the spurious-completion
          // marker + fire send_message in an async IIFE so the reply fills the
          // "thinking" state naturally.
          if (guideToSendAfterDrop !== null) {
            const guideText = guideToSendAfterDrop;
            // Start the reply stream WITHOUT pendingUserMessage: send_message
            // already delivered the guide to the backend (it's in the JSONL),
            // so the reply's turn_complete must NOT re-commit it as a user
            // message (that would duplicate it). We commit the guide into the
            // cache ourselves here, exactly once.
            streamStore.start(finalKey, null);
            if (cid !== finalKey) streamStore.alias(finalKey, cid);
            deps.pendingReplyStartedAtRef.current.set(finalKey, Date.now());
            const guideBase =
              getCachedSessionMessages(finalKey)
              ?? getCachedSessionMessages(cid)
              ?? [];
            const guideUpdated = [...guideBase, {
              role: "user" as const,
              content: [{ type: "text" as const, text: guideText }],
              timestamp: Date.now(),
            }];
            setCachedSessionMessages(finalKey, guideUpdated);
            if (cid !== finalKey) setCachedSessionMessages(cid, guideUpdated);
            if (deps.selectedSessionRef.current === cid || deps.selectedSessionRef.current === finalKey) {
              deps.setSessionMessages(guideUpdated);
            }
            const guideProjectPath = deps.projectPathRef.current;
            void (async () => {
              try {
                await invokeCommand("send_message", {
                  agentId: deps.activeIdRef.current ?? "",
                  projectPath: guideProjectPath,
                  sessionId: finalKey,
                  message: guideText,
                });
              } catch (err) {
                console.error("Failed to send queued guide:", err);
                streamStore.drop(finalKey);
              }
            })();
          }

          // Route 2 (orthogonal to manual guide): when the turn ends, auto-send
          // any messages the user staged but did NOT manually guide — merged
          // into a single new turn. claimAll(finalKey) synchronously marks them
          // sent for THIS session, so a manual click racing this moment (or a
          // re-click) is blocked by the shared claimed-id set — each staged
          // guide is delivered exactly once. Gated on !followUpExpected so it
          // never competes with a manual steer's follow-up turn (that turn fires
          // its own turn_complete, which re-evaluates).
          //
          // Targets the session whose turn just completed (finalKey), NOT the
          // currently-viewed session. Staging state is partitioned by session
          // (stagedMessagesBySession), so a background session's turn_complete
          // claims only its own staged guides — never another conversation's.
          // This fixes the case where the user staged a guide in session A,
          // switched to B, and A's completion (while viewing B) must still send
          // A's staged guide. Claiming is gated only on deps.stagedApiRef existing
          // (the ChatInput must be mounted) and !followUpExpected; the viewed
          // session is irrelevant.
          if (!followUpExpected && deps.stagedApiRef.current) {
            const claimed = deps.stagedApiRef.current.claimAll(finalKey);
            if (claimed.length > 0) {
              // v0.9.4 需求8 补充：暂存附件标记行随自动发送附加（与手动引导
              // 同通道——文件落盘 + Read 引用）。
              const claimedWithFiles = claimed.filter((m) => m.fileLines && m.fileLines.length > 0);
              let fileBlock = "";
              if (claimedWithFiles.length > 0) {
                const lines = claimedWithFiles.flatMap((m) => m.fileLines ?? []);
                fileBlock = "\n" + "\n" + "<!--JISHU_HUB_IMAGES_BEGIN-->" + "\n" + "[用户在本次对话中上传了以下文件，请使用 Read 工具查看对应的文件路径：]" + "\n" + lines.join("\n") + "\n" + "<!--JISHU_HUB_IMAGES_END-->";
              }
              const merged = claimed.map((m) => m.content).join("\n") + fileBlock;
              // Start WITHOUT pendingUserMessage: send_message delivers the
              // message to the backend (JSONL), so the reply's turn_complete
              // must NOT re-commit it (would duplicate). Commit it into the
              // cache ourselves here, exactly once.
              streamStore.start(finalKey, null);
              if (cid !== finalKey) streamStore.alias(finalKey, cid);
              deps.pendingReplyStartedAtRef.current.set(finalKey, Date.now());
              const autoBase =
                getCachedSessionMessages(finalKey)
                ?? getCachedSessionMessages(cid)
                ?? [];
              const autoUpdated = [...autoBase, {
                role: "user" as const,
                content: [{ type: "text" as const, text: merged }],
                timestamp: Date.now(),
              }];
              setCachedSessionMessages(finalKey, autoUpdated);
              if (cid !== finalKey) setCachedSessionMessages(cid, autoUpdated);
              if (deps.selectedSessionRef.current === cid || deps.selectedSessionRef.current === finalKey) {
                deps.setSessionMessages(autoUpdated);
              }
              const projectPath = deps.projectPathRef.current;
              const restore = deps.stagedApiRef.current.restore.bind(deps.stagedApiRef.current);
              void (async () => {
                try {
                  await invokeCommand("send_message", {
                    agentId: deps.activeIdRef.current ?? "",
                    projectPath,
                    sessionId: finalKey,
                    message: merged,
                  });
                } catch (err) {
                  console.error("Auto-send of staged guides failed:", err);
                  streamStore.drop(finalKey);
                  restore(finalKey, claimed);
                }
              })();
            }
          }

          if (isNewSessionStream) {
            deps.newSessionStreamIdsRef.current.delete(cid);
            deps.newSessionStreamIdsRef.current.delete(finalKey);
            deps.refetchSessionsRef.current?.(true).catch(console.error);
          }

        }
      }
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlistenFn = fn;
      }
    });

  // eslint-disable-next-line react-hooks/exhaustive-deps
  return () => {
    cancelled = true;
    if (unlistenFn) unlistenFn();
  };
}
