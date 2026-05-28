import { useSyncExternalStore } from "react";
import type { StreamChunk } from "@/types";

type Listener = () => void;

export interface StreamState {
  chunks: StreamChunk[];
  text: string;
  thinking: string;
  error: string;
  tools: Array<{ name: string; input: unknown }>;
}

class StreamStore {
  private chunks: StreamChunk[] = [];
  private text = "";
  private thinking = "";
  private error = "";
  private tools: Array<{ name: string; input: unknown }> = [];
  
  private _snapshot: StreamState = { chunks: [], text: "", thinking: "", error: "", tools: [] };
  private sid: string | null = null;
  private listeners = new Set<Listener>();
  private flushScheduled = false;

  setSession(sid: string | null) {
    this.sid = sid;
    this.chunks = [];
    this.text = "";
    this.thinking = "";
    this.error = "";
    this.tools = [];
    this._snapshot = { chunks: [], text: "", thinking: "", error: "", tools: [] };
    this.flushScheduled = false;
    this.notify();
  }

  push(chunk: StreamChunk) {
    if (chunk.session_id !== this.sid) return;
    this.chunks.push(chunk);

    // Process chunk immediately
    if (chunk.data.kind === "text_delta") {
      this.text += chunk.data.delta;
    } else if (chunk.data.kind === "thinking") {
      this.thinking += chunk.data.delta;
    } else if (chunk.data.kind === "error") {
      this.error = chunk.data.message;
    } else if (chunk.data.kind === "tool_use_start") {
      this.tools.push({ name: chunk.data.tool, input: chunk.data.input });
    } else if (chunk.data.kind === "message") {
      for (const block of chunk.data.content) {
        if (block.type === "tool_use") {
          this.tools.push({ name: block.name, input: block.input });
        } else if (block.type === "text") {
          this.text += block.text;
        } else if (block.type === "thinking") {
          this.thinking += block.thinking;
        }
      }
    }

    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(() => {
      this.flushScheduled = false;
      this._snapshot = {
        chunks: this.chunks,
        text: this.text,
        thinking: this.thinking,
        error: this.error,
        tools: [...this.tools],
      };
      this.notify();
    }, 50);
  }

  snapshot = () => this._snapshot;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  };

  getSessionId = () => this.sid;

  /** Force immediate notification (for result events) */
  flushNow() {
    this.flushScheduled = false;
    this._snapshot = {
      chunks: this.chunks,
      text: this.text,
      thinking: this.thinking,
      error: this.error,
      tools: [...this.tools],
    };
    this.notify();
  }

  private notify() {
    this.listeners.forEach(l => l());
  }
}

export const streamStore = new StreamStore();

export function useStreamStore(): StreamState {
  return useSyncExternalStore(streamStore.subscribe, streamStore.snapshot);
}

