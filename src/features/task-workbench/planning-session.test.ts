import { describe, expect, it } from "vitest";
import {
  buildPlanningInstruction,
  derivePlanningTitle,
  type PlanningChatMessage,
} from "./planning-session";

describe("planning session helpers", () => {
  it("turns a planning conversation into a readable planner instruction", () => {
    const messages: PlanningChatMessage[] = [
      { id: "m1", role: "user", content: "先梳理本地录音软件的 MVP" },
      { id: "m2", role: "assistant", content: "可以，我会先拆出需求、架构、验证。" },
      { id: "m3", role: "user", content: "补充：必须有人为验收节点" },
    ];

    expect(buildPlanningInstruction(messages)).toBe(
      [
        "请根据以下任务规划对话生成可审阅的任务流程图。",
        "",
        "用户: 先梳理本地录音软件的 MVP",
        "Jishu Agent: 可以，我会先拆出需求、架构、验证。",
        "用户: 补充：必须有人为验收节点",
      ].join("\n"),
    );
  });

  it("derives a concise fallback title from the first user message", () => {
    expect(
      derivePlanningTitle("  ", [
        {
          id: "m1",
          role: "user",
          content: "规划一个灵感记录软件，要求支持本地优先、MVP、验收与上线检查",
        },
      ]),
    ).toBe("规划一个灵感记录软件，要求支持本地优先、MVP、验收与上线检查");

    expect(
      derivePlanningTitle("自定义标题", [
        { id: "m1", role: "user", content: "这条不会覆盖标题" },
      ]),
    ).toBe("自定义标题");
  });
});
