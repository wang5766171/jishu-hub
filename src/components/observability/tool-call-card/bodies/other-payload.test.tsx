// 需求4 F3 契约锚定（2026-11-21 用户裁决做）：tool-output 挂载渲染器收到的
// payload 形状——{ kind, toolName, output, input?, details? }。锚定测试防
// 文档（API.md「挂载与 payload 契约」节）与实现漂移；mock 认领链以隔离
// 组合引擎（mock 不作契约证据——契约字段断言在本测试内自证）。
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

let lastPayload: Record<string, unknown> | undefined;
vi.mock("@/features/session-kernel/plugins/mounts/use-block-renderers", () => ({
  matchToolResultRenderer: (name: string) =>
    name === "web_fetch"
      ? {
          component: function Probe({ payload }: { payload: Record<string, unknown> }) {
            lastPayload = payload;
            return <div data-testid="probe" />;
          },
          options: {},
        }
      : null,
}));

import { OtherBody } from "./OtherBody";

describe("8b tool-output 挂载 payload 契约（需求4 F3）", () => {
  it("认领工具：payload 含 kind/toolName/output，input 与 details 存在时透传", () => {
    render(
      <OtherBody
        input={{ url: "https://example.com" }}
        output="正文文本"
        details={{ title: "示例页", published: "2026-01-01" }}
        kind="web"
        toolName="web_fetch"
      />,
    );
    expect(screen.getByTestId("probe")).toBeTruthy();
    expect(lastPayload).toMatchObject({
      kind: "tool-result",
      toolName: "web_fetch",
      output: "正文文本",
      input: { url: "https://example.com" },
      details: { title: "示例页", published: "2026-01-01" },
    });
  });

  it("无 input/details 的工具：payload 不携带这两个键（undefined 不出现）", () => {
    lastPayload = undefined;
    render(<OtherBody input={{}} output="ok" kind="other" toolName="web_fetch" />);
    expect(lastPayload).toBeDefined();
    expect(lastPayload).not.toHaveProperty("input");
    expect(lastPayload).not.toHaveProperty("details");
    expect(lastPayload).toMatchObject({ kind: "tool-result", toolName: "web_fetch", output: "ok" });
  });
});
