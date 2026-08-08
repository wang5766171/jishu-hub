import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { TaskEvent } from "@/features/task-instance/graph/use-task-graph";
import { eventToMessage } from "./run-event-messages";

/** 最小 t 实现：返回 fallback 并做 {{var}} 插值，足以断言投影文本。 */
const t = ((_key: string, fallback?: string, opts?: Record<string, unknown>) => {
  let s = typeof fallback === "string" ? fallback : _key;
  if (opts) {
    for (const [k, v] of Object.entries(opts)) {
      s = s.replace(new RegExp(`{{${k}}}`, "g"), String(v));
    }
  }
  return s;
}) as unknown as TFunction;

function ev(event_type: string, payload: Record<string, unknown> = {}): TaskEvent {
  return {
    event_id: event_type,
    run_id: "run_1",
    run_seq: 1,
    event_type,
    occurred_at: 1,
    actor: "engine",
    payload,
  };
}

describe("eventToMessage 投影", () => {
  it("attempt_progressed 被抑制（不刷屏）", () => {
    expect(eventToMessage(ev("attempt_progressed", { message: "tick" }), t)).toBeNull();
  });

  it("lease_granted 被抑制（租约属底层事件）", () => {
    expect(eventToMessage(ev("lease_granted", { lease_id: "l1" }), t)).toBeNull();
  });

  it("其余底层事件也被抑制（loop/revision/recovery/artifact 等）", () => {
    for (const type of [
      "lease_expired",
      "loop_sleeping",
      "loop_started",
      "loop_completed",
      "iteration_started",
      "progress_evaluated",
      "revision_created",
      "revision_applied_to_run",
      "repair_graph_attached",
      "recovery_chosen",
      "node_superseded",
      "artifact_produced",
    ]) {
      expect(eventToMessage(ev(type, {}), t), type).toBeNull();
    }
  });

  it("attempt_started 只带 node_run_id 时解析出标题而非裸 ID", () => {
    const titles = new Map([["nr_abc", "开发登录页面"]]);
    const m = eventToMessage(
      ev("attempt_started", { node_run_id: "nr_abc", attempt_number: 1 }),
      t,
      titles,
    );
    expect(m).not.toBeNull();
    const text = (m!.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("开发登录页面");
    expect(text).not.toContain("nr_abc");
  });

  it("node_ready 带 node_id 时解析出标题（回归）", () => {
    const titles = new Map([["nd_1", "开发登录页面"]]);
    const m = eventToMessage(
      ev("node_ready", { node_id: "nd_1", node_run_id: "nr_1" }),
      t,
      titles,
    );
    const text = (m!.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("开发登录页面");
  });

  it("未知事件仍可见（Q2 反静默丢弃，避免隐藏新事件）", () => {
    const m = eventToMessage(ev("some_future_event", {}), t);
    expect(m).not.toBeNull();
    const text = (m!.content[0] as { type: "text"; text: string }).text;
    expect(text).toBe("· some_future_event");
  });
});
