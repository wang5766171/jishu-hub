import { describe, expect, it } from "vitest";
import { resolveToolKind, classifyToolName } from "./types";
import { isInteractionToolName } from "@/lib/interaction-tools";

describe("resolveToolKind（v0.8.0 需求2 Phase 1）", () => {
  it("优先用事件携带的渲染意图", () => {
    expect(resolveToolKind("whatever_dialect", { kind: "file_read" })).toBe("file_read");
    expect(resolveToolKind("bash", { kind: "search" })).toBe("search");
  });

  it("view 缺失回退名称分类（历史数据 fallback）", () => {
    expect(resolveToolKind("bash")).toBe("shell_exec");
    expect(resolveToolKind("Write")).toBe("file_write");
    expect(resolveToolKind("unknown_tool")).toBe(classifyToolName("unknown_tool"));
  });

  it("kind 无效值不透传（类型防线）", () => {
    // view.kind 在运行时来自 wire；非法值走 fallback 而非渲染未知卡片
    expect(resolveToolKind("bash", { kind: "not_a_kind" as never })).toBe("shell_exec");
  });
});

/** v0.8.0 需求2 Phase 1：交互工具名单同步锁定——权威名单在 Rust
 * tool_view.rs 的 is_interaction_tool（8 项并集），本用例硬编码同款名单，
 * 后端增删时此测试失败提醒同步前端 interaction-tools.ts。 */
describe("交互工具名单与后端 tool_view.rs 同步锁定", () => {
  const BACKEND_AUTHORITATIVE_LIST = [
    "request_user_input",
    "ask_user",
    "ask_user_input",
    "askuserquestion",
    "ask_user_question",
    "ask_question",
    "ask_choice",
    "choice_question",
  ];

  it("前端名单与后端权威名单一致", () => {
    for (const name of BACKEND_AUTHORITATIVE_LIST) {
      expect(isInteractionToolName(name), name).toBe(true);
    }
    // 规范化形态也一致（后端 rsplit ['/',':'] + '-'→'_'）
    expect(isInteractionToolName("mcp/server/ask-user")).toBe(true);
    expect(isInteractionToolName("tools:ask_question")).toBe(true);
    // 非交互
    expect(isInteractionToolName("bash")).toBe(false);
    expect(isInteractionToolName("read")).toBe(false);
  });
});
