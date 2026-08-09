import { useSyncExternalStore } from "react";
import type { ContentBlock, StreamChunk } from "@/types";

type Listener = () => void;

export interface StreamToolUse {
  id: string;
  name: string;
  input: unknown;
  output?: unknown;
  isError?: boolean;
}

export interface StepInfo {
  runId: string;
  stepId: string;
  kind: string;
  title: string;
}

export interface InteractionSplit {
  requestId: string;
  index: number;
  text: string | null;
  /** Question prompt text (captured from interaction_request event). */
  prompt: string;
  /** Available options (captured from interaction_request event). */
  options: Array<{ option_id: string; label: string; description?: string | null }>;
  /** Origin label for display (e.g. "extension_ui", "acp_elicitation"). */
  origin?: string;
  /** Option ids selected by the user, captured when the response is submitted. */
  selectedOptions?: string[];
}

/**
 * Per-session streaming state.
 *
 * One entry exists per active or recently-active CLI stream. Entries are keyed
 * by the *canonical* session id (the id we used when we first started the
 * stream — usually `pending-<pid>` until a real id is known).
 *
 * `abortKey` is always the original id we sent to the backend, so callers can
 * stop the stream regardless of how the id was later resolved.
 */
export interface SessionStreamState {
  chunks: StreamChunk[];
  content: ContentBlock[];
  text: string;
  thinking: string;
  error: string;
  tools: StreamToolUse[];
  pendingUserMessage: string | null;
  /** Real session id if a `session_resolved` event was seen. */
  resolvedId: string | null;
  /** Id to pass to `abort_chat` (matches what the backend tracks). */
  abortKey: string;
  /** True while the stream is open; flips to false on turn_complete. */
  isStreaming: boolean;
  /** Step events from the orchestrator (v0.6.0). */
  steps: StepInfo[];
  /**
   * Content-array indices at which a steer (user message) was injected
   * mid-turn. Each entry is `content.length` captured when the steer marker
   * arrived, i.e. the start index of the next assistant segment. Populated
   * only for tool-bearing turns where Pi folds the steer's reply into the
   * same turn; turn_complete splits `content` at these indices and
   * interleaves the queued steers between the segments to match the JSONL
   * order. Reset on start/drop.
   */
  steerSplits: number[];
  /**
   * Text of each steer (user message) injected mid-turn, parallel to
   * `steerSplits`. Populated from the steer marker's content so the live
   * streaming view can render the guide inline between assistant segments
   * (matching the final committed order) rather than pinned at the bottom.
   * Reset on start/drop.
   */
  steerTexts: string[];
  /**
   * Extension UI interaction answers inserted mid-turn. The index is captured
   * when Pi emits `extension_ui_request`; the text is filled when the user
   * responds via `extension_ui_response`.
   */
  interactionSplits: InteractionSplit[];
}

function emptyState(abortKey: string, pendingUserMessage: string | null): SessionStreamState {
  return {
    chunks: [],
    content: [],
    text: "",
    thinking: "",
    error: "",
    tools: [],
    pendingUserMessage,
    resolvedId: null,
    abortKey,
    isStreaming: true,
    steps: [],
    steerSplits: [],
    steerTexts: [],
    interactionSplits: [],
  };
}

export interface InteractionResponseCheckpoint {
  key: string;
  interactionSplits: InteractionSplit[];
}

function canStartContinuationStream(chunk: StreamChunk): boolean {
  return chunk.data.kind === "text_delta"
    || chunk.data.kind === "thinking"
    || chunk.data.kind === "tool_use_start"
    || chunk.data.kind === "tool_use_result"
    || chunk.data.kind === "message"
    || chunk.data.kind === "phase_divider"
    || chunk.data.kind === "interaction_request";
}

class StreamStore {
  /** Canonical key -> state. */
  private sessions = new Map<string, SessionStreamState>();
  /** Any-id -> canonical key. */
  private aliases = new Map<string, string>();
  /** Per-session conductor phase (from phase_divider events). Independent of
   *  stream state so it survives drop() — used to tell conductor-driven
   *  followUp (execute node advance) apart from a final turn. */
  private conductorPhases = new Map<string, string>();
  private listeners = new Set<Listener>();
  private flushScheduled = false;

  private canonical(sid: string): string {
    return this.aliases.get(sid) ?? sid;
  }

