import { useSyncExternalStore } from "react";
import type { StreamChunk } from "@/types";

type Listener = () => void;

class StreamStore {
  private chunks: StreamChunk[] = [];
  private sid: string | null = null;
  private listeners = new Set<Listener>();
  private flushScheduled = false;

  setSession(sid: string | null) {
    this.sid = sid;
    this.chunks = [];
    this.flushScheduled = false;
    this.notify();
  }

  push(chunk: StreamChunk) {
    if (chunk.session_id !== this.sid) return;
    this.chunks.push(chunk);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    requestAnimationFrame(() => {
      this.flushScheduled = false;
      this.notify();
    });
  }

  snapshot = () => this.chunks;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  };

  getSessionId = () => this.sid;

  /** Force immediate notification (for result events) */
  flushNow() {
    this.flushScheduled = false;
    this.notify();
  }

  private notify() {
    this.listeners.forEach(l => l());
  }
}

export const streamStore = new StreamStore();

export function useStreamStore(): StreamChunk[] {
  return useSyncExternalStore(streamStore.subscribe, streamStore.snapshot);
}
