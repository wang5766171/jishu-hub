import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  onSubmit,
  onCancel,
}: {
  goalNodeId: string | null;
  onSubmit: (command: GraphCommand) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [intent, setIntent] = useState<"implement" | "research" | "verify">("implement");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [acceptance, setAcceptance] = useState("");

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
          onSubmit({
            op: "add_node",
            command_id: `cmd_${crypto.randomUUID()}`,
            node: {
              node_id: `node_${crypto.randomUUID()}`,
              parent_id: goalNodeId,
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
              policy: {
                approval_policy: "on_high_risk",
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

export function GraphEditor({
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
        let changed = false;
        const next = current.map((node) => {
          // Only place nodes still at the origin (newly added, not yet laid out
          // or dragged). Nodes the user moved keep their position.
          if (node.position.x !== 0 || node.position.y !== 0) return node;
          const placed = positions[node.id];
          if (!placed) return node;
          changed = true;
          return { ...node, position: placed };
        });
        // Persist dagre-computed positions so re-entry doesn't re-overlap.
        if (changed && graphId) {
          const allPositions: Record<string, { x: number; y: number }> = {};
          for (const node of next) {
            allPositions[node.id] = node.position;
          }
          saveNodePositions(graphId, allPositions);
        }
        return changed ? next : current;
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
  const handleNodeDragStop = useCallback(() => {
    if (!graphId) return;
    const allPositions: Record<string, { x: number; y: number }> = {};
    for (const node of nodes) {
      allPositions[node.id] = node.position;
    }
    saveNodePositions(graphId, allPositions);
  }, [graphId, nodes]);

  useEffect(() => {
    // Switching graphs re-runs the initial fit-or-restore on the next snapshot.
    didInitialLayoutRef.current = false;
  }, [graphId]);

  useEffect(() => {
    if (!visibleSnapshot) return;

    const rfNodes: ReactFlowNode[] = visibleSnapshot.nodes.map((n) => {
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
        data: {
          label,
        },
        position: { x: 0, y: 0 },
        targetPosition: Position.Left,
        sourcePosition: Position.Right,
        style: {
          border: `${kindStyle.borderWidth}px ${kindStyle.borderStyle} ${appearance.borderColor}`,
          padding: 10,
          borderRadius: kindStyle.borderRadius,
          background: appearance.background,
          color: appearance.color,
          width: LAYOUT_NODE_WIDTH,
          boxShadow: appearance.boxShadow,
          transition: "all 0.3s ease"
        },
      };
    });

    const rfEdges: ReactFlowEdge[] = visibleSnapshot.edges.map((e) => {
      const isControl = e.kind === "control_dependency";
      const color = isControl ? "var(--task-edge-control)" : "var(--task-edge-data)";
      return {
        id: e.edge_id,
        source: e.source_node_id,
        target: e.target_node_id,
        label: t(`tasks.workbench.edgeKinds.${e.kind}`),
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
      };
    });

    const layoutGraph: LayoutGraph = {
      nodes: rfNodes.map((node) => ({ id: node.id })),
      edges: rfEdges.map((edge) => ({ source: edge.source, target: edge.target })),
    };
    const layoutWorker = layoutWorkerRef.current;
    // Load persisted node positions for this graph (prevents re-overlap on
    // re-entry). Saved positions take priority; dagre fills the rest.
    const savedPositions = graphId ? loadNodePositions(graphId) : null;
    // Without a worker (jsdom tests, or browsers where Worker failed to spawn),
    // compute synchronously — behavior matches the legacy inline layout. With a
    // worker, new-node positions arrive asynchronously via the message handler.
    const positions = layoutWorker ? {} : computeLayout(layoutGraph);
    setNodes((current) => {
      const currentPositions = new Map(
        current.map((node) => [node.id, node.position] as const),
      );
      return rfNodes.map((node) => ({
        ...node,
        position:
          savedPositions?.[node.id]
          ?? currentPositions.get(node.id)
          ?? positions[node.id]
          ?? { x: 0, y: 0 },
      }));
    });
    layoutWorker?.postMessage(layoutGraph);
    setEdges(rfEdges);
    requestAnimationFrame(() => {
      const instance = flowRef.current;
      if (!instance) return;
      // Only fit/restore once per graph; after that, preserve the user's viewport.
      if (didInitialLayoutRef.current) return;
      const saved = graphId ? loadViewport(graphId) : null;
      if (saved) {
        instance.setViewport(saved);
      } else {
        instance.fitView({ padding: 0.16, duration: 250 });
      }
      didInitialLayoutRef.current = true;
    });
  }, [visibleSnapshot, semanticZoom, setNodes, setEdges, t, frozenNodeIds]);

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

  useEffect(() => {
    const graphNodes = new Map(
      visibleSnapshot?.nodes.map((candidate) => [candidate.node_id, candidate]) ?? [],
    );
    setNodes((currentNodes) =>
      currentNodes.map((node) => {
        const graphNode = graphNodes.get(node.id);
        if (!graphNode) return node;
        const status = nodeRuns?.[node.id]?.status;
        const appearance = nodeAppearance(status);
        const kindStyle = nodeKindStyle(graphNode.node_kind);
        const statusText = status ? ` [${t(`tasks.workbench.status.${status}`)}]` : "";
        const nodeKindText = t(`tasks.workbench.nodeKinds.${graphNode.node_kind}`);
        // B4 冻结规则 A8：与首个 effect 同步，状态刷新时保留 🔒 前缀。
        const lockPrefix = frozenNodeIds.has(graphNode.node_id) ? "🔒 " : "";
        const label = semanticZoom === "map"
          ? `${lockPrefix}${graphNode.title}`
          : semanticZoom === "compact"
            ? `${lockPrefix}${graphNode.title}${statusText}`
            : `${lockPrefix}${graphNode.title}\n(${nodeKindText})${statusText}`;
        return {
          ...node,
          data: {
            label,
          },
          style: {
            ...node.style,
            border: `${kindStyle.borderWidth}px ${kindStyle.borderStyle} ${appearance.borderColor}`,
            borderRadius: kindStyle.borderRadius,
            background: appearance.background,
            color: appearance.color,
            boxShadow: appearance.boxShadow,
          },
        };
      }),
    );
  }, [nodeRuns, semanticZoom, setNodes, visibleSnapshot, t, frozenNodeIds]);

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
      const commands: GraphCommand[] = [
        ...deletedEdges.map((edge) => ({
          op: "remove_edge",
          command_id: `cmd_${crypto.randomUUID()}`,
          edge_id: edge.id,
        })),
        ...deletedNodes
          .filter((node) => snapshot?.nodes.find((item) => item.node_id === node.id)?.node_kind !== "goal")
          .map((node) => ({
            op: "remove_node",
            command_id: `cmd_${crypto.randomUUID()}`,
            node_id: node.id,
          })),
      ];
      if (commands.length > 0) {
        applyCommands(commands).catch(console.error);
      }
    },
    [applyCommands, snapshot, readOnly],
  );

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
        onDelete={({ nodes: deletedNodes, edges: deletedEdges }) =>
          deleteSelection(deletedNodes, deletedEdges)
        }
        nodesConnectable={!readOnly}
        nodesDraggable={!readOnly}
        elementsSelectable
        deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        onPaneClick={handlePaneClick}
        onMoveEnd={handleMoveEnd}
        onNodeDragStop={handleNodeDragStop}
        onInit={(instance) => {
          flowRef.current = instance;
        }}
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
