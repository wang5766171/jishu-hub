import { useCallback, useEffect, useRef, useState } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import { subscribeSessionSignals } from "@/features/session-kernel/signals";
import type { Project } from "@/types";

/**
 * v0.9.6 需求4 补充②：项目标签固定 + 会话状态灯（2026-11-03 用户裁决）。
 *
 * - **固定**：切换离开的项目自动固定（A 跑任务切到 B，A 固定不消失——修「任务
 *   回复完标签就关闭了，还没看到结果」）；手动解除前常驻，跨重启持久
 *   （localStorage——UI 偏好态，随 webview 数据目录持久化）。
 * - **最近会话**：轮询 chat_active_sessions 时顺手记录各项目最近活跃会话
 *   （含 agentId），点击固定标签直达它；无历史记录则只切项目。
 * - **状态灯**：蓝=进行中（active 轮询，实时）/ 绿=完成 / 红=失败（turn-complete
 *   信号，按 lastSession 反查项目归属）；点击标签即视为已查看，清除绿/红。
 */

const PINS_KEY = "jishu-titlebar-pinned-projects";
const LAST_KEY = "jishu-titlebar-last-session";

export type TabLight = "running" | "done" | "failed";

interface LastSessionInfo {
  sessionId: string;
  agentId: string;
}

