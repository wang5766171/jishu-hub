import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
import type { GraphCommand, GraphSnapshot, NodeRun, NodeRunStatus } from "./use-task-graph";

const nodeWidth = 200;
const nodeHeight = 60;

function nodeAppearance(status?: NodeRunStatus) {
  switch (status) {
    case "ready":
    case "blocked":
      return { borderColor: "#888", background: "#222", boxShadow: "none" };
    case "leased":
    case "running":
    case "retry_wait":
    case "repairing":
      return { borderColor: "#eab308", background: "#222", boxShadow: "0 0 10px #eab308" };
    case "succeeded":
      return { borderColor: "#22c55e", background: "#222", boxShadow: "none" };
    case "failed":
      return { borderColor: "#ef4444", background: "#450a0a", boxShadow: "none" };
    case "cancelled":
    case "skipped":
    case "superseded":
      return { borderColor: "#64748b", background: "#222", boxShadow: "none" };
    case "awaiting_approval":
      return { borderColor: "#a855f7", background: "#222", boxShadow: "0 0 10px #a855f7" };
    default:
      return { borderColor: "#555", background: "#222", boxShadow: "none" };
  }
}

interface GraphEditorProps {
  snapshot: GraphSnapshot | null;
  selectedNodeId?: string | null;
  onNodeSelect?: (nodeId: string | null) => void;
  applyCommands?: (commands: GraphCommand[]) => Promise<void>;
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
}

