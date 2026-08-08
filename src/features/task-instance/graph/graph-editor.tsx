import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { computeLayout, LAYOUT_NODE_WIDTH, type LayoutGraph, type LayoutResult } from "./layout";
import { loadViewport, saveViewport } from "./viewport-storage";
import { loadNodePositions, saveNodePositions } from "./node-positions";
import { cn } from "@/lib/utils";
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  type Node as ReactFlowNode,
  type Edge as ReactFlowEdge,
  type Connection,
  Position,
  MarkerType,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { GraphCommand, GraphSnapshot, NodeRun, NodeRunStatus, RevisionDiff } from "./use-task-graph";

function nodeAppearance(status?: NodeRunStatus) {
  switch (status) {
    case "ready":
    case "blocked":
      return {
        borderColor: "var(--task-node-border)",
        background: "var(--task-node-bg)",
        color: "var(--task-node-fg)",
        boxShadow: "var(--task-node-shadow)",
      };
    case "leased":
    case "running":
    case "retry_wait":
    case "repairing":
      return {
        borderColor: "var(--tool-running)",
        background: "var(--task-node-running-bg)",
        color: "var(--task-node-fg)",
        boxShadow: "0 0 0 3px color-mix(in srgb, var(--tool-running) 18%, transparent), var(--task-node-shadow)",
      };
    case "succeeded":
      return {
        borderColor: "var(--tool-success)",
        background: "var(--task-node-success-bg)",
        color: "var(--task-node-fg)",
        boxShadow: "var(--task-node-shadow)",
      };
    case "failed":
      return {
        borderColor: "var(--tool-error)",
        background: "var(--task-node-error-bg)",
        color: "var(--task-node-fg)",
        boxShadow: "var(--task-node-shadow)",
      };
    case "cancelled":
    case "skipped":
    case "superseded":
      return {
        borderColor: "var(--color-muted-foreground)",
        background: "var(--task-node-muted-bg)",
        color: "var(--color-muted-foreground)",
        boxShadow: "none",
      };
    case "awaiting_approval":
      return {
        borderColor: "hsl(38 92% 50%)",
        background: "var(--task-node-approval-bg)",
        color: "var(--task-node-fg)",
        boxShadow: "0 0 0 3px color-mix(in srgb, hsl(38 92% 50%) 20%, transparent), var(--task-node-shadow)",
      };
    default:
      return {
        borderColor: "var(--task-node-border)",
        background: "var(--task-node-bg)",
        color: "var(--task-node-fg)",
        boxShadow: "var(--task-node-shadow)",
      };
  }
}

function currentFlowColorMode(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "light";
}

/// §12.3: node state must use text + color + shape. `nodeAppearance` covers
/// color (status); this adds shape variation by node kind (border radius/style/
/// width) so goal/group/executable/loop/gate are distinguishable beyond color.
function nodeKindStyle(nodeKind: string): {
  borderStyle: string;
  borderRadius: number;
  borderWidth: number;
} {
  switch (nodeKind) {
    case "goal":
      return { borderStyle: "solid", borderRadius: 28, borderWidth: 3 };
    case "group":
      return { borderStyle: "double", borderRadius: 12, borderWidth: 5 };
    case "control_loop":
    case "loop":
      return { borderStyle: "dashed", borderRadius: 18, borderWidth: 3 };
    case "control_approval_gate":
    case "approval_gate":
      return { borderStyle: "dotted", borderRadius: 8, borderWidth: 3 };
    default:
      return { borderStyle: "solid", borderRadius: 5, borderWidth: 2 };
  }
}

/// B4 冻结 gating（设计 §10.6 / 后端 is_frozen()）：与后端 NodeRunStatus::is_frozen 同口径——
/// 已租赁/运行中/待审批/已完成/失败/自愈中的节点不可经主编辑路径改动。UI 对这些节点置灰 +
/// 禁用编辑入口（后端 apply_commands 的 A8 校验兜底）。
const FROZEN_NODE_RUN_STATUSES: readonly NodeRunStatus[] = [
  "leased",
  "running",
  "awaiting_approval",
  "succeeded",
  "failed",
  "repairing",
];

// F2-1：常量提升，避免每次渲染新建数组 prop 击穿 ReactFlow 内部 effect。
const DELETE_KEY_CODES = ["Backspace", "Delete"];

/**
 * F2-2（设计 §5 批 F2）：目标节点描述——label/style 的 useMemo 派生物。
 * 位置不在其中：位置以 ReactFlow 当前 state 为单一来源（F2-3，修 B-3）。
 */
interface DesiredNode {
  id: string;
  label: string;
  style: CSSProperties;
}

/** F2-2：目标边描述（语义字段，diff 比较用；视觉属性由 kind 派生）。 */
interface DesiredEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  label: string;
}

