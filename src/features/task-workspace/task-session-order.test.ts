/**
 * 任务行排序单测（TO-U1～U4）——与普通会话同一口径：按任务主会话的最后活动
 * 排，没有会话活动的按实例 updated_at 兜底；查看（数据不变）自然不动位置。
 */
import { describe, expect, it } from "vitest";

import { sortTaskSessionsByConversation } from "./task-session-order";

const H0 = "2026-11-26T10:00:00+08:00";
const H1 = "2026-11-27T08:00:00+08:00";
const H2 = "2026-11-27T09:00:00+08:00";
/** 会话最后活动（H2=09:00）换算成毫秒，作兜底时间的对照档 */
const H2_MS = Date.parse(H2);

describe("任务行排序（按最近对话）", () => {
  it("按任务主会话的最后活动排，实例时间旧不拖后——TO-U1", () => {
    const tasks = [
      { task_id: "a", task_session_id: "sa", updated_at: Date.parse(H0) }, // 会话旧、实例同样旧
      { task_id: "b", task_session_id: "sb", updated_at: 1 }, // 会话新、实例时间很小
    ];
    const sessions = [
      { id: "sa", last_active: H0 },
      { id: "sb", last_active: H2 },
    ];
    // 若按实例 updated_at 排，a 在前（b 的 updated_at 是 1970 年）；按最近对话
    // 排，b 在前——这正是本排序要改掉的行为
    expect(sortTaskSessionsByConversation(tasks, sessions).map((t) => t.task_id)).toEqual([
      "b",
      "a",
    ]);
  });

  it("会话不在列表里 / 没有主会话 → 按 updated_at 兜底——TO-U2", () => {
    const tasks = [
      { task_id: "old", task_session_id: null, updated_at: 100 },
      { task_id: "missing", task_session_id: "sx", updated_at: 900 },
      { task_id: "new", task_session_id: "sy", updated_at: 500 },
    ];
    const sessions = [{ id: "sy", last_active: H0 }];
    // H0（11-26）晚于 900？不——900 是 1970 年的毫秒数，H0 更新；三个键：
    // old=100、missing=900、new=H0_MS → new 最前，其次 missing，最后 old
    expect(sortTaskSessionsByConversation(tasks, sessions).map((t) => t.task_id)).toEqual([
      "new",
      "missing",
      "old",
    ]);
  });

  it("哪边更近算哪边：会话比实例旧时用实例时间——TO-U3", () => {
    const tasks = [
      { task_id: "chatty", task_session_id: "s1", updated_at: H2_MS + 50_000 }, // 对话旧、后来跑过任务
      { task_id: "quiet", task_session_id: "s2", updated_at: H2_MS }, // 对话新、任务没动
    ];
    const sessions = [
      { id: "s1", last_active: H1 }, // 08:00
      { id: "s2", last_active: H2 }, // 09:00
    ];
    // chatty 键=max(08:00, 09:00+50s)=09:00+50s；quiet 键=max(09:00, 09:00)=09:00
    expect(sortTaskSessionsByConversation(tasks, sessions).map((t) => t.task_id)).toEqual([
      "chatty",
      "quiet",
    ]);
  });

  it("排序键相同保持传入顺序（稳定）；数据不变结果不变——TO-U4", () => {
    const tasks = [
      { task_id: "x", task_session_id: null, updated_at: 1000 },
      { task_id: "y", task_session_id: null, updated_at: 1000 },
    ];
    const first = sortTaskSessionsByConversation(tasks, []);
    const second = sortTaskSessionsByConversation(tasks, []);
    expect(first.map((t) => t.task_id)).toEqual(["x", "y"]);
    expect(second.map((t) => t.task_id)).toEqual(["x", "y"]);
  });

  it("不改动传入的数组（调用方还要继续用）", () => {
    const tasks = [
      { task_id: "a", task_session_id: null, updated_at: 1 },
      { task_id: "b", task_session_id: null, updated_at: 2 },
    ];
    sortTaskSessionsByConversation(tasks, []);
    expect(tasks.map((t) => t.task_id)).toEqual(["a", "b"]);
  });
});
