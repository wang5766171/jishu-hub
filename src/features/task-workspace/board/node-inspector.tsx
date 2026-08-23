/**
 * NodeInspector —— 节点详情面板（自 phase-execution-view.tsx 迁出）。
 *
 * 迁移理由（T7）：旧执行页面退役后，"为节点指定执行智能体"是唯一无处安放的能力。
 * 新形态下它属于**流程编排**语义（run 启动前配置节点执行者），因此挂在
 * FlowBoardOverlay（独立流程画布页）底部，而非会话主区。
 *
 * 能力保留清单：
 * - 指定执行智能体（UpdateNode → agent_assignment_constraint.locked_agent_id）
 * - 「需干预」直达治理面 intervention tab
 * - 节点状态 / 执行者 / 尝试次数展示
 */
import { useTranslation } from "react-i18next";
import type { NodeSessionInfo } from "@/features/task-instance/types";

export interface NodeInspectorProps {
  nodeId: string;
  nodeTitle: string;
  nodeSession: NodeSessionInfo | null;
  snapshot: {
    nodes: Array<{
      node_id: string;
      title: string;
      description: string | null;
      role_requirement?: Record<string, unknown> | null;
      agent_assignment_constraint?: Record<string, unknown> | null;
    }>;
  } | null;
  agents: Array<{ id: string; display_name: string }>;
  agentsLoading: boolean;
  /** 未锁定节点的默认执行者（= TaskInstance.planner_agent_id，规范化后）。 */
  defaultAgentId: string;
  /** run 已启动后禁止改派。 */
  disabled: boolean;
  onAssignAgent: (nodeId: string, agentId: string, roleId: string) => Promise<void>;
}

export function NodeInspector({
  nodeId,
  nodeTitle,
  nodeSession,
  snapshot,
  agents,
  agentsLoading,
  defaultAgentId,
  disabled,
  onAssignAgent,
}: NodeInspectorProps) {
  const { t } = useTranslation();
  const node = snapshot?.nodes.find((n) => n.node_id === nodeId);
  const constraint = node?.agent_assignment_constraint;
  const roleRequirement = node?.role_requirement;
  const lockedAgentId =
    typeof constraint?.locked_agent_id === "string" ? constraint.locked_agent_id : "";
  const roleId = typeof roleRequirement?.role_id === "string" ? roleRequirement.role_id : nodeId;

  /** id → 展示名。用户可见处一律用 display_name，不得暴露内部代号（DEVELOP_READ §7）。 */
  const agentDisplayName = (id: string): string =>
    agents.find((agent) => agent.id === id)?.display_name ?? id;

  // D3：未锁定节点的默认执行者显示为默认 agent 名，而非「自动选择」。
  const defaultOptionLabel = agentsLoading
    ? t("task.execution.agentsLoading", "加载智能体…")
    : t("task.execution.defaultAgent", "{{name}}（默认）", {
        name: agentDisplayName(defaultAgentId),
      });

  return (
    <div className="h-32 shrink-0 border-t border-border bg-background px-3 py-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 text-xs font-medium text-foreground">{nodeTitle}</div>
        <label className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>{t("task.execution.executorAgent", "执行智能体")}</span>
          <select
            value={lockedAgentId}
            disabled={disabled || agents.length === 0}
            onChange={(event) => {
              const value = event.target.value;
              if (value) onAssignAgent(nodeId, value, roleId).catch(console.error);
            }}
            className="h-6 rounded border border-border bg-background px-2 text-[11px] text-foreground disabled:opacity-60"
          >
            <option value="">{defaultOptionLabel}</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.display_name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {/* 加载中与加载失败此前 UI 完全同形（都只是置灰 select），补可辨识提示。 */}
      {agents.length === 0 && (
        <div className="mt-1 text-[10px] text-muted-foreground">
          {agentsLoading
            ? t("task.execution.agentsLoading", "加载智能体…")
            : t("task.execution.agentsUnavailable", "智能体列表不可用，请检查智能体配置")}
        </div>
      )}
      {node?.description && (
        <div className="mt-1 text-[11px] text-muted-foreground">{node.description}</div>
      )}
      <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
        {nodeSession && (
          <>
            <span>
              {t("task.execution.nodeStatus", "状态")}：
              {t(`task.nodeStatus.${nodeSession.status}`, nodeSession.status)}
            </span>
            {/* A7：不得直出内部代号（如 jishu-self）。 */}
            {nodeSession.agent_id && (
              <span>
                {t("task.execution.executorAgent", "执行智能体")}：
                {agentDisplayName(nodeSession.agent_id)}
              </span>
            )}
            <span>
              {t("task.execution.attempt", "尝试")}：{nodeSession.attempt_number}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
