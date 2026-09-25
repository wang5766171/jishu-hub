import { describe, expect, it } from "vitest";
import {
  clearDevLogs,
  devLog,
  devLogVersion,
  formatDevLogs,
  getDevLogs,
  subscribeDevLogs,
} from "./dev-log";

/** v0.9.4 需求12：dev 日志总线（vitest 环境 IS_DEV=true——vite test 默认 DEV）。 */
describe("dev-log 总线", () => {
  it("写入/快照/序号递增/订阅通知", () => {
    clearDevLogs();
    let notified = 0;
    const unsub = subscribeDevLogs(() => { notified += 1; });
    devLog("pipeline", "chunk turn_complete", { session: "s1", reason: "Complete" });
    devLog("steer", "stage", { key: "s1" });
    const entries = getDevLogs();
    expect(entries).toHaveLength(2);
    expect(entries[0].seq).toBeLessThan(entries[1].seq);
    expect(entries[0].category).toBe("pipeline");
    expect(notified).toBeGreaterThanOrEqual(2);
    unsub();
    clearDevLogs();
  });

  it("formatDevLogs 可复制文本格式（含相对时间/类别/data）", () => {
    clearDevLogs();
    devLog("ipc", "send_message ok", { ms: 42, sessionId: "s1" });
    devLog("store", "drop", { id: "s1" });
    const text = formatDevLogs();
    expect(text).toContain("[ipc] send_message ok");
    expect(text).toContain("[store] drop");
    expect(text).toContain("sessionId");
    clearDevLogs();
  });

  it("类别过滤", () => {
    clearDevLogs();
    devLog("ipc", "a");
    devLog("steer", "b");
    expect(formatDevLogs(["steer"])).toContain("[steer] b");
    expect(formatDevLogs(["steer"])).not.toContain("[ipc] a");
    expect(devLogVersion()).toBeGreaterThan(0);
    clearDevLogs();
  });
});