/// F2-2 diff 用：节点 style 浅比较（构造方固定 8 个字段，值均为 primitive）。
function nodeStyleEqual(a: CSSProperties | undefined, b: CSSProperties): boolean {
  if (!a) return false;
  const aKeys = Object.keys(a) as Array<keyof CSSProperties>;
  const bKeys = Object.keys(b) as Array<keyof CSSProperties>;
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

interface GraphEditorProps {
  snapshot: GraphSnapshot | null;
  graphId?: string | null;
  currentRevisionId?: string | null;
  selectedNodeId?: string | null;
  onNodeSelect?: (nodeId: string | null) => void;
  applyCommands?: (commands: GraphCommand[]) => Promise<RevisionDiff | null>;
  /** S6 前端 DAG 预校验（设计 §12）：提交前 dry-run，返回告警串数组（空=合法）。 */
  validateCommands?: (commands: GraphCommand[]) => Promise<string[]>;
  /** 取两 revision 间 Diff（编排反馈面 / Revision 历史对比）。 */
  getDiff?: (fromRevisionId: string, toRevisionId: string) => Promise<RevisionDiff | null>;
  /** 最近一次 apply_commands 的 Diff（编排反馈面展示「本次改了什么」）。 */
  lastDiff?: RevisionDiff | null;
  activeRunId?: string | null;
  nodeRuns?: Record<string, NodeRun>;
  startRun?: () => Promise<void>;
  runStatus?: string | null;
  pauseRun?: () => Promise<void>;
  resumeRun?: () => Promise<void>;
  cancelRun?: () => Promise<void>;
  generateProposal?: () => Promise<unknown>;
  planning?: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  undo?: () => Promise<void>;
  redo?: () => Promise<void>;
  applyDraftToRun?: () => Promise<unknown>;
  canApplyDraftToRun?: boolean;
  /**
   * 完成态只读（设计 §11）：run 已 completed 时画布不可增删改节点/边、不可 undo/redo。
   * 后端 `apply_commands` 同步有终态 run 守卫兜底，此处是 UX 层（隐藏/禁用变更入口）。
   */
  readOnly?: boolean;
}

/** 添加智能体节点向导（独立组件：表单状态内聚，输入不触发 GraphEditor/ReactFlow 重渲染）。 */
function DispatchWizardForm({
  goalNodeId,
  phaseNodes,
  onSubmit,
  onCancel,
}: {
  goalNodeId: string | null;
  phaseNodes: Array<{ node_id: string; title: string }>;
  onSubmit: (command: GraphCommand) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [intent, setIntent] = useState<"implement" | "research" | "verify">("implement");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [acceptance, setAcceptance] = useState("");
  // F4：审批策略选择（默认 on_high_risk；后端 ApprovalPolicy = Never/Once/Always/OnHighRisk）
  const [approvalPolicy, setApprovalPolicy] = useState<"never" | "on_high_risk" | "always">("on_high_risk");
  // F5：所属阶段（parent_id）；不选 = 直接挂 goal（与旧逻辑兼容）
  const [parentPhaseId, setParentPhaseId] = useState<string>("");

  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-[var(--task-canvas-overlay-bg)] p-6 backdrop-blur-sm">
      <form
        className="w-full max-w-lg rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          if (step < 3) {
            setStep((current) => (current === 1 ? 2 : 3));
            return;
          }
          if (!title.trim() || !prompt.trim() || !acceptance.trim()) return;
          const fullPrompt = [
            `${t("tasks.workbench.nodeWizard.intent")}: ${t(`tasks.workbench.nodeWizard.intents.${intent}`)}`,
            prompt.trim(),
            `${t("tasks.workbench.nodeWizard.acceptance")}: ${acceptance.trim()}`,
          ].join("\n\n");
          // F5：选择了阶段 → parent_id 为阶段 id；否则回退到 goal（兼容旧逻辑）
          const effectiveParentId = parentPhaseId || goalNodeId;
          onSubmit({
            op: "add_node",
            command_id: `cmd_${crypto.randomUUID()}`,
            node: {
              node_id: `node_${crypto.randomUUID()}`,
              parent_id: effectiveParentId,
              title: title.trim(),
              description: prompt.trim(),
              node_kind: "executable",
              input_contract: { description: null, artifacts: [], schema: null },
              output_contract: { description: acceptance.trim(), artifacts: [], schema: null },
              role_requirement: {
                role_id: "implementer",
                responsibility: title.trim(),
                required_capabilities: [],
                preferred_capabilities: [],
              },
              capability_requirements: [],
              agent_assignment_constraint: null,
              // F4：透出审批策略选择；此前硬编码 on_high_risk 导致每个写权限节点必审批。
              policy: {
                approval_policy: approvalPolicy,
                permission_scope: {
                  can_read_files: true,
                  can_write_files: true,
                  can_run_commands: false,
                  can_access_network: false,
                  can_deploy: false,
                },
              },
              metadata: {
                intent,
              },
              executable_payload: {
                type: "dispatch",
                role_id: "implementer",
                prompt: fullPrompt,
                project: null,
                session: null,
              },
              loop_config: null,
              approval_gate_config: null,
            },
          });
        }}
      >
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
          {t("tasks.workbench.nodeWizard.step", { current: step, total: 3 })}
        </div>
        <h3 className="mt-2 text-xl font-semibold text-foreground">
          {t("tasks.workbench.nodeWizard.title")}
        </h3>
        {step === 1 && (
          <div className="mt-5 grid gap-2">
            {(["implement", "research", "verify"] as const).map((i) => (
              <button
                key={i}
                type="button"
                className={cn(
                  "rounded-lg border px-4 py-3 text-left text-sm transition",
                  intent === i
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border bg-card text-card-foreground hover:bg-accent hover:text-accent-foreground",
                )}
                onClick={() => setIntent(i)}
              >
                {t(`tasks.workbench.nodeWizard.intents.${i}`)}
              </button>
            ))}
          </div>
        )}
        {step === 2 && (
          <>
            <label className="mt-5 block text-xs font-medium text-muted-foreground">
              {t("tasks.workbench.stepTitle")}
              <input
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
              />
            </label>
            <label className="mt-4 block text-xs font-medium text-muted-foreground">
              {t("tasks.workbench.stepPrompt")}
              <textarea
                rows={5}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                className="mt-2 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
              />
            </label>
            <label className="mt-4 block text-xs font-medium text-muted-foreground">
              {t("tasks.workbench.nodeWizard.acceptance")}
              <textarea
                rows={3}
                value={acceptance}
                onChange={(event) => setAcceptance(event.target.value)}
                className="mt-2 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
              />
            </label>
            {/* F4：审批策略选择 */}
            <label className="mt-4 block text-xs font-medium text-muted-foreground">
              {t("tasks.workbench.nodeWizard.approvalPolicy")}
              <select
                value={approvalPolicy}
                onChange={(event) => setApprovalPolicy(event.target.value as typeof approvalPolicy)}
                className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
              >
                {(["never", "on_high_risk", "always"] as const).map((p) => (
                  <option key={p} value={p}>
                    {t(`tasks.workbench.nodeWizard.approvalPolicies.${p}`)}
                  </option>
                ))}
              </select>
            </label>
            {approvalPolicy === "never" && (
              <p className="mt-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
                {t("tasks.workbench.nodeWizard.approvalPolicyHint")}
              </p>
            )}
            {/* F5：所属阶段 */}
            {phaseNodes.length > 0 && (
              <label className="mt-4 block text-xs font-medium text-muted-foreground">
                {t("tasks.workbench.nodeWizard.parentPhase")}
                <select
                  value={parentPhaseId}
                  onChange={(event) => setParentPhaseId(event.target.value)}
                  className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                >
                  <option value="">{t("tasks.workbench.nodeWizard.parentPhaseNone")}</option>
                  {phaseNodes.map((phase) => (
                    <option key={phase.node_id} value={phase.node_id}>
                      {phase.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}
        {step === 3 && (
          <div className="mt-5 space-y-3 rounded-lg border border-border bg-muted/50 p-4 text-sm text-foreground">
            <div>
              <span className="text-muted-foreground">{t("tasks.workbench.nodeWizard.intent")}: </span>
              {t(`tasks.workbench.nodeWizard.intents.${intent}`)}
            </div>
            <div>
              <span className="text-muted-foreground">{t("tasks.workbench.stepTitle")}: </span>
              {title || "-"}
            </div>
            <div>
              <span className="text-muted-foreground">{t("tasks.workbench.nodeWizard.acceptance")}: </span>
              {acceptance || "-"}
            </div>
            <div>
              <span className="text-muted-foreground">{t("tasks.workbench.nodeWizard.approvalPolicy")}: </span>
              {t(`tasks.workbench.nodeWizard.approvalPolicies.${approvalPolicy}`)}
            </div>
            <div>
              <span className="text-muted-foreground">{t("tasks.workbench.nodeWizard.parentPhase")}: </span>
              {parentPhaseId
                ? phaseNodes.find((p) => p.node_id === parentPhaseId)?.title ?? parentPhaseId
                : t("tasks.workbench.nodeWizard.parentPhaseNone")}
            </div>
          </div>
        )}
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          {t("tasks.workbench.connectHint")}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-border px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            onClick={onCancel}
          >
            {t("common.cancel")}
          </button>
          {step > 1 && (
            <button
              type="button"
              className="rounded border border-border px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              onClick={() => setStep((current) => (current === 3 ? 2 : 1))}
            >
              {t("tasks.workbench.nodeWizard.back")}
            </button>
          )}
          <button
            type="submit"
            disabled={
              step === 2 &&
              (!title.trim() || !prompt.trim() || !acceptance.trim())
            }
            className="rounded bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            {step === 3
              ? t("tasks.workbench.createStep")
              : t("tasks.workbench.nodeWizard.next")}
          </button>
        </div>
      </form>
    </div>
  );
}

function GraphEditorInner({
  snapshot,
  graphId,
  currentRevisionId,
  selectedNodeId,
  onNodeSelect,
  applyCommands,
  validateCommands,
  lastDiff,
  activeRunId,
  nodeRuns,
  startRun,
  runStatus,
  pauseRun,
  resumeRun,
  cancelRun,
  generateProposal,
  planning,
  canUndo,
  canRedo,
  undo,
  redo,
  applyDraftToRun,
  canApplyDraftToRun,
  readOnly = false,
}: GraphEditorProps) {
  const { t } = useTranslation();
  const [nodes, setNodes, onNodesChange] = useNodesState<ReactFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<ReactFlowEdge>([]);
  const [showDispatchForm, setShowDispatchForm] = useState(false);
  // B4「调整节点」编辑表单（UpdateNode）：标题 / 描述 / 验收。
  const [showEditForm, setShowEditForm] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editAcceptance, setEditAcceptance] = useState("");
  const [editErrors, setEditErrors] = useState<string[] | null>(null);
  // F4：编辑表单的审批策略（从 node.policy.approval_policy 初始化）。
  const [editApprovalPolicy, setEditApprovalPolicy] = useState<"never" | "on_high_risk" | "always">("on_high_risk");
  // B4 修订 Diff 横幅：applyCommands 返回的 diff，本地 dismiss 态控制显隐。
  const [diffDismissed, setDiffDismissed] = useState(false);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [phaseFilterId, setPhaseFilterId] = useState<string | null>(null);
  const [semanticZoom, setSemanticZoom] = useState<"detail" | "compact" | "map">("detail");
  const [flowColorMode, setFlowColorMode] = useState<"light" | "dark">(
    currentFlowColorMode,
  );
  const flowRef = useRef<ReactFlowInstance | null>(null);
  // Whether the initial layout (fit-or-restore) has happened for the current
  // graph. Subsequent snapshot changes preserve the user's viewport (§13.2).
  const didInitialLayoutRef = useRef(false);
  const selectedNodeIdRef = useRef(selectedNodeId);
  const onNodeSelectRef = useRef(onNodeSelect);
  selectedNodeIdRef.current = selectedNodeId;
  onNodeSelectRef.current = onNodeSelect;

  const phaseNodes = useMemo(
    () => snapshot?.nodes.filter((node) => node.node_kind === "group") ?? [],
    [snapshot],
  );

  // B4 冻结节点集合（用于置灰 + 禁用编辑入口）。
  const frozenNodeIds = useMemo(() => {
    const frozen = new Set<string>();
    if (nodeRuns) {
      for (const [nodeId, run] of Object.entries(nodeRuns)) {
        if ((FROZEN_NODE_RUN_STATUSES as readonly string[]).includes(run.status)) {
          frozen.add(nodeId);
        }
      }
    }
    return frozen;
  }, [nodeRuns]);

  const selectedNode = useMemo(
    () => snapshot?.nodes.find((node) => node.node_id === selectedNodeId) ?? null,
    [snapshot, selectedNodeId],
  );
  const selectedFrozen = !!selectedNodeId && frozenNodeIds.has(selectedNodeId);

  // 每次 applyCommands 产出新 diff 时，重置本地 dismiss 态，重新展示横幅。
  useEffect(() => {
    setDiffDismissed(false);
  }, [lastDiff]);

  const visibleSnapshot = useMemo<GraphSnapshot | null>(() => {
    if (!snapshot || !phaseFilterId) return snapshot;
    const visibleNodeIds = new Set(
      snapshot.nodes
        .filter((node) =>
          node.node_id === phaseFilterId ||
          node.parent_id === phaseFilterId ||
          node.node_kind === "goal",
        )
        .map((node) => node.node_id),
    );
    return {
      nodes: snapshot.nodes.filter((node) => visibleNodeIds.has(node.node_id)),
      edges: snapshot.edges.filter(
        (edge) =>
          visibleNodeIds.has(edge.source_node_id) &&
          visibleNodeIds.has(edge.target_node_id),
      ),
    };
  }, [phaseFilterId, snapshot]);

  useEffect(() => {
    if (!phaseFilterId) return;
    if (!phaseNodes.some((node) => node.node_id === phaseFilterId)) {
      setPhaseFilterId(null);
    }
  }, [phaseFilterId, phaseNodes]);

  // ── F2-2（设计 §5 批 F2）：快照 + 运行状态 → 目标节点/边描述（label/style）──
  // 位置不在此派生——位置以 ReactFlow 当前 state 为单一来源（F2-3，修 B-3）。
  // semanticZoom 只影响 label，不影响位置/布局（F2-6，P-7）。
  const desiredNodes = useMemo<DesiredNode[]>(() => {
    if (!visibleSnapshot) return [];
    return visibleSnapshot.nodes.map((n) => {
      const status = nodeRuns?.[n.node_id]?.status;
      const appearance = nodeAppearance(status);
      const kindStyle = nodeKindStyle(n.node_kind);
      const statusText = status ? ` [${t(`tasks.workbench.status.${status}`)}]` : "";
      const nodeKindText = t(`tasks.workbench.nodeKinds.${n.node_kind}`);
      // B4 冻结规则 A8：已进入执行的节点不可编辑，标签前置 🔒 提示。
      const lockPrefix = frozenNodeIds.has(n.node_id) ? "🔒 " : "";
      const label = semanticZoom === "map"
        ? `${lockPrefix}${n.title}`
        : semanticZoom === "compact"
          ? `${lockPrefix}${n.title}${statusText}`
          : `${lockPrefix}${n.title}\n(${nodeKindText})${statusText}`;
      return {
        id: n.node_id,
        label,
        style: {
          border: `${kindStyle.borderWidth}px ${kindStyle.borderStyle} ${appearance.borderColor}`,
          padding: 10,
          borderRadius: kindStyle.borderRadius,
          background: appearance.background,
          color: appearance.color,
          width: LAYOUT_NODE_WIDTH,
          boxShadow: appearance.boxShadow,
          // F2-4（P-6）：定向过渡，不含 position/size——此前的 "all 0.3s ease"
          // 会让布局/位置变化也产生动画，是节点「漂移」观感的来源之一。
          transition: "border-color 0.2s ease, background-color 0.2s ease, box-shadow 0.2s ease",
        },
      };
    });
  }, [visibleSnapshot, nodeRuns, frozenNodeIds, semanticZoom, t]);

  const desiredEdges = useMemo<DesiredEdge[]>(() => {
    if (!visibleSnapshot) return [];
    return visibleSnapshot.edges.map((e) => ({
      id: e.edge_id,
      source: e.source_node_id,
      target: e.target_node_id,
      kind: e.kind,
      label: t(`tasks.workbench.edgeKinds.${e.kind}`),
    }));
  }, [visibleSnapshot, t]);

  // 结构签名：仅节点集合/边拓扑变化时才需要重新布局（worker postMessage /
  // 同步 computeLayout）；nodeRuns/semanticZoom 变化只走 diff（F2-6，P-7）。
  const layoutSignature = useMemo(() => {
    if (!visibleSnapshot) return "";
    const nodePart = visibleSnapshot.nodes.map((n) => n.node_id).join("|");
    const edgePart = visibleSnapshot.edges
      .map((e) => `${e.source_node_id}->${e.target_node_id}`)
      .join("|");
    return `${nodePart}#${edgePart}`;
  }, [visibleSnapshot]);

  // F2：worker 消息回调只注册一次，经 ref 读最新派生物/graphId。
  const desiredNodesRef = useRef(desiredNodes);
  desiredNodesRef.current = desiredNodes;
  const graphIdRef = useRef(graphId);
  graphIdRef.current = graphId;
  // F2-3：上次派生 effect 见到的 graphId/结构签名（切图判定 + 布局去重）。
  const lastGraphIdRef = useRef<string | null>(graphId ?? null);
  const lastLayoutSignatureRef = useRef("");
  // F2：handleNodeDragStop 经 ref 读最新 nodes，回调不随 nodes 重建（P-9）。
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // Layout runs in a Web Worker so a large canvas never blocks the main thread
  // (design §13.2). In environments without `Worker` (jsdom tests), `null` falls
  // back to synchronous `computeLayout`, preserving existing behavior.
  const layoutWorkerRef = useRef<Worker | null | undefined>(undefined);
  if (layoutWorkerRef.current === undefined) {
    if (typeof Worker !== "undefined") {
      try {
        layoutWorkerRef.current = new Worker(new URL("./layout-worker.ts", import.meta.url), {
          type: "module",
        });
      } catch {
        layoutWorkerRef.current = null;
      }
    } else {
      layoutWorkerRef.current = null;
    }
  }

  useEffect(() => {
    const worker = layoutWorkerRef.current;
    if (!worker) return;
    const applyLayout = (event: MessageEvent<LayoutResult>) => {
      const positions = event.data;
      setNodes((current) => {
        const currentById = new Map(current.map((node) => [node.id, node] as const));
        // F2-5（设计 §5 批 F2）：worker 布局返回后，把暂存的 pending 节点一次性带入
        // （返回前不入画布，消除 {0,0} 闪帧）；已在画布的节点保留当前位置——
        // 用户拖拽/ savedPositions 还原的节点不被 dagre 结果覆盖。
        // 注意：F2 修复后同步布局已作为 fallback 给所有节点初始位置，此处主要处理
        // 后续新增节点（structure 变化）的异步定位。
        const next: ReactFlowNode[] = [];
        let changed = false;
        for (const spec of desiredNodesRef.current) {
          const existing = currentById.get(spec.id);
          if (existing) {
            next.push(existing);
            continue;
          }
          const placed = positions[spec.id];
          if (!placed) continue; // 该结果来自旧一轮布局，等最新一轮返回
          changed = true;
          next.push({
            id: spec.id,
            data: { label: spec.label },
            position: placed,
            targetPosition: Position.Left,
            sourcePosition: Position.Right,
            style: spec.style,
          });
        }
        if (!changed) return current;
        // Persist dagre-computed positions so re-entry doesn't re-overlap.
        const gid = graphIdRef.current;
        if (gid) {
          const allPositions: Record<string, { x: number; y: number }> = {};
          for (const node of next) {
            allPositions[node.id] = node.position;
          }
          saveNodePositions(gid, allPositions);
        }
        return next;
      });
    };
    worker.addEventListener("message", applyLayout);
    return () => worker.removeEventListener("message", applyLayout);
  }, [setNodes]);

  useEffect(() => {
    return () => {
      layoutWorkerRef.current?.terminate();
      layoutWorkerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const element = document.documentElement;
    const updateTheme = () => setFlowColorMode(currentFlowColorMode());
    updateTheme();
    const observer = new MutationObserver(updateTheme);
    observer.observe(element, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      // 完成态只读：禁用键盘 undo/redo。
      if (readOnly) return;
      event.preventDefault();
      if (event.shiftKey) {
        if (canRedo) redo?.().catch(console.error);
      } else if (canUndo) {
        undo?.().catch(console.error);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canRedo, canUndo, redo, undo, readOnly]);

  const submitCommand = useCallback(
    (command: GraphCommand) => {
      // 完成态只读：所有走 submitCommand 的变更（加边/加节点/删边/派发表单）一并拦截。
      if (readOnly || !applyCommands) return;
      applyCommands([command]).catch(console.error);
    },
    [applyCommands, readOnly],
  );

  // B4「调整节点」：打开编辑表单，预填当前选中节点的标题/描述/验收契约。
  const openEditForm = useCallback(() => {
    if (!selectedNode) return;
    setEditTitle(selectedNode.title);
    setEditDescription(selectedNode.description ?? "");
    setEditAcceptance(
      (selectedNode.output_contract?.description as string | null | undefined) ?? "",
    );
    // F4：从节点 policy 初始化审批策略（后端 serde snake_case）。
    const policy = selectedNode.policy?.approval_policy;
    setEditApprovalPolicy(
      policy === "never" || policy === "always" || policy === "on_high_risk"
        ? policy
        : "on_high_risk",
    );
    setEditErrors(null);
    setShowEditForm(true);
  }, [selectedNode]);

  // 提交 UpdateNode：仅下发改动字段（title/description/output_contract），
  // 先经 validateCommands 预校验（S6），再 applyCommands。无改动则直接关闭，避免空修订。
  const submitEdit = useCallback(() => {
    if (!selectedNode || !applyCommands) return;
    if (!editTitle.trim()) {
      setEditErrors([t("tasks.orchestration.editNode.titleRequired")]);
      return;
    }
    const patch: Record<string, unknown> = {};
    if (editTitle.trim() !== selectedNode.title) patch.title = editTitle.trim();
    if (editDescription.trim() !== (selectedNode.description ?? "")) {
      // description 为双层 Option：空串→null（清空），非空→字符串。
      patch.description = editDescription.trim() || null;
    }
    const currentAcceptance =
      (selectedNode.output_contract?.description as string | null | undefined) ?? null;
    if (editAcceptance.trim() !== (currentAcceptance ?? "")) {
      // output_contract 为单层 Option（整体覆盖）：保留既有 artifacts/schema，仅替换 description。
      patch.output_contract = {
        ...(selectedNode.output_contract ?? {}),
        description: editAcceptance.trim() || null,
      };
    }
    // F4：审批策略变更走 policy patch（后端 apply.rs 支持 policy 部分更新）。
    const currentPolicy = selectedNode.policy?.approval_policy;
    if (editApprovalPolicy !== currentPolicy) {
      patch.policy = {
        ...selectedNode.policy,
        approval_policy: editApprovalPolicy,
      };
    }
    if (Object.keys(patch).length === 0) {
      setShowEditForm(false);
      return;
    }
    const command: GraphCommand = {
      op: "update_node",
      command_id: `cmd_${crypto.randomUUID()}`,
      node_id: selectedNode.node_id,
      patch,
    };
    const run = async () => {
      if (validateCommands) {
        const errors = await validateCommands([command]);
        if (errors.length > 0) {
          setEditErrors(errors);
          return;
        }
      }
      setEditErrors(null);
      await applyCommands([command]);
      setShowEditForm(false);
    };
    run().catch(console.error);
  }, [
    selectedNode,
    editTitle,
    editDescription,
    editAcceptance,
    editApprovalPolicy,
    applyCommands,
    validateCommands,
    t,
  ]);

  const selectNode = useCallback((nodeId: string | null) => {
    if (selectedNodeIdRef.current === nodeId) return;
    selectedNodeIdRef.current = nodeId;
    onNodeSelectRef.current?.(nodeId);
  }, []);

  const handleNodeClick = useCallback(
    (_event: unknown, node: ReactFlowNode) => {
      selectNode(node.id);
      setSelectedEdgeId(null);
    },
    [selectNode],
  );

  const handleEdgeClick = useCallback(
    (_event: unknown, edge: ReactFlowEdge) => {
      selectNode(null);
      setSelectedEdgeId(edge.id);
    },
    [selectNode],
  );

  const handlePaneClick = useCallback(() => {
    selectNode(null);
    setSelectedEdgeId(null);
  }, [selectNode]);

  const handleMoveEnd = useCallback(
    (_event: unknown, viewport: { x: number; y: number; zoom: number }) => {
      // Persist the user's viewport for this graph (§13.2 soft-constraint).
      if (graphId) saveViewport(graphId, viewport);
      setSemanticZoom(
        viewport.zoom < 0.45 ? "map" : viewport.zoom < 0.75 ? "compact" : "detail",
      );
    },
    [graphId],
  );

  // Persist node positions when the user drags a node.
  // F2-3：这是 savedPositions 的唯一写入入口；F2（P-9）：经 nodesRef 读最新
  // nodes，回调引用不随 nodes 每次变化重建。
  const handleNodeDragStop = useCallback(() => {
    if (!graphId) return;
    const allPositions: Record<string, { x: number; y: number }> = {};
    for (const node of nodesRef.current) {
      allPositions[node.id] = node.position;
    }
    saveNodePositions(graphId, allPositions);
  }, [graphId]);

  useEffect(() => {
    // Switching graphs re-runs the initial fit-or-restore on the next snapshot.
    didInitialLayoutRef.current = false;
  }, [graphId]);

  // F2-2/F2-3（设计 §5 批 F2，修 B-3）：单一「快照 + 状态 → nodes/edges」派生 effect，
  // 合并原「快照全量重建」与「nodeRuns 重刷样式」两个 effect（原 :674/:796，P-3）。
  // setNodes/setEdges 内逐条 diff（label/style 全等复用原对象引用），无变化返回原数组——
  // 空载轮询时（F1 后 nodeRuns 引用稳定，本 effect 不重跑；即便重跑也零更新）。
  useEffect(() => {
    if (!visibleSnapshot) return;

    const layoutWorker = layoutWorkerRef.current;
    const isGraphSwitch = lastGraphIdRef.current !== (graphId ?? null);
    lastGraphIdRef.current = graphId ?? null;

    // F2-6（P-7）：布局仅随结构/切图重跑。semanticZoom/nodeRuns 变化只走下方 diff，
    // 不 postMessage、不重算布局。
    let syncPositions: LayoutResult = {};
    if (isGraphSwitch || lastLayoutSignatureRef.current !== layoutSignature) {
      lastLayoutSignatureRef.current = layoutSignature;
      const layoutGraph: LayoutGraph = {
        nodes: desiredNodes.map((node) => ({ id: node.id })),
        edges: desiredEdges.map((edge) => ({ source: edge.source, target: edge.target })),
      };
      // 同步布局始终作为 fallback：无 Worker 环境直接使用；有 Worker 时先给节点一个
      // 立即可见的位置，避免审批通过/组件重挂等场景下 worker 消息延迟或 race 导致画布
      // 持续空白。Worker 返回后 applyLayout 再把尚未定位的新节点更新为 dagre 结果。
      syncPositions = computeLayout(layoutGraph);
      layoutWorker?.postMessage(layoutGraph);
    }

    // Load persisted node positions for this graph (prevents re-overlap on re-entry).
    // F2-3 位置优先级（单一来源，修 B-3 核心）：
    //   1. ReactFlow 当前 state——拖拽中的节点不被任何持久化值覆盖；
    //   2. savedPositions——仅「该节点当前无位置记录」时生效（初次挂载/切图/新节点），
    //      不再凌驾当前位置；初次挂载（current 为空）时正常生效，保证重进任务布局还原；
    //   3. 同步布局 fallback（始终计算，覆盖无 Worker / Worker 延迟返回的情况）。
    const savedPositions = graphId ? loadNodePositions(graphId) : null;

    setNodes((current) => {
      const currentById = new Map(current.map((node) => [node.id, node] as const));
      const next: ReactFlowNode[] = [];
      let changed = false;
      for (const spec of desiredNodes) {
        const existing = currentById.get(spec.id);
        const position =
          (!isGraphSwitch ? existing?.position : undefined) ??
          savedPositions?.[spec.id] ??
          syncPositions[spec.id];
        if (!position) continue; // 兜底已保证不会走到这里（computeLayout 始终返回位置）
        if (
          existing &&
          existing.data.label === spec.label &&
          nodeStyleEqual(existing.style, spec.style)
        ) {
          next.push(existing); // 无变化：复用原对象引用
          continue;
        }
        changed = true;
        next.push(
          existing
            ? { ...existing, data: { label: spec.label }, style: spec.style, position }
            : {
                id: spec.id,
                data: { label: spec.label },
                position,
                targetPosition: Position.Left,
                sourcePosition: Position.Right,
                style: spec.style,
              },
        );
      }
      if (!changed) {
        // 全复用时仍需捕获「节点被移除 / 顺序变化」。
        changed =
          next.length !== current.length ||
          next.some((node, index) => node !== current[index]);
      }
      return changed ? next : current;
    });

    setEdges((current) => {
      const currentById = new Map(current.map((edge) => [edge.id, edge] as const));
      const next: ReactFlowEdge[] = [];
      let changed = false;
      for (const spec of desiredEdges) {
        const existing = currentById.get(spec.id);
        if (
          existing &&
          existing.source === spec.source &&
          existing.target === spec.target &&
          existing.label === spec.label
        ) {
          next.push(existing); // 无变化：复用原对象引用（含 selected 选中态）
          continue;
        }
        changed = true;
        const isControl = spec.kind === "control_dependency";
        const color = isControl ? "var(--task-edge-control)" : "var(--task-edge-data)";
        next.push({
          id: spec.id,
          source: spec.source,
          target: spec.target,
          label: spec.label,
          animated: false,
          interactionWidth: 28,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color,
            width: 18,
            height: 18,
          },
          labelStyle: { fill: color, fontSize: 12, fontWeight: 600 },
          labelShowBg: true,
          labelBgStyle: { fill: "var(--task-canvas-panel-bg)", fillOpacity: 0.96 },
          labelBgPadding: [6, 4] as [number, number],
          labelBgBorderRadius: 5,
          style: {
            stroke: color,
            strokeDasharray: isControl ? undefined : "7 7",
            strokeWidth: 2,
          },
        });
      }
      if (!changed) {
        changed =
          next.length !== current.length ||
          next.some((edge, index) => edge !== current[index]);
      }
      return changed ? next : current;
    });
  }, [visibleSnapshot, desiredNodes, desiredEdges, layoutSignature, graphId, setNodes, setEdges]);

  // 初始视口（§13.2）：首张快照的节点实际入画布后，恢复保存的视口或 fitView 一次；
  // 之后保留用户视口。worker 布局路径下节点异步到位（F2-5），故独立观察 nodes。
  useEffect(() => {
    if (didInitialLayoutRef.current || nodes.length === 0) return;
    const frame = requestAnimationFrame(() => {
      const instance = flowRef.current;
      if (!instance || didInitialLayoutRef.current) return;
      const saved = graphId ? loadViewport(graphId) : null;
      if (saved) {
        instance.setViewport(saved);
      } else {
        instance.fitView({ padding: 0.16, duration: 250 });
      }
      didInitialLayoutRef.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [nodes, graphId]);

  useEffect(() => {
    setEdges((currentEdges) =>
      currentEdges.map((edge) => ({
        ...edge,
        selected: edge.id === selectedEdgeId,
        style: {
          ...edge.style,
          strokeWidth: edge.id === selectedEdgeId ? 3 : 2,
        },
      })),
    );
  }, [selectedEdgeId, setEdges]);

  const connectNodes = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) {
        return;
      }
      submitCommand({
        op: "add_edge",
        command_id: `cmd_${crypto.randomUUID()}`,
        edge: {
          edge_id: `edge_${crypto.randomUUID()}`,
          source_node_id: connection.source,
          target_node_id: connection.target,
          kind: "control_dependency",
        },
      });
    },
    [submitCommand],
  );

  const deleteSelection = useCallback(
    (deletedNodes: ReactFlowNode[], deletedEdges: ReactFlowEdge[]) => {
      if (readOnly || !applyCommands) return;
      // F3（设计 §5 批 F3）：前置过滤 frozen / goal 节点。
      // 后端 A8（service.rs:631-640）会拒绝 frozen 节点删除，MissingGoal 拦截 goal 删除。
      // 前端先拦避免「本地已删 → 后端拒绝 → 节点消失」的乐观删除 BUG（B-2）。
      const deletableNodes = deletedNodes.filter((node) => {
        const graphNode = snapshot?.nodes.find((item) => item.node_id === node.id);
        if (!graphNode) return false;
        if (graphNode.node_kind === "goal") return false;
        if (frozenNodeIds.has(node.id)) return false;
        return true;
      });
      const commands: GraphCommand[] = [
        ...deletedEdges.map((edge) => ({
          op: "remove_edge",
          command_id: `cmd_${crypto.randomUUID()}`,
          edge_id: edge.id,
        })),
        ...deletableNodes.map((node) => ({
          op: "remove_node",
          command_id: `cmd_${crypto.randomUUID()}`,
          node_id: node.id,
        })),
      ];
      if (commands.length > 0) {
        applyCommands(commands).catch(console.error);
      }
    },
    [applyCommands, snapshot, readOnly, frozenNodeIds],
  );

  // F2-1（P-2）：onDelete/onInit 稳定引用，避免击穿 memo 后 ReactFlow 每次重订阅。
  const handleDelete = useCallback(
    ({ nodes: deletedNodes, edges: deletedEdges }: { nodes: ReactFlowNode[]; edges: ReactFlowEdge[] }) =>
      deleteSelection(deletedNodes, deletedEdges),
    [deleteSelection],
  );

  const handleInit = useCallback((instance: ReactFlowInstance) => {
    flowRef.current = instance;
  }, []);

  return (
    <div
      className="relative h-full w-full bg-[var(--task-canvas-bg)]"
      role="application"
      aria-label={t("tasks.workbench.canvasAriaLabel")}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={connectNodes}
        onDelete={handleDelete}
        nodesConnectable={!readOnly}
        nodesDraggable={!readOnly}
        elementsSelectable
        deleteKeyCode={readOnly ? null : DELETE_KEY_CODES}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        onPaneClick={handlePaneClick}
        onMoveEnd={handleMoveEnd}
        onNodeDragStop={handleNodeDragStop}
        onInit={handleInit}
        colorMode={flowColorMode}
      >
        <Controls />
        <MiniMap />
        <Background gap={18} size={1} color="var(--task-canvas-grid)" />
        {/* 顶部工具栏：单一容器，左右分组自适应换行，互不遮挡 */}
        <div className="absolute inset-x-4 top-4 z-20 flex flex-wrap items-start justify-between gap-y-2">
          <div className="flex flex-wrap items-center gap-2">
          {startRun && (
            <button
              className="cursor-pointer rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => startRun().catch(console.error)}
              disabled={!!activeRunId}
            >
              {activeRunId ? t("tasks.workbench.runStarted") : t("tasks.workbench.startRun")}
            </button>
          )}
          {generateProposal && (
            <button
              type="button"
              className="rounded-lg border border-primary/20 bg-primary/10 px-4 py-2 text-sm font-medium text-primary shadow-sm hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => generateProposal().catch(console.error)}
              disabled={planning}
            >
              {planning
                ? t("tasks.workbench.planning")
                : t("tasks.workbench.aiPlan")}
            </button>
          )}
          {activeRunId && applyDraftToRun && (
            <button
              type="button"
              className="rounded-lg border border-border bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground shadow-sm hover:bg-secondary/80 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => applyDraftToRun().catch(console.error)}
              disabled={!canApplyDraftToRun}
            >
              {canApplyDraftToRun
                ? t("tasks.workbench.applyDraftToRun")
                : t("tasks.workbench.runUsesCurrentDraft")}
            </button>
          )}
          <button
            type="button"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => undo?.().catch(console.error)}
            disabled={readOnly || !canUndo}
            title={`${t("tasks.workbench.undo")} (Ctrl/Cmd+Z)`}
          >
            {t("tasks.workbench.undo")}
          </button>
          <button
            type="button"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => redo?.().catch(console.error)}
            disabled={readOnly || !canRedo}
            title={`${t("tasks.workbench.redo")} (Ctrl/Cmd+Shift+Z)`}
          >
            {t("tasks.workbench.redo")}
          </button>
          {activeRunId && runStatus === "running" && pauseRun && (
            <button
              className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-amber-700"
              onClick={() => pauseRun().catch(console.error)}
            >
              {t("tasks.workbench.pauseRun")}
            </button>
          )}
          {activeRunId && ["paused", "awaiting_human"].includes(runStatus ?? "") && resumeRun && (
            <button
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
              onClick={() => resumeRun().catch(console.error)}
            >
              {t("tasks.workbench.resumeRun")}
            </button>
          )}
          {activeRunId && cancelRun && (
            <button
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-red-700"
              onClick={() => cancelRun().catch(console.error)}
            >
              {t("tasks.workbench.cancelRun")}
            </button>
          )}
          <button
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={readOnly}
            onClick={() => {
              if (applyCommands) {
                const goalNode = snapshot?.nodes.find((node) => node.node_kind === "goal");
                applyCommands([
                  {
                    op: "add_node",
                    command_id: `cmd_${Date.now()}`,
                    node: {
                      node_id: `node_${Date.now()}`,
                      parent_id: goalNode?.node_id ?? null,
                      title: t("tasks.workbench.newPhase"),
                      description: null,
                      node_kind: "group",
                      input_contract: { description: null, artifacts: [], schema: null },
                      output_contract: { description: null, artifacts: [], schema: null },
                      role_requirement: null,
                      capability_requirements: [],
                      agent_assignment_constraint: null,
                      policy: {},
                      metadata: {},
                      executable_payload: null,
                      loop_config: null,
                      approval_gate_config: null
                    }
                  }
                ]).catch(console.error);
              }
            }}
          >
            {t("tasks.workbench.addPhase")}
          </button>
          <button
            type="button"
            className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
            disabled={readOnly}
            onClick={() => setShowDispatchForm(true)}
          >
            {t("tasks.workbench.addAgentStep")}
          </button>
          <button
            type="button"
            className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
            disabled={readOnly || !selectedNode || selectedFrozen}
            onClick={openEditForm}
            title={
              selectedFrozen
                ? t("tasks.orchestration.editNode.frozenHint")
                : t("tasks.orchestration.editNode.toolbarButton")
            }
          >
            {t("tasks.orchestration.editNode.toolbarButton")}
          </button>
          {/* F3（设计 §5 批 F3）：删除节点入口——显性化，前置拦截 goal/frozen。 */}
          <button
            type="button"
            className="rounded-lg border border-destructive/30 bg-background px-3 py-2 text-sm font-medium text-destructive shadow-sm hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={
              readOnly ||
              !selectedNode ||
              selectedNode.node_kind === "goal" ||
              selectedFrozen
            }
            onClick={() => {
              if (!selectedNode || !applyCommands) return;
              applyCommands([{
                op: "remove_node",
                command_id: `cmd_${crypto.randomUUID()}`,
                node_id: selectedNode.node_id,
              }]).catch(console.error);
              selectNode(null);
            }}
            title={
              !selectedNode
                ? t("tasks.workbench.deleteNode")
                : selectedNode.node_kind === "goal"
                  ? t("tasks.workbench.deleteNodeGoal")
                  : selectedFrozen
                    ? t("tasks.workbench.deleteNodeFrozen")
                    : t("tasks.workbench.deleteNode")
            }
          >
            {t("tasks.workbench.deleteNode")}
          </button>
          </div>
          {/* 右侧信息卡片组 */}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-[var(--task-canvas-panel-bg)] px-3 py-2 text-xs text-foreground shadow-sm backdrop-blur">
              <span className="text-muted-foreground">
                {t("tasks.workbench.revisionStatus.revision")}
              </span>
              <span className="font-mono text-foreground">
                {currentRevisionId ?? "-"}
              </span>
              <span
                className={cn(
                  "rounded px-2 py-0.5 font-medium",
                  canUndo
                    ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                    : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
                )}
              >
                {canUndo
                  ? t("tasks.workbench.revisionStatus.dirty")
                  : t("tasks.workbench.revisionStatus.clean")}
              </span>
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-[var(--task-canvas-panel-bg)] px-3 py-2 text-xs text-foreground shadow-sm backdrop-blur">
              <span className="text-muted-foreground">
                {t("tasks.workbench.semanticZoom.label")}
              </span>
              <span className="font-medium">
                {t(`tasks.workbench.semanticZoom.${semanticZoom}`)}
              </span>
            </div>
            {phaseNodes.length > 0 && (
              <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-lg border border-border bg-[var(--task-canvas-panel-bg)] p-1 shadow-sm backdrop-blur">
                <button
                  type="button"
                  className={cn(
                    "h-7 shrink-0 rounded px-2 text-xs transition",
                    !phaseFilterId
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                  onClick={() => setPhaseFilterId(null)}
                >
                  {t("tasks.workbench.phaseFilter.all")}
                </button>
                {phaseNodes.map((phase) => (
                  <button
                    key={phase.node_id}
                    type="button"
                    className={cn(
                      "h-7 max-w-40 shrink-0 truncate rounded px-2 text-xs transition",
                      phaseFilterId === phase.node_id
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                    onClick={() => setPhaseFilterId(phase.node_id)}
                    title={phase.title}
                  >
                    {phase.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </ReactFlow>
      {lastDiff && !diffDismissed && (
        <div className="absolute top-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-border bg-[var(--task-canvas-panel-bg)] px-4 py-2.5 text-sm text-foreground shadow-xl backdrop-blur">
          <span className="font-medium">{t("tasks.orchestration.diff.appliedTitle")}</span>
          {lastDiff.nodes_added.length > 0 && (
            <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-400">
              {t("tasks.orchestration.diff.nodesAdded", { count: lastDiff.nodes_added.length })}
            </span>
          )}
          {lastDiff.nodes_updated.length > 0 && (
            <span className="rounded bg-blue-500/15 px-2 py-0.5 text-xs text-blue-700 dark:text-blue-400">
              {t("tasks.orchestration.diff.nodesUpdated", { count: lastDiff.nodes_updated.length })}
            </span>
          )}
          {lastDiff.nodes_removed.length > 0 && (
            <span className="rounded bg-red-500/15 px-2 py-0.5 text-xs text-red-700 dark:text-red-400">
              {t("tasks.orchestration.diff.nodesRemoved", { count: lastDiff.nodes_removed.length })}
            </span>
          )}
          {lastDiff.edges_added.length > 0 && (
            <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {t("tasks.orchestration.diff.edgesAdded", { count: lastDiff.edges_added.length })}
            </span>
          )}
          {lastDiff.edges_removed.length > 0 && (
            <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {t("tasks.orchestration.diff.edgesRemoved", { count: lastDiff.edges_removed.length })}
            </span>
          )}
          <button
            type="button"
            className="ml-1 text-muted-foreground hover:text-foreground"
            onClick={() => setDiffDismissed(true)}
            aria-label={t("tasks.orchestration.diff.dismiss")}
          >
            ✕
          </button>
        </div>
      )}
      {selectedEdgeId && snapshot && (
        <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-4 rounded-xl border border-border bg-[var(--task-canvas-panel-bg)] px-4 py-3 text-sm text-foreground shadow-xl backdrop-blur">
          {(() => {
            const edge = snapshot.edges.find((candidate) => candidate.edge_id === selectedEdgeId);
            if (!edge) return null;
            const source = snapshot.nodes.find((node) => node.node_id === edge.source_node_id);
            const target = snapshot.nodes.find((node) => node.node_id === edge.target_node_id);
            return (
              <>
                <span className="font-medium">
                  {source?.title ?? edge.source_node_id}
                  <span className="px-2 text-primary">→</span>
                  {target?.title ?? edge.target_node_id}
                </span>
                <span className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
                  {t(`tasks.workbench.edgeKinds.${edge.kind}`)}
                </span>
                <button
                  type="button"
                  className="rounded border border-destructive/25 px-3 py-1.5 text-destructive hover:bg-destructive/10"
                  onClick={() => {
                    submitCommand({
                      op: "remove_edge",
                      command_id: `cmd_${crypto.randomUUID()}`,
                      edge_id: edge.edge_id,
                    });
                    setSelectedEdgeId(null);
                  }}
                >
                  {t("tasks.workbench.deleteEdge")}
                </button>
              </>
            );
          })()}
        </div>
      )}
      {showDispatchForm && (
        <DispatchWizardForm
          goalNodeId={snapshot?.nodes.find((n) => n.node_kind === "goal")?.node_id ?? null}
          phaseNodes={phaseNodes.map((p) => ({ node_id: p.node_id, title: p.title }))}
          onSubmit={(cmd) => {
            submitCommand(cmd);
            setShowDispatchForm(false);
          }}
          onCancel={() => setShowDispatchForm(false)}
        />
      )}
      {showEditForm && selectedNode && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-[var(--task-canvas-overlay-bg)] p-6 backdrop-blur-sm">
          <form
            className="w-full max-w-lg rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl"
            onSubmit={(event) => {
              event.preventDefault();
              submitEdit();
            }}
          >
            <h3 className="text-xl font-semibold text-foreground">
              {t("tasks.orchestration.editNode.title")}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("tasks.orchestration.editNode.subtitle")}
            </p>
            {selectedFrozen && (
              <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                {t("tasks.orchestration.editNode.frozenHint")}
              </p>
            )}
            <div className="mt-4 space-y-4">
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("tasks.orchestration.editNode.titleLabel")}
                </span>
                <input
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
                  value={editTitle}
                  onChange={(event) => setEditTitle(event.target.value)}
                  autoFocus
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("tasks.orchestration.editNode.descriptionLabel")}
                </span>
                <textarea
                  className="mt-1 h-24 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
                  value={editDescription}
                  onChange={(event) => setEditDescription(event.target.value)}
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("tasks.orchestration.editNode.acceptanceLabel")}
                </span>
                <textarea
                  className="mt-1 h-24 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
                  value={editAcceptance}
                  onChange={(event) => setEditAcceptance(event.target.value)}
                />
              </label>
              {/* F4：审批策略编辑 */}
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("tasks.orchestration.editNode.approvalPolicyLabel")}
                </span>
                <select
                  value={editApprovalPolicy}
                  onChange={(event) => setEditApprovalPolicy(event.target.value as typeof editApprovalPolicy)}
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
                >
                  {(["never", "on_high_risk", "always"] as const).map((p) => (
                    <option key={p} value={p}>
                      {t(`tasks.workbench.nodeWizard.approvalPolicies.${p}`)}
                    </option>
                  ))}
                </select>
              </label>
              {editErrors && editErrors.length > 0 && (
                <ul className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {editErrors.map((error, index) => (
                    <li key={index}>• {error}</li>
                  ))}
                </ul>
              )}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-border bg-background px-4 py-2 text-sm text-foreground hover:bg-accent"
                onClick={() => setShowEditForm(false)}
              >
                {t("tasks.orchestration.editNode.cancel")}
              </button>
              <button
                type="submit"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                {t("tasks.orchestration.editNode.save")}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

// F2-1（设计 §5 批 F2，P-2）：memo 隔离重渲染——父组件轮询状态变化时，
// props 引用稳定（PhaseExecutionView 侧回调已 useCallback / 直接传稳定方法引用）则不重渲。
export const GraphEditor = memo(GraphEditorInner);
GraphEditor.displayName = "GraphEditor";