  /** Begin tracking a session that we just sent a message to. */
  start(canonicalId: string, pendingUserMessage: string | null): void {
    const key = this.canonical(canonicalId);
    // Reset the state for a new turn, even if the key already exists
    // (e.g. second message in the same session).
    this.sessions.set(key, emptyState(key, pendingUserMessage));
    this.scheduleFlush();
  }

  /** Record that `otherId` refers to the same stream as `canonicalId`. */
  alias(canonicalId: string, otherId: string): void {
    if (otherId === canonicalId) return;
    const key = this.canonical(canonicalId);
    this.aliases.set(otherId, key);
    this.aliases.set(canonicalId, key);
  }

  /** Push only events that belong to an existing stream or can start a
   *  continuation. Lifecycle-only events must not create empty streaming state. */
  pushTracked(sid: string, chunk: StreamChunk): boolean {
    if (!this.hasState(sid)) {
      if (!canStartContinuationStream(chunk)) return false;
      this.start(sid, null);
    }
    this.push(sid, chunk);
    return true;
  }

  /** Push a chunk into the appropriate per-session buffer. */
  push(sid: string, chunk: StreamChunk): void {
    const key = this.canonical(sid);
    const prev = this.sessions.get(key) ?? emptyState(key, null);

    let { content, text, thinking, error, tools, resolvedId, steps, steerSplits, steerTexts, interactionSplits } = prev;
    const { pendingUserMessage, abortKey, isStreaming } = prev;
    const chunks = [...prev.chunks, chunk];

    const data = chunk.data;
    if (data.kind === "text_delta") {
      // Snapshot-echo guard: claude-agent-acp streams the reply as many small
      // text_delta chunks, then re-sends the WHOLE reply as one final text_delta
      // (an assembled-message fallback whose messageId dedup misses on
      // non-Anthropic gateways like the user's glm endpoint). That echo's delta
      // exactly equals the text already accumulated from the live deltas, so
      // dropping an exact match is lossless and zero-false-positive — a real
      // incremental delta can never equal the ENTIRE prior accumulation.
      if (text.length > 0 && text === data.delta) {
        // snapshot echo of already-streamed text — skip
      } else {
        text = text + data.delta;
        content = appendTextBlock(content, data.delta);
      }
    } else if (data.kind === "thinking") {
      if (thinking.length > 0 && thinking === data.delta) {
        // snapshot echo of already-streamed thinking — skip
      } else {
        thinking = thinking + data.delta;
        content = appendThinkingBlock(content, data.delta);
      }
    } else if (data.kind === "error") {
      error = data.message;
    } else if (data.kind === "tool_use_start") {
      if (!tools.some((tool) => tool.id === data.call_id)) {
        tools = [...tools, { id: data.call_id, name: data.tool, input: data.input }];
        content = [...content, { type: "tool_use", id: data.call_id, name: data.tool, input: data.input }];
      }
    } else if (data.kind === "tool_use_result") {
      tools = tools.map((tool) => (
        tool.id === data.call_id ? { ...tool, output: data.output, isError: data.is_error } : tool
      ));
      if (!content.some((block) => block.type === "tool_result" && block.tool_use_id === data.call_id)) {
        content = [...content, { type: "tool_result", tool_use_id: data.call_id, content: data.output }];
      }
    } else if (data.kind === "message") {
      const newTools = [...tools];
      let newContent = content;
      for (const block of data.content) {
        if (block.type === "tool_use") {
          if (!newTools.some((tool) => tool.id === block.id)) {
            newTools.push({ id: block.id, name: block.name, input: block.input });
            newContent = [...newContent, block];
          }
        } else if (block.type === "tool_result") {
          if (!newContent.some((item) => item.type === "tool_result" && item.tool_use_id === block.tool_use_id)) {
            newContent = [...newContent, block];
          }
        }
        // Skip text/thinking blocks — they arrive via text_delta/thinking
        // incremental events. Accepting them here causes duplicates when
        // multiple text blocks are separated by tool calls.
      }
      tools = newTools;
      content = newContent;
    } else if (data.kind === "session_resolved") {
      const realId = data.session_id;
      if (typeof realId === "string" && realId.length >= 8) {
        resolvedId = realId;
        if (realId !== key) {
          this.aliases.set(realId, key);
        }
      }
    } else if (data.kind === "task_step") {
      steps = [...steps, { runId: data.run_id, stepId: data.step_id, kind: data.step_kind, title: data.title }];
    } else if (data.kind === "steer_injected") {
      // Record the index at which Pi injected the steer (the start of the
      // next assistant segment), plus the steer's text so the live view can
      // render the guide inline at that split. Only record when assistant
      // content already exists: a no-tool follow-up steer arrives right after
      // the streaming state is reset to empty, and a spurious split there
      // would mis-split the follow-up turn's reply (and render the follow-up
      // guide at the bottom instead of as a committed user message).
      if (content.length > 0) {
        steerSplits = [...steerSplits, content.length];
        steerTexts = [...steerTexts, data.content];
        content = freezeLastBlock(content);
      }
    } else if (data.kind === "phase_divider") {
      // Phase transition divider — push as a content block so it renders
      // inline in the message stream at the position it occurred. setStatus
      // and explicit phase-enter can report the same boundary consecutively.
      content = freezeLastBlock(content);
      const last = content[content.length - 1];
      if (
        last?.type !== "phase_divider"
        || last.phase !== data.phase
        || last.title !== data.title
      ) {
        content = [...content, { type: "phase_divider" as const, phase: data.phase, title: data.title }];
      }
      this.conductorPhases.set(key, data.phase);
    } else if (data.kind === "interaction_request") {
      if (!interactionSplits.some((item) => item.requestId === data.request_id)) {
        interactionSplits = [
          ...interactionSplits,
          {
            requestId: data.request_id,
            index: content.length,
            text: null,
            prompt: data.prompt ?? "",
            options: data.options ?? [],
            origin: data.origin,
          },
        ];
        content = freezeLastBlock(content);
      }
    } else if (data.kind === "sub_agent_event") {
      // Recursively surface inner event content (text/thinking) from sub-agents
      const inner = data.sub_event;
      if (inner) {
        if (inner.kind === "text_delta" && inner.delta) {
          text = text + inner.delta;
          content = appendTextBlock(content, inner.delta);
        } else if (inner.kind === "thinking" && inner.delta) {
          thinking = thinking + inner.delta;
          content = appendThinkingBlock(content, inner.delta);
        } else if (inner.kind === "error" && inner.message) {
          error = inner.message;
        }
      }
    }
    // sub_agent_dispatch — stored in chunks only

    this.sessions.set(key, {
      chunks,
      content,
      text,
      thinking,
      error,
      tools,
      pendingUserMessage,
      resolvedId,
      abortKey,
      isStreaming,
      steps,
      steerSplits,
      steerTexts,
      interactionSplits,
    });
    this.scheduleFlush();
  }

