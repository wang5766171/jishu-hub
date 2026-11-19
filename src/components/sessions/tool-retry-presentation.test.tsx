import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Message } from "@/types";
import { MessageView } from "@/components/sessions/message-view";
import { FileViewerProvider } from "@/components/file-viewer";

/** v0.9.8 需求9-①：回放侧「同名后置成功」启发式——失败调用之后存在同名
 * 工具的成功结果（pi auto_retry 重做 / 模型自行重试成功），失败卡按
 * 「已重试成功」呈现（用户裁决：重试成功后算作成功，错误输出保留可展开）。 */
describe("重试成功最终呈现（回放启发式）", () => {
  const openCards = (messages: Message[]) => {
    const { container } = render(
      <FileViewerProvider><MessageView messages={messages} flat /></FileViewerProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /已工作/ }));
    const groupBtn = screen.queryByRole("button", { name: /执行 \d+ 条命令/ });
    if (groupBtn) fireEvent.click(groupBtn);
    return container;
  };

  it("U1b: 失败卡后有同名成功卡——失败卡显示成功态+「已重试」徽标，不再红框", () => {
    const messages: Message[] = [
      { role: "user", timestamp: null, content: [{ type: "text", text: "重跑" }] },
      {
        role: "assistant",
        timestamp: null,
        content: [
          { type: "tool_use", id: "call-fail", name: "bash", input: { command: "npm test" }, view: { kind: "shell_exec" } },
          { type: "tool_result", tool_use_id: "call-fail", content: "exit 1 timeout", is_error: true },
          { type: "tool_use", id: "call-ok", name: "bash", input: { command: "npm test" }, view: { kind: "shell_exec" } },
          { type: "tool_result", tool_use_id: "call-ok", content: "3 passed" },
          { type: "text", text: "重试成功" },
        ],
      },
    ];
    const container = openCards(messages);
    expect(container.textContent).toContain("已重试");
    // 失败卡被翻转后不应再有 Error 徽标（同名对内）
    expect(container.textContent).not.toContain("出错");
  });

  it("无后置同名成功——真失败保持出错态（不被误翻）", () => {
    const messages: Message[] = [
      { role: "user", timestamp: null, content: [{ type: "text", text: "跑" }] },
      {
        role: "assistant",
        timestamp: null,
        content: [
          { type: "tool_use", id: "call-f2", name: "bash", input: { command: "bad-cmd" }, view: { kind: "shell_exec" } },
          { type: "tool_result", tool_use_id: "call-f2", content: "not found", is_error: true },
        ],
      },
    ];
    const container = openCards(messages);
    expect(container.textContent).toContain("出错");
    expect(container.textContent).not.toContain("已重试");
  });
});
