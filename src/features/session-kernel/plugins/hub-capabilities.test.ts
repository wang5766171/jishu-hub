/**
 * hub 能力面单测（第四轮评审修复轮新增——二十三轮桥接逻辑埋在 chat-page
 * useMemo 里不可测，本体外移后首次可测）。
 *
 * 断言口径 = 跨端契约锚定（R4 生产实测已对齐真机；本测试锁死该契约防回退）：
 * 后端 snake_case 序列化 → 桥接驼峰映射 → API.md 契约。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHubCapabilities } from "./hub-capabilities";

let calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
let respond: (command: string, args?: Record<string, unknown>) => unknown = () => null;

beforeEach(() => {
  calls = [];
  respond = () => null;
  vi.stubGlobal("__TAURI_INTERNALS__", {
    invoke: (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return Promise.resolve(respond(command, args));
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildHubCapabilities", () => {
  it("listSessions：snake_case → 驼峰逐字段映射（跨端契约锚定）", async () => {
    respond = () => [
      {
        id: "s1", title: "会话一", agent_id: "jishu-self", project_path: "C:/p",
        started_at: "2026-11-15T00:00:00Z", last_active: null, message_count: 3,
        total_cost: 0.5, tool_calls: 7,
      },
    ];
    const hub = buildHubCapabilities({ currentSessionId: null, getProjectPath: () => "" });
    const rows = await hub.listSessions();
    expect(rows).toEqual([
      {
        id: "s1", title: "会话一", agentId: "jishu-self", projectPath: "C:/p",
        startedAt: "2026-11-15T00:00:00Z", lastActive: null, messageCount: 3,
        totalCost: 0.5, toolCallsTotal: 7,
      },
    ]);
  });

  it("sessionStats P1：turnCount 按轮次块归并——工具中间轮不计（修前按 assistant 条数=4 虚高）", async () => {
    respond = (command) => {
      if (command === "get_session_messages") {
        return [
          { role: "user", content: [{ type: "text" }] },
          { role: "assistant", content: [{ type: "tool_use", name: "bash" }] },
          { role: "user", content: [{ type: "tool_result" }] },
          { role: "assistant", content: [{ type: "tool_use", name: "bash" }] },
          { role: "user", content: [{ type: "tool_result" }] },
          { role: "assistant", content: [{ type: "text" }] },
          { role: "user", content: [{ type: "text" }] },
          { role: "assistant", content: [{ type: "text" }] },
        ];
      }
      if (command === "usage_session") return { total_cost: 0.1, tool_calls: 2 };
      return null;
    };
    const hub = buildHubCapabilities({
      currentSessionId: "s1",
      projectEncodedName: "C--p",
      getProjectPath: () => "",
    });
    const stats = await hub.sessionStats();
    expect(stats.turnCount).toBe(2); // 两个轮次块（第一块含两次工具调用）
    expect(stats.messageCount).toBe(8);
    expect(stats.toolCalls).toEqual({ bash: 2 });
    expect(stats.totalCost).toBe(0.1);
    expect(stats.toolCallsTotal).toBe(2);
  });

  it("sessionStats P2：usage 无记录（null）→ totalCost/toolCallsTotal 为 null（无记账≠零花）", async () => {
    respond = (command) => (command === "usage_session" ? null : []);
    const hub = buildHubCapabilities({ currentSessionId: null, getProjectPath: () => "" });
    const stats = await hub.sessionStats("s9");
    expect(stats.totalCost).toBeNull();
    expect(stats.toolCallsTotal).toBeNull();
  });

  it("sendMessage P2：项目路径经 getProjectPath 读取器取「调用时刻」值（修 stale currentProject 闭包）", async () => {
    respond = () => ({ session_id: "new-1" });
    let livePath = "C:/old";
    const hub = buildHubCapabilities({ currentSessionId: null, getProjectPath: () => livePath });
    await hub.agent.sendMessage({ message: "hi" });
    livePath = "C:/new"; // 模拟切项目——读取器下次调用取新值
    await hub.agent.sendMessage({ message: "hi again" });
    const sends = calls.filter((c) => c.command === "send_message");
    expect(sends[0]?.args?.projectPath).toBe("C:/old");
    expect(sends[1]?.args?.projectPath).toBe("C:/new");
  });
});