  recordInteractionResponseWithCheckpoint(
    sid: string,
    requestId: string,
    text: string,
    selectedOptions: string[] = [],
  ): InteractionResponseCheckpoint | null {
    const key = this.canonical(sid);
    const prev = this.sessions.get(key);
    if (!prev) return null;

    let found = false;
    const interactionSplits = prev.interactionSplits.map((item) => {
      if (item.requestId !== requestId) return item;
      found = true;
      return { ...item, text, selectedOptions };
    });
    if (!found) return null;

    const checkpoint = { key, interactionSplits: prev.interactionSplits };
    this.sessions.set(key, { ...prev, interactionSplits });
    this.scheduleFlush();
    return checkpoint;
  }

  recordInteractionResponse(
    sid: string,
    requestId: string,
    text: string,
    selectedOptions: string[] = [],
  ): boolean {
    return this.recordInteractionResponseWithCheckpoint(
      sid,
      requestId,
      text,
      selectedOptions,
    ) !== null;
  }

  rollbackInteractionResponse(checkpoint: InteractionResponseCheckpoint | null): boolean {
    if (!checkpoint) return false;
    const prev = this.sessions.get(checkpoint.key);
    if (!prev) return false;
    this.sessions.set(checkpoint.key, {
      ...prev,
      interactionSplits: checkpoint.interactionSplits,
    });
    this.scheduleFlush();
    return true;
  }

  /** Remove the interaction-split placeholder for `requestId`. Used when an
   *  interaction is answered as a follow-up message (design R6: follow-up
   *  answers are NOT interleaved inline) so no phantom gap is left in the
   *  accumulated assistant content. */
  removeInteractionSplit(sid: string, requestId: string): boolean {
    const key = this.canonical(sid);
    const prev = this.sessions.get(key);
    if (!prev) return false;
    if (!prev.interactionSplits.some((item) => item.requestId === requestId)) {
      return false;
    }
    const interactionSplits = prev.interactionSplits.filter(
      (item) => item.requestId !== requestId,
    );
    this.sessions.set(key, { ...prev, interactionSplits });
    this.scheduleFlush();
    return true;
  }

