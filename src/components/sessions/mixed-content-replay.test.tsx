import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Message } from "@/types";
import { MessageView } from "@/components/sessions/message-view";
import { FileViewerProvider } from "@/components/file-viewer";

/** 需求4 测试期：流式提交的混装 assistant 消息（text+tool_use+tool_result 混排）
 *  经回放渲染——全部工具卡应在（用户实测 08:39：最后的打包卡丢失）。 */
describe("混装消息的回放渲染完整性", () => {
  it("三个工具（含最终 npm run build）全部渲染为卡", () => {
    const messages: Message[] = [
      { role: "user", timestamp: null, content: [{ type: "text", text: "工具卡问题" }] },
      {
        role: "assistant",
        timestamp: null,
        content: [
          { type: "thinking", thinking: "分析" },
          { type: "text", text: "先识图确认" },
          { type: "tool_use", id: "call_e33", name: "bash", input: { command: "node -e identify" }, view: { kind: "shell_exec" } },
          { type: "tool_result", tool_use_id: "call_e33", content: "识别结果" },
          { type: "tool_use", id: "call_702", name: "bash", input: { command: "sed -n 108,145p" }, view: { kind: "shell_exec" } },
          { type: "tool_result", tool_use_id: "call_702", content: "代码" },
          { type: "tool_use", id: "call_b77", name: "bash", input: { command: "npm run build" }, view: { kind: "shell_exec" } },
          { type: "tool_result", tool_use_id: "call_b77", content: "built 57MB" },
          { type: "text", text: "已修复并出包" },
        ],
      },
    ];
    const { container } = render(<FileViewerProvider><MessageView messages={messages} flat /></FileViewerProvider>);
    // 三段式：已工作折叠区应含全部 3 个工具
    const workBtn = screen.getByRole("button", { name: /已工作/ });
    expect(workBtn).toBeTruthy();
    fireEvent.click(workBtn);
    // 工具组默认收起——再点组展开（三层：已工作→组→卡）。
    fireEvent.click(screen.getByRole("button", { name: /执行 3 条命令/ }));
    // 展开后每张卡收起态标题含命令
    expect(container.textContent).toContain("node -e identify");
    expect(container.textContent).toContain("sed -n 108,145p");
    expect(container.textContent, "打包命令卡必须在").toContain("npm run build");
  });

  it("原生多消息结构（assistant/toolResult 交替）同样三卡齐全", () => {
    const messages: Message[] = [
      { role: "user", timestamp: null, content: [{ type: "text", text: "q" }] },
      {
        role: "assistant",
        timestamp: null,
        content: [
          { type: "text", text: "开始" },
          { type: "tool_use", id: "call_a", name: "bash", input: { command: "cmd-a" }, view: { kind: "shell_exec" } },
        ],
      },
      { role: "user", timestamp: null, content: [{ type: "tool_result", tool_use_id: "call_a", content: "ra" }] },
      {
        role: "assistant",
        timestamp: null,
        content: [{ type: "tool_use", id: "call_b", name: "bash", input: { command: "npm run build" }, view: { kind: "shell_exec" } }],
      },
      { role: "user", timestamp: null, content: [{ type: "tool_result", tool_use_id: "call_b", content: "rb" }] },
      { role: "assistant", timestamp: null, content: [{ type: "text", text: "完成" }] },
    ];
    const { container } = render(<FileViewerProvider><MessageView messages={messages} flat /></FileViewerProvider>);
    fireEvent.click(screen.getByRole("button", { name: /已工作/ }));
    fireEvent.click(screen.getByRole("button", { name: /执行 2 条命令/ }));
    expect(container.textContent).toContain("cmd-a");
    expect(container.textContent, "打包命令卡必须在").toContain("npm run build");
  });
});
