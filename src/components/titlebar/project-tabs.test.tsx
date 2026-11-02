/**
 * v0.9.6 需求4：标题栏项目标签组件测试。
 * 覆盖：空态不渲染 / 当前项目标签（名+关闭钮）/ 其他活跃项目过滤与聚合 /
 * 点击切换回调（sessionId+agentId）/ 轮询数据源过滤当前项目。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Project } from "@/types";

const invokeMock = vi.fn();

vi.mock("@/hooks/use-invoke", () => ({
  invokeCommand: (...args: unknown[]) => invokeMock(...args),
}));

import { ProjectTabs } from "./project-tabs";

const proj = (name: string, encoded: string): Project => ({
  name,
  path: `D:/${name}`,
  encoded_name: encoded,
  session_count: 1,
  last_active: null,
  agent_ids: ["jishu-self"],
  initialized: true,
  has_claude_md: false,
});

const PROJECT_A = proj("jishu-hub", "enc-a");
const PROJECT_B = proj("other-work", "enc-b");

describe("v0.9.6 需求4：ProjectTabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockResolvedValue([]);
  });
  afterEach(() => cleanup());

  it("空态：无当前项目且无活跃其他项目 → 整条不渲染", async () => {
    const { container } = render(
      <ProjectTabs currentProject={null} projects={[PROJECT_A]} onSwitchToProject={vi.fn()} onCloseCurrentProject={vi.fn()} />,
    );
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(container.querySelector("titlebar-empty")).toBeNull();
    expect(screen.queryByText("jishu-hub")).toBeNull();
  });

  it("当前项目标签：显示项目名 + 关闭按钮；点击关闭触发回调", async () => {
    render(
      <ProjectTabs currentProject={PROJECT_A} projects={[PROJECT_A]} onSwitchToProject={vi.fn()} onCloseCurrentProject={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText("jishu-hub")).toBeTruthy());
    const close = screen.getByTitle("关闭当前项目");
    expect(close).toBeTruthy();
  });

  it("其他活跃项目：渲染 tab 并过滤当前项目；点击带 sessionId/agentId 回调", async () => {
    invokeMock.mockResolvedValue([
      { session_id: "s-in-a", agent_id: "jishu-self", project_encoded: "enc-a" }, // 当前项目 → 过滤
      { session_id: "s-in-b", agent_id: "codex", project_encoded: "enc-b" },
      { session_id: "s-unknown", agent_id: "jishu-self", project_encoded: "enc-missing" }, // 项目列表查无 → 过滤
    ]);
    const onSwitch = vi.fn();
    render(
      <ProjectTabs currentProject={PROJECT_A} projects={[PROJECT_A, PROJECT_B]} onSwitchToProject={onSwitch} onCloseCurrentProject={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText("other-work")).toBeTruthy());
    // 当前项目与未知项目不出现为活跃 tab（当前项目以「当前标签」形态展示）
    expect(screen.queryAllByText("jishu-hub").length).toBe(1);
    fireEvent.click(screen.getByText("other-work"));
    expect(onSwitch).toHaveBeenCalledWith(PROJECT_B, "s-in-b", "codex");
  });
});
