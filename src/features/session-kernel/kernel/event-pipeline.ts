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
  pendingSteerMessagesRef: MutableRefObject<Map<string, string[]>>;
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
  setPendingSteerDisplay: Dispatch<SetStateAction<Record<string, Message[]>>>;
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

        // v0.9.1 需求3 #1：停止清队回填——PiRpc 停止时后端先 clear_queue 再
        // abort，被清空的排队 steer 文本经此事件回传；仅当用户正查看该会话
        // 时回填当前输入框（切走的会话不越权改草稿）。
        if (chunk.data.kind === "steer_queue_cleared") {
          if (cid === deps.selectedSessionRef.current || cid === streamStore.getState(cid)?.resolvedId) {
            deps.chatInputRef.current?.restoreTexts(chunk.data.texts);
          }
          continue;
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
            const usageSid = streamStore.getState(cid)?.resolvedId ?? cid;
            void deps.refreshSessionUsage(usageSid);
          }
          continue;
        }

        // Detect resolved session id and register it as an alias before pushing
        // (so subsequent chunks under the real id route to the same entry).
        const realId = extractRealSessionId(chunk.data);
        if (realId) {
          deps.lastRealSessionIdRef.current = realId;
        }
        if (realId && realId !== cid) {
          streamStore.alias(cid, realId);
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
          const queuedSteers = deps.pendingSteerMessagesRef.current.get(cid);
          if (queuedSteers) {
            deps.pendingSteerMessagesRef.current.set(realId, queuedSteers);
            deps.pendingSteerMessagesRef.current.delete(cid);
          }
          // 直显占位记录同步换键（同因：引导常在 id 解析前排队，占位挂在
          // pendingId 下——不换键则真实 id 选中态取不到，切回会话占位消失）。
          deps.setPendingSteerDisplay((prev) => {
            const live = prev[cid];
            if (!live || live.length === 0) return prev;
            const next = { ...prev };
            next[realId] = [...(prev[realId] ?? []), ...live];
            delete next[cid];
            return next;
          });
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
          const steerQueueKey = deps.pendingSteerMessagesRef.current.has(finalKey)
            ? finalKey
            : cid;
          const queuedSteers = deps.pendingSteerMessagesRef.current.get(steerQueueKey) ?? [];
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

          // Remove the first `count` steers from the session queue. Reads the
          // CURRENT ref (not the `queuedSteers` snapshot) so successive calls
          // within the same turn_complete — mid-turn steers then a leftover —
          // compose correctly instead of re-slicing the original array.
          const consumeSteerFromQueue = (count: number) => {
            if (count <= 0) return;
            const current = deps.pendingSteerMessagesRef.current.get(steerQueueKey) ?? [];
            const remaining = current.slice(count);
            if (remaining.length > 0) {
              deps.pendingSteerMessagesRef.current.set(steerQueueKey, remaining);
            } else {
              deps.pendingSteerMessagesRef.current.delete(steerQueueKey);
            }
          };
          // Drop the oldest `count` live placeholders (FIFO matches the queue
          // shift) for THIS session's key — v0.9.2 需求4：按 key 删除不再要求
          // 正在查看该会话，后台会话提交排队引导时同样正确消费自己的占位，
          // 不会残留到用户切回时与新提交的消息重复。
          const dropLivePlaceholders = (count: number) => {
            if (count <= 0) return;
            deps.setPendingSteerDisplay((prev) => {
              const list = prev[steerQueueKey];
              if (!list || list.length === 0) return prev;
              const remaining = list.slice(count);
              const next = { ...prev };
              if (remaining.length === 0) {
                delete next[steerQueueKey];
              } else {
                next[steerQueueKey] = remaining;
              }
              return next;
            });
          };
          if (interactionInsertions.length > 0) {
            const midSteerCount = Math.min(steerSplits.length, queuedSteers.length);
            const committed = commitAssistantWithInteractions({
              assistantContent,
              interactionInsertions,
              steerInsertions: steerSplits.slice(0, midSteerCount).map((index, i) => ({
                index,
                text: queuedSteers[i],
              })),
              error: state?.error,
            });
            newMessages.push(...committed.messages);
            consumeSteerFromQueue(midSteerCount);
            dropLivePlaceholders(midSteerCount);

            const leftover = deps.pendingSteerMessagesRef.current.get(steerQueueKey);
            if (leftover && leftover.length > 0) {
              newMessages.push({
                role: "user",
                content: [{ type: "text", text: leftover[0] }],
                timestamp: Date.now(),
              });
              followUpExpected = true;
              consumeSteerFromQueue(1);
              dropLivePlaceholders(1);
            }
          } else if (steerSplits.length > 0 && queuedSteers.length > 0) {
            // TOOL-BEARING turn with mid-turn steers: split the accumulated
            // content at each injection point and interleave the steers
            // between segments — yielding [reply1a, steer, reply1b] instead of
            // [reply1a+reply1b, steer], matching the JSONL order.
            const midCount = Math.min(steerSplits.length, queuedSteers.length);
            let prevIdx = 0;
            for (let i = 0; i < midCount; i++) {
              const seg = assistantContent.slice(prevIdx, steerSplits[i]);
              if (seg.length > 0) {
                newMessages.push({ role: "assistant", content: seg, timestamp: Date.now() });
              }
              newMessages.push({
                role: "user",
                content: [{ type: "text", text: queuedSteers[i] }],
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
            const leftover = deps.pendingSteerMessagesRef.current.get(steerQueueKey);
            if (leftover && leftover.length > 0) {
              newMessages.push({
                role: "user",
                content: [{ type: "text", text: leftover[0] }],
                timestamp: Date.now(),
              });
              followUpExpected = true;
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
              if (deps.supportsSteerRef.current) {
                // Pi-RPC: the queued steer is answered in a follow-up turn.
                // Commit it as a user message now; the response arrives in the
                // next turn_complete. followUpExpected pre-creates a "thinking"
                // state so the gap isn't blank.
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
              const merged = claimed.map((m) => m.content).join("\n\n");
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
