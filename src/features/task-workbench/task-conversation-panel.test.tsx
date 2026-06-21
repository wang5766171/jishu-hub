import i18n from "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskConversationPanel } from "./task-conversation-panel";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const detail = {
  summary: {
    graph_id: "graph-1",
    title: "权限管理系统",
    original_goal: "设计前后端分类的权限管理系统",
    project_root: "D:\\project",
    owner_agent_id: "jishu-self",
    run_id: "run-1",
    phase: "executing",
    current_node_id: "node-1",
    current_node_title: "设计权限模型",
    completed_nodes: 1,
    total_nodes: 3,
    pending_interaction_count: 1,
    updated_at: 1,
  },
  entries: [
    {
      entry_id: "entry-1",
      sequence: 1,
      occurred_at: 1,
      phase: "executing",
      node_id: "node-1",
      actor: "jishu-self",
      kind: "node_progress",
      payload: { message: "正在梳理组织机构与角色关系" },
    },
  ],
  pending_interactions: [
    {
      request_id: "request-1",
      node_id: "node-1",
      prompt: "请选择权限继承方式",
      options: [
        {
          option_id: "a",
          label: "方案 A",
          description: "组织权限向下继承",
        },
        {
          option_id: "b",
          label: "方案 B",
          description: "仅使用显式授权",
        },
      ],
      allow_multiple: false,
      allow_custom_text: true,
      required: true,
    },
  ],
};

describe("task conversation panel", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "orchestrator_get_task_conversation") {
        return Promise.resolve(detail);
      }
      if (command === "orchestrator_submit_task_interaction") {
        return Promise.resolve({});
      }
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });
  });

  it("shows task context and submits a node interaction", async () => {
    const { unmount } = render(
      <TaskConversationPanel
        graphId="graph-1"
        selectedNodeId="node-1"
        onClose={vi.fn()}
      />,
    );

    expect(
      await screen.findByText("设计前后端分类的权限管理系统"),
    ).toBeInTheDocument();
    expect(screen.getByText("正在梳理组织机构与角色关系")).toBeInTheDocument();
    expect(screen.getByText("请选择权限继承方式")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /方案 A/ }));
    fireEvent.click(
      screen.getByRole("button", {
        name: i18n.t("sessions.interactionSubmit"),
      }),
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "orchestrator_submit_task_interaction",
        {
          requestId: "request-1",
          submission: {
            selected_option_ids: ["a"],
            custom_text: null,
          },
        },
      );
    });
    unmount();
  });

  it("sends task messages through the shared chat input adapter", async () => {
    const detailWithoutInteraction = {
      ...detail,
      pending_interactions: [],
    };
    invokeMock.mockImplementation((command: string) => {
      if (command === "orchestrator_get_task_conversation") {
        return Promise.resolve(detailWithoutInteraction);
      }
      if (command === "orchestrator_submit_task_message") {
        return Promise.resolve({
          ...detailWithoutInteraction,
          entries: [
            ...detailWithoutInteraction.entries,
            {
              entry_id: "entry-user",
              sequence: 2,
              occurred_at: 2,
              phase: "executing",
              node_id: "node-1",
              actor: "user",
              kind: "user_message",
              payload: { text: "请优先补充权限边界说明" },
            },
          ],
        });
      }
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    const { unmount } = render(
      <TaskConversationPanel
        graphId="graph-1"
        selectedNodeId="node-1"
        onClose={vi.fn()}
      />,
    );

    const input = await screen.findByPlaceholderText(i18n.t("sessions.chatPlaceholder"));
    fireEvent.change(input, {
      target: { value: "请优先补充权限边界说明" },
    });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("orchestrator_submit_task_message", {
        graphId: "graph-1",
        nodeId: "node-1",
        message: "请优先补充权限边界说明",
      });
      expect(screen.getByText("请优先补充权限边界说明")).toBeInTheDocument();
    });
    unmount();
  });
});
