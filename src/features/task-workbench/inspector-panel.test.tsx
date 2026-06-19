import i18n from "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InspectorPanel } from "./inspector-panel";
import type { ApprovalRequest, ArtifactRef, GraphNode, NodeRun, TaskEvent } from "./use-task-graph";

const node: GraphNode = {
  node_id: "node_1",
  parent_id: null,
  title: "实现 MVP",
  description: "完成核心功能",
  node_kind: "executable",
  input_contract: { description: "需求" },
  output_contract: { description: "MVP" },
  role_requirement: null,
  capability_requirements: [],
  agent_assignment_constraint: null,
  policy: {},
  metadata: {},
  executable_payload: null,
  loop_config: null,
  approval_gate_config: null,
};

const failedRun: NodeRun = {
  node_run_id: "nr_1",
  run_id: "run_1",
  node_id: "node_1",
  status: "failed",
  revision_id: "rev_1",
  started_at: 1,
  finished_at: 2,
  attempt_count: 2,
  error: "命令失败",
};

const approval: ApprovalRequest = {
  approval_id: "approval_1",
  run_id: "run_1",
  node_run_id: "nr_1",
  description: "允许写入文件",
  risk_level: "medium",
  scope: ["write"],
  resolved: false,
  approved: null,
  created_at: 1,
};

const artifact: ArtifactRef = {
  artifact_id: "artifact_1",
  run_id: "run_1",
  node_run_id: "nr_1",
  attempt_id: "attempt_1",
  name: "验收报告.md",
  artifact_type: "markdown",
  hash: "sha256:artifact",
  sensitivity: "internal",
  created_at: 1,
  metadata: {},
};

const event: TaskEvent = {
  event_id: "event_1",
  run_id: "run_1",
  run_seq: 3,
  event_type: "node_failed",
  occurred_at: 1,
  actor: "Jishu Agent",
  payload: { node_id: "node_1", node_run_id: "nr_1" },
};

describe("unified inspector panel", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  it("shows node run intervention controls and approval actions", async () => {
    const chooseRecovery = vi.fn().mockResolvedValue(undefined);
    const resolveApproval = vi.fn().mockResolvedValue(undefined);

    render(
      <InspectorPanel
        node={node}
        nodeRun={failedRun}
        events={[event]}
        approvals={[approval]}
        artifacts={[artifact]}
        onChooseRecovery={chooseRecovery}
        onResolveApproval={resolveApproval}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: i18n.t("tasks.workbench.unifiedInspector.tabs.run") }));

    expect(await screen.findByText(i18n.t("tasks.workbench.status.failed"))).toBeInTheDocument();
    expect(screen.getByText("命令失败")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("tasks.workbench.intervention.retryNow") }));
    await waitFor(() =>
      expect(chooseRecovery).toHaveBeenCalledWith(
        "nr_1",
        "retry_now",
        expect.stringContaining("实现 MVP"),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: i18n.t("tasks.workbench.approve") }));
    await waitFor(() =>
      expect(resolveApproval).toHaveBeenCalledWith("approval_1", true),
    );
  });

  it("shows node conversation events and artifacts", async () => {
    render(
      <InspectorPanel
        node={node}
        nodeRun={failedRun}
        events={[event]}
        artifacts={[artifact]}
        approvals={[]}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: i18n.t("tasks.workbench.unifiedInspector.tabs.conversation") }));
    expect(await screen.findByText("node_failed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: i18n.t("tasks.workbench.unifiedInspector.tabs.artifacts") }));
    expect(await screen.findByText("验收报告.md")).toBeInTheDocument();
    expect(screen.getByText("sha256:artifact")).toBeInTheDocument();
  });
});