export interface ProjectTabsState {
  pins: string[];
  /** 项目 → 状态灯（内存态：running 随轮询实时，done/failed 由回合结束信号
   * 驱动；重启后无活跃即中性——历史结果不跨重启追忆）。 */
  lights: Record<string, TabLight>;
  lastSession: Record<string, LastSessionInfo>;
  pinProject: (encoded: string) => void;
  unpinProject: (encoded: string) => void;
  /** v0.9.6 补充③：拖拽重排固定标签顺序（持久化——标签位置固定不跳动）。 */
  reorderPins: (from: string, to: string) => void;
  /** 离开项目时调用（自动固定入口）。 */
  noteLeave: (project: Project | null) => void;
  /** 点击标签（已查看）——清绿/红灯。 */
  clearLight: (encoded: string) => void;
  /** v0.9.6 补充⑦：抑制下一次对该项目的离开自动固定（关闭当前标签时用——
   * 关闭=取消固定，若不抑制，切换触发 noteLeave 会把它固定回来）。 */
  suppressPinOnce: (encoded: string) => void;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

const POLL_MS = 3000;

export function useProjectTabs(): ProjectTabsState {
  const [pins, setPins] = useState<string[]>(() => readJson<string[]>(PINS_KEY, []));
  const [lights, setLights] = useState<Record<string, TabLight>>({});
  const [lastSession, setLastSession] = useState<Record<string, LastSessionInfo>>(() =>
    readJson<Record<string, LastSessionInfo>>(LAST_KEY, {}));
  // 轮询快照（不驱动渲染的活跃集合，供信号归属反查）
  const activeRef = useRef<Map<string, { sessionId: string; agentId: string }>>(new Map());
  const lastRef = useRef(lastSession);
  lastRef.current = lastSession;

  const pinProject = useCallback((encoded: string) => {
    setPins(prev => {
      if (prev.includes(encoded)) return prev;
      const next = [...prev, encoded];
      localStorage.setItem(PINS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const unpinProject = useCallback((encoded: string) => {
    setPins(prev => {
      const next = prev.filter(p => p !== encoded);
      localStorage.setItem(PINS_KEY, JSON.stringify(next));
      return next;
    });
    setLights(prev => {
      if (!(encoded in prev)) return prev;
      const next = { ...prev };
      delete next[encoded];
      return next;
    });
  }, []);

  const reorderPins = useCallback((from: string, to: string) => {
    if (from === to) return;
    setPins(prev => {
      const fromIdx = prev.indexOf(from);
      const toIdx = prev.indexOf(to);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const next = [...prev];
      next.splice(fromIdx, 1);
      next.splice(toIdx, 0, from);
      localStorage.setItem(PINS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const suppressRef = useRef<Set<string>>(new Set());
  const suppressPinOnce = useCallback((encoded: string) => {
    suppressRef.current.add(encoded);
  }, []);
  const noteLeave = useCallback((project: Project | null) => {
    if (!project) return;
    if (suppressRef.current.delete(project.encoded_name)) return; // 关闭触发的离开不固定
    pinProject(project.encoded_name);
  }, [pinProject]);

  const clearLight = useCallback((encoded: string) => {
    setLights(prev => {
      if (!(encoded in prev)) return prev;
      const next = { ...prev };
      delete next[encoded];
      return next;
    });
  }, []);

  // 活跃回合轮询：running 灯 + 最近会话记录
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const rows = await invokeCommand<
          { session_id: string; agent_id: string; project_encoded: string }[]
        >("chat_active_sessions");
        if (stopped || !Array.isArray(rows)) return;
        const runningByProject = new Set<string>();
        const latest = new Map<string, { sessionId: string; agentId: string }>();
        for (const r of rows) {
          if (!r.project_encoded) continue;
          runningByProject.add(r.project_encoded);
          // 后端进程表 pending-* 与真实 id 双键并存——记录优先真实 id
          //（turn-complete 信号的 sessionId 是 resolve 后的真实 id，pending
          // 键匹配不上会导致状态灯不更新——R3 实测教训）。
          const cur = latest.get(r.project_encoded);
          const curIsPending = cur?.sessionId.startsWith("pending-") ?? false;
          const rIsPending = r.session_id.startsWith("pending-");
          if (!cur || (curIsPending && !rIsPending)) {
            latest.set(r.project_encoded, { sessionId: r.session_id, agentId: r.agent_id });
          }
        }
        activeRef.current = latest;
        // 最近会话记录（活跃才更新；持久化）
        let lastDirty = false;
        const nextLast = { ...lastRef.current };
        for (const [enc, info] of latest) {
          if (nextLast[enc]?.sessionId !== info.sessionId) {
            nextLast[enc] = info;
            lastDirty = true;
          }
        }
        if (lastDirty) {
          setLastSession(nextLast);
          lastRef.current = nextLast;
          localStorage.setItem(LAST_KEY, JSON.stringify(nextLast));
        }
        // running 灯（非 running 项目不动——保留 done/failed）
        setLights(prev => {
          let changed = false;
          const next = { ...prev };
          for (const enc of new Set([...Object.keys(prev), ...runningByProject])) {
              const isRunning = prev[enc] === "running";
            if (runningByProject.has(enc) && !isRunning) { next[enc] = "running"; changed = true; }
            else if (!runningByProject.has(enc) && isRunning) { delete next[enc]; changed = true; }
          }
          return changed ? next : prev;
        });
      } catch {
        /* 单次失败静默 */
      }
    };
    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // 回合结束信号：done / failed（按活跃记录反查项目归属）
  useEffect(() => {
    const unsub = subscribeSessionSignals(signal => {
      if (signal.type !== "turn-complete") return;
      const { sessionId, error } = signal as { type: "turn-complete"; sessionId: string; error?: boolean };
      for (const [enc, info] of activeRef.current) {
        if (info.sessionId === sessionId) {
          setLights(prev => ({ ...prev, [enc]: error ? "failed" : "done" }));
          return;
        }
      }
      // 活跃快照已过期（回合结束后轮询间隙）→ 用 lastSession 反查兜底
      for (const [enc, info] of Object.entries(lastRef.current)) {
        if (info.sessionId === sessionId) {
          setLights(prev => ({ ...prev, [enc]: error ? "failed" : "done" }));
          return;
        }
      }
    });
    return unsub;
  }, []);

  return { pins, lights, lastSession, pinProject, unpinProject, reorderPins, noteLeave, clearLight, suppressPinOnce };
}
