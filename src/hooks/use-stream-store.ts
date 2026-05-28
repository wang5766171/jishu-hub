import { useSyncExternalStore } from "react";
import type { StreamChunk } from "@/types";

type Listener = () => void;

export interface StreamToolUse {
  name: string;
  input: unknown;
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
}

function emptyState(abortKey: string, pendingUserMessage: string | null): SessionStreamState {
  return {
    chunks: [],
    text: "",
    thinking: "",
    error: "",
    tools: [],
    pendingUserMessage,
    resolvedId: null,
    abortKey,
    isStreaming: true,
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

    let { text, thinking, error, tools, resolvedId } = prev;
    const { pendingUserMessage, abortKey, isStreaming } = prev;
    const chunks = [...prev.chunks, chunk];

    const data = chunk.data;
    if (data.kind === "text_delta") {
      text = text + data.delta;
    } else if (data.kind === "thinking") {
      thinking = thinking + data.delta;
    } else if (data.kind === "error") {
      error = data.message;
    } else if (data.kind === "tool_use_start") {
      tools = [...tools, { name: data.tool, input: data.input }];
    } else if (data.kind === "message") {
      const newTools = [...tools];
      let newText = text;
      let newThinking = thinking;
      for (const block of data.content) {
        if (block.type === "tool_use") {
          newTools.push({ name: block.name, input: block.input });
        } else if (block.type === "text") {
          newText += block.text;
        } else if (block.type === "thinking") {
          newThinking += block.thinking;
        }
      }
      tools = newTools;
      text = newText;
      thinking = newThinking;
    } else if (data.kind === "session_resolved") {
      const realId = data.session_id;
      if (typeof realId === "string" && realId.length >= 8) {
        resolvedId = realId;
        if (realId !== key) {
          this.aliases.set(realId, key);
        }
      }
    }

    this.sessions.set(key, {
      chunks,
      text,
      thinking,
      error,
      tools,
      pendingUserMessage,
      resolvedId,
      abortKey,
      isStreaming,
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