  /** Mark a session as no longer streaming. State is retained until `drop`. */
  end(sid: string): void {
    const key = this.canonical(sid);
    const prev = this.sessions.get(key);
    if (!prev || !prev.isStreaming) return;
    this.sessions.set(key, { ...prev, isStreaming: false });
    this.scheduleFlush();
  }

  /** Remove all state for a session. */
  drop(sid: string): void {
    const key = this.canonical(sid);
    this.sessions.delete(key);
    for (const [k, v] of Array.from(this.aliases.entries())) {
      if (v === key || k === key) this.aliases.delete(k);
    }
    this.scheduleFlush();
  }

  getState(sid: string | null | undefined): SessionStreamState | null {
    if (!sid) return null;
    const key = this.canonical(sid);
    return this.sessions.get(key) ?? null;
  }

  isStreaming(sid: string | null | undefined): boolean {
    return this.getState(sid)?.isStreaming ?? false;
  }

  /** v0.7.0 诊断：返回所有正在 streaming 的 session key（用于排查 turn_complete 丢失）。 */
  getStreamingIds(): string[] {
    const ids: string[] = [];
    for (const [key, value] of this.sessions) {
      if (value.isStreaming) ids.push(key);
    }
    return ids;
  }

  /** 当前会话的 conductor phase（从 phase_divider 事件跟踪），drop 后仍可读。 */
  getConductorPhase(sid: string | null | undefined): string | null {
    if (!sid) return null;
    return this.conductorPhases.get(this.canonical(sid)) ?? null;
  }

  hasState(sid: string | null | undefined): boolean {
    return this.getState(sid) !== null;
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  flushNow(): void {
    this.flushScheduled = false;
    this.notify();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    requestAnimationFrame(() => {
      this.flushScheduled = false;
      this.notify();
    });
  }

  private notify(): void {
    this.listeners.forEach((l) => l());
  }
}

export const streamStore = new StreamStore();

function appendTextBlock(content: ContentBlock[], delta: string): ContentBlock[] {
  if (!delta) return content;
  const next = [...content];
  const last = next[next.length - 1];
  if (last?.type === "text" && !last.frozen) {
    next[next.length - 1] = { ...last, text: last.text + delta };
    return next;
  }
  next.push({ type: "text", text: delta });
  return next;
}

function appendThinkingBlock(content: ContentBlock[], delta: string): ContentBlock[] {
  if (!delta) return content;
  const next = [...content];
  const last = next[next.length - 1];
  if (last?.type === "thinking" && !last.frozen) {
    next[next.length - 1] = { ...last, thinking: last.thinking + delta };
    return next;
  }
  next.push({ type: "thinking", thinking: delta });
  return next;
}

function freezeLastBlock(content: ContentBlock[]): ContentBlock[] {
  if (content.length === 0) return content;
  const next = [...content];
  const last = next[next.length - 1];
  if (last && (last.type === "text" || last.type === "thinking")) {
    next[next.length - 1] = { ...last, frozen: true };
  }
  return next;
}

export function useSessionStream(sid: string | null | undefined): SessionStreamState | null {
  return useSyncExternalStore(
    streamStore.subscribe,
    () => streamStore.getState(sid),
  );
}

export function useIsSessionStreaming(sid: string | null | undefined): boolean {
  return useSyncExternalStore(
    streamStore.subscribe,
    () => streamStore.isStreaming(sid),
  );
}

let lastStreamingIdsSnapshot: { value: readonly string[]; key: string } = {
  value: Object.freeze([] as string[]),
  key: "",
};
function streamingIdsSnapshot(): readonly string[] {
  const ids = streamStore.getStreamingIds();
  const key = ids.join("|");
  if (lastStreamingIdsSnapshot.key === key) return lastStreamingIdsSnapshot.value;
  lastStreamingIdsSnapshot = { value: Object.freeze(ids), key };
  return lastStreamingIdsSnapshot.value;
}

export function useStreamingSessionIds(): readonly string[] {
  return useSyncExternalStore(streamStore.subscribe, streamingIdsSnapshot);
}
