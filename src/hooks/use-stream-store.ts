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
  };
}

class StreamStore {
  /** Canonical key -> state. */
  private sessions = new Map<string, SessionStreamState>();
  /** Any-id -> canonical key. */
  private aliases = new Map<string, string>();
  private listeners = new Set<Listener>();
  private flushScheduled = false;

  private canonical(sid: string): string {
    return this.aliases.get(sid) ?? sid;
  }

  /** Begin tracking a session that we just sent a message to. */
  start(canonicalId: string, pendingUserMessage: string | null): void {
    const key = this.canonical(canonicalId);
    if (this.sessions.has(key)) return; // already pre-registered
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

  /** Push a chunk into the appropriate per-session buffer. */
  push(sid: string, chunk: StreamChunk): void {
    const key = this.canonical(sid);
    const prev = this.sessions.get(key) ?? emptyState(key, null);

    let { content, text, thinking, error, tools, resolvedId, steps } = prev;
    const { pendingUserMessage, abortKey, isStreaming } = prev;
    const chunks = [...prev.chunks, chunk];

    const data = chunk.data;
    if (data.kind === "text_delta") {
      text = text + data.delta;
      content = appendTextBlock(content, data.delta);
    } else if (data.kind === "thinking") {
      thinking = thinking + data.delta;
      content = appendThinkingBlock(content, data.delta);
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
    });
    this.scheduleFlush();
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

  hasState(sid: string | null | undefined): boolean {
    return this.getState(sid) !== null;
  }

  getStreamingIds(): string[] {
    const ids: string[] = [];
    for (const [key, value] of this.sessions) {
      if (value.isStreaming) ids.push(key);
    }
    return ids;
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
    setTimeout(() => {
      this.flushScheduled = false;
      this.notify();
    }, 50);
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
  if (last?.type === "text") {
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
  if (last?.type === "thinking") {
    next[next.length - 1] = { ...last, thinking: last.thinking + delta };
    return next;
  }
  next.push({ type: "thinking", thinking: delta });
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