export function GraphEditor({
  snapshot,
  selectedNodeId,
  onNodeSelect,
  applyCommands,
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
}: GraphEditorProps) {
  const { t } = useTranslation();
  const [nodes, setNodes, onNodesChange] = useNodesState<ReactFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<ReactFlowEdge>([]);
  const [showDispatchForm, setShowDispatchForm] = useState(false);
  const [dispatchTitle, setDispatchTitle] = useState("");
  const [dispatchPrompt, setDispatchPrompt] = useState("");
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const layoutWorkerRef = useRef<Worker | null>(null);
  const flowRef = useRef<ReactFlowInstance | null>(null);
  const layoutRequestRef = useRef(0);
  const selectedNodeIdRef = useRef(selectedNodeId);
  const onNodeSelectRef = useRef(onNodeSelect);
  selectedNodeIdRef.current = selectedNodeId;
  onNodeSelectRef.current = onNodeSelect;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
      if (event.shiftKey) {
        if (canRedo) redo?.().catch(console.error);
      } else if (canUndo) {
        undo?.().catch(console.error);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canRedo, canUndo, redo, undo]);

  useEffect(() => {
    const worker = new Worker(new URL("./layout.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (
      event: MessageEvent<{
        requestId: number;
        positions: Record<string, { x: number; y: number }>;
      }>,
    ) => {
      if (event.data.requestId !== layoutRequestRef.current) return;
      setNodes((current) =>
        current.map((node) => ({
          ...node,
          position: event.data.positions[node.id] ?? node.position,
        })),
      );
      requestAnimationFrame(() => {
        flowRef.current?.fitView({ padding: 0.16, duration: 250 });
      });
    };
    layoutWorkerRef.current = worker;
    return () => {
      worker.terminate();
      layoutWorkerRef.current = null;
    };
  }, [setNodes]);

  const submitCommand = useCallback(
    (command: GraphCommand) => {
      if (!applyCommands) return;
      applyCommands([command]).catch(console.error);
    },
    [applyCommands],
  );

  const selectNode = useCallback((nodeId: string | null) => {
    if (selectedNodeIdRef.current === nodeId) return;
    selectedNodeIdRef.current = nodeId;
    onNodeSelectRef.current?.(nodeId);
  }, []);

  const handleSelectionChange = useCallback(
    (params: { nodes: ReactFlowNode[]; edges: ReactFlowEdge[] }) => {
      const nodeId = params.nodes[0]?.id ?? null;
      selectNode(nodeId);
      setSelectedEdgeId(nodeId ? null : (params.edges[0]?.id ?? null));
    },
    [selectNode],
  );

  const handlePaneClick = useCallback(() => {
    selectNode(null);
    setSelectedEdgeId(null);
  }, [selectNode]);

  useEffect(() => {
    if (!snapshot) return;

    const rfNodes: ReactFlowNode[] = snapshot.nodes.map((n) => {
      const status = nodeRuns?.[n.node_id]?.status;
      const appearance = nodeAppearance(status);
      const statusText = status ? ` [${t(`tasks.workbench.status.${status}`)}]` : "";

      return {
        id: n.node_id,
        selected: selectedNodeIdRef.current === n.node_id,
        data: {
          label: `${n.title}\n(${t(`tasks.workbench.nodeKinds.${n.node_kind}`)})${statusText}`,
        },
        position: { x: 0, y: 0 },
        targetPosition: Position.Left,
        sourcePosition: Position.Right,
        style: {
          border: `2px solid ${appearance.borderColor}`,
          padding: 10,
          borderRadius: 5,
          background: appearance.background,
          color: "#fff",
          width: nodeWidth,
          boxShadow: appearance.boxShadow,
          transition: "all 0.3s ease"
        },
      };
    });

    const rfEdges: ReactFlowEdge[] = snapshot.edges.map((e) => {
      const color = e.kind === "control_dependency" ? "#f43f8d" : "#22d3a7";
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
        labelStyle: { fill: "#e2e8f0", fontSize: 12, fontWeight: 600 },
        labelShowBg: true,
        labelBgStyle: { fill: "#0f172a", fillOpacity: 0.92 },
        labelBgPadding: [6, 4] as [number, number],
        labelBgBorderRadius: 5,
        style: {
          stroke: color,
          strokeWidth: 2,
        },
      };
    });

    setNodes((current) => {
      const currentPositions = new Map(
        current.map((node) => [node.id, node.position] as const),
      );
      return rfNodes.map((node) => ({
        ...node,
        position: currentPositions.get(node.id) ?? node.position,
      }));
    });
    setEdges(rfEdges);
    const requestId = layoutRequestRef.current + 1;
    layoutRequestRef.current = requestId;
    layoutWorkerRef.current?.postMessage({
      requestId,
      nodes: rfNodes.map((node) => node.id),
      edges: rfEdges.map((edge) => ({ source: edge.source, target: edge.target })),
      direction: "LR",
      nodeWidth,
      nodeHeight,
    });
  }, [snapshot, setNodes, setEdges, t]);

  useEffect(() => {
    setNodes((currentNodes) => {
      let changed = false;
      const nextNodes = currentNodes.map((node) => {
        const selected = node.id === selectedNodeId;
        if (node.selected === selected) return node;
        changed = true;
        return { ...node, selected };
      });
      return changed ? nextNodes : currentNodes;
    });
  }, [selectedNodeId, setNodes]);

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
      snapshot?.nodes.map((candidate) => [candidate.node_id, candidate]) ?? [],
    );
    setNodes((currentNodes) =>
      currentNodes.map((node) => {
        const graphNode = graphNodes.get(node.id);
        if (!graphNode) return node;
        const status = nodeRuns?.[node.id]?.status;
        const appearance = nodeAppearance(status);
        const statusText = status ? ` [${t(`tasks.workbench.status.${status}`)}]` : "";
        return {
          ...node,
          data: {
            label: `${graphNode.title}\n(${t(`tasks.workbench.nodeKinds.${graphNode.node_kind}`)})${statusText}`,
          },
          style: {
            ...node.style,
            border: `2px solid ${appearance.borderColor}`,
            background: appearance.background,
            boxShadow: appearance.boxShadow,
          },
        };
      }),
    );
  }, [nodeRuns, setNodes, snapshot, t]);

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
      if (!applyCommands) return;
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
    [applyCommands, snapshot],
  );

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={connectNodes}
        onDelete={({ nodes: deletedNodes, edges: deletedEdges }) =>
          deleteSelection(deletedNodes, deletedEdges)
        }
        nodesConnectable
        nodesDraggable
        elementsSelectable
        deleteKeyCode={["Backspace", "Delete"]}
        onSelectionChange={handleSelectionChange}
        onPaneClick={handlePaneClick}
        onInit={(instance) => {
          flowRef.current = instance;
        }}
        fitView
        colorMode="dark"
      >
        <Controls />
        <MiniMap />
        <Background gap={12} size={1} />
        <div className="absolute top-4 left-4 z-10 flex gap-2">
          {startRun && (
            <button
              className="px-4 py-2 bg-green-600 text-white text-sm rounded shadow cursor-pointer hover:bg-green-700"
              onClick={() => startRun().catch(console.error)}
              disabled={!!activeRunId}
            >
              {activeRunId ? t("tasks.workbench.runStarted") : t("tasks.workbench.startRun")}
            </button>
          )}
          {generateProposal && (
            <button
              type="button"
              className="rounded border border-violet-400/50 bg-violet-950/80 px-4 py-2 text-sm text-violet-100 shadow hover:border-violet-300 hover:bg-violet-900 disabled:cursor-not-allowed disabled:opacity-50"
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
              className="rounded border border-cyan-400/60 bg-cyan-950/80 px-4 py-2 text-sm font-medium text-cyan-100 shadow hover:border-cyan-300 hover:bg-cyan-900 disabled:cursor-not-allowed disabled:opacity-40"
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
            className="rounded border border-slate-600 bg-slate-950/90 px-3 py-2 text-sm text-slate-100 shadow hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => undo?.().catch(console.error)}
            disabled={!canUndo}
            title={`${t("tasks.workbench.undo")} (Ctrl/Cmd+Z)`}
          >
            {t("tasks.workbench.undo")}
          </button>
          <button
            type="button"
            className="rounded border border-slate-600 bg-slate-950/90 px-3 py-2 text-sm text-slate-100 shadow hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => redo?.().catch(console.error)}
            disabled={!canRedo}
            title={`${t("tasks.workbench.redo")} (Ctrl/Cmd+Shift+Z)`}
          >
            {t("tasks.workbench.redo")}
          </button>
          {activeRunId && runStatus === "running" && pauseRun && (
            <button
              className="rounded bg-amber-600 px-4 py-2 text-sm text-white shadow hover:bg-amber-700"
              onClick={() => pauseRun().catch(console.error)}
            >
              {t("tasks.workbench.pauseRun")}
            </button>
          )}
          {activeRunId && ["paused", "awaiting_human"].includes(runStatus ?? "") && resumeRun && (
            <button
              className="rounded bg-blue-600 px-4 py-2 text-sm text-white shadow hover:bg-blue-700"
              onClick={() => resumeRun().catch(console.error)}
            >
              {t("tasks.workbench.resumeRun")}
            </button>
          )}
          {activeRunId && cancelRun && (
            <button
              className="rounded bg-red-600 px-4 py-2 text-sm text-white shadow hover:bg-red-700"
              onClick={() => cancelRun().catch(console.error)}
            >
              {t("tasks.workbench.cancelRun")}
            </button>
          )}
          <button
            className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground shadow hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
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
            className="rounded border border-cyan-400/50 bg-slate-950/90 px-4 py-2 text-sm text-cyan-100 shadow hover:border-cyan-300 hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => setShowDispatchForm(true)}
          >
            {t("tasks.workbench.addAgentStep")}
          </button>
        </div>
      </ReactFlow>
      {selectedEdgeId && snapshot && (
        <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-4 rounded-xl border border-cyan-300/25 bg-slate-950/95 px-4 py-3 text-sm text-slate-200 shadow-2xl">
          {(() => {
            const edge = snapshot.edges.find((candidate) => candidate.edge_id === selectedEdgeId);
            if (!edge) return null;
            const source = snapshot.nodes.find((node) => node.node_id === edge.source_node_id);
            const target = snapshot.nodes.find((node) => node.node_id === edge.target_node_id);
            return (
              <>
                <span className="font-medium">
                  {source?.title ?? edge.source_node_id}
                  <span className="px-2 text-cyan-300">→</span>
                  {target?.title ?? edge.target_node_id}
                </span>
                <span className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-300">
                  {t(`tasks.workbench.edgeKinds.${edge.kind}`)}
                </span>
                <button
                  type="button"
                  className="rounded border border-rose-400/40 px-3 py-1.5 text-rose-200 hover:bg-rose-500/10"
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
        <div className="absolute inset-0 z-30 grid place-items-center bg-slate-950/70 p-6 backdrop-blur-sm">
          <form
            className="w-full max-w-lg rounded-xl border border-cyan-400/30 bg-slate-950 p-5 shadow-2xl shadow-cyan-950/50"
            onSubmit={(event) => {
              event.preventDefault();
              if (!dispatchTitle.trim() || !dispatchPrompt.trim()) return;
              const goalNode = snapshot?.nodes.find((node) => node.node_kind === "goal");
              submitCommand({
                op: "add_node",
                command_id: `cmd_${crypto.randomUUID()}`,
                node: {
                  node_id: `node_${crypto.randomUUID()}`,
                  parent_id: goalNode?.node_id ?? null,
                  title: dispatchTitle.trim(),
                  description: dispatchPrompt.trim(),
                  node_kind: "executable",
                  input_contract: { description: null, artifacts: [], schema: null },
                  output_contract: { description: null, artifacts: [], schema: null },
                  role_requirement: {
                    role_id: "implementer",
                    responsibility: dispatchTitle.trim(),
                    required_capabilities: [],
                    preferred_capabilities: [],
                  },
                  capability_requirements: [],
                  agent_assignment_constraint: null,
                  policy: {
                    approval_policy: "on_high_risk",
                    permission_scope: {
                      can_read_files: true,
                      can_write_files: false,
                      can_run_commands: false,
                      can_access_network: false,
                      can_deploy: false,
                    },
                  },
                  metadata: {},
                  executable_payload: {
                    type: "dispatch",
                    role_id: "implementer",
                    prompt: dispatchPrompt.trim(),
                    project: null,
                    session: null,
                  },
                  loop_config: null,
                  approval_gate_config: null,
                },
              });
              setDispatchTitle("");
              setDispatchPrompt("");
              setShowDispatchForm(false);
            }}
          >
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">
              {t("tasks.workbench.agentStepEyebrow")}
            </div>
            <h3 className="mt-2 text-xl font-semibold text-slate-50">
              {t("tasks.workbench.addAgentStep")}
            </h3>
            <label className="mt-5 block text-xs font-medium text-slate-300">
              {t("tasks.workbench.stepTitle")}
              <input
                autoFocus
                value={dispatchTitle}
                onChange={(event) => setDispatchTitle(event.target.value)}
                className="mt-2 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-cyan-400"
              />
            </label>
            <label className="mt-4 block text-xs font-medium text-slate-300">
              {t("tasks.workbench.stepPrompt")}
              <textarea
                rows={6}
                value={dispatchPrompt}
                onChange={(event) => setDispatchPrompt(event.target.value)}
                className="mt-2 w-full resize-y rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-cyan-400"
              />
            </label>
            <p className="mt-3 text-xs leading-5 text-slate-400">
              {t("tasks.workbench.connectHint")}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-900"
                onClick={() => setShowDispatchForm(false)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                disabled={!dispatchTitle.trim() || !dispatchPrompt.trim()}
                className="rounded bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-300 disabled:opacity-40"
              >
                {t("tasks.workbench.createStep")}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
