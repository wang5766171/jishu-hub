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
import type { GraphCommand, GraphSnapshot, NodeRun, NodeRunStatus } from "./use-task-graph";

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

interface GraphEditorProps {
  snapshot: GraphSnapshot | null;
  graphId?: string | null;
  currentRevisionId?: string | null;
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
  graphId,
  currentRevisionId,
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
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(1);
  const [dispatchIntent, setDispatchIntent] = useState<"implement" | "research" | "verify">("implement");
  const [dispatchTitle, setDispatchTitle] = useState("");
  const [dispatchPrompt, setDispatchPrompt] = useState("");
  const [dispatchAcceptance, setDispatchAcceptance] = useState("");
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [phaseFilterId, setPhaseFilterId] = useState<string | null>(null);
  const [semanticZoom, setSemanticZoom] = useState<"detail" | "compact" | "map">("detail");
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
      const label = semanticZoom === "map"
        ? n.title
        : semanticZoom === "compact"
          ? `${n.title}${statusText}`
          : `${n.title}\n(${nodeKindText})${statusText}`;

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
          color: "#fff",
          width: LAYOUT_NODE_WIDTH,
          boxShadow: appearance.boxShadow,
          transition: "all 0.3s ease"
        },
      };
    });

    const rfEdges: ReactFlowEdge[] = visibleSnapshot.edges.map((e) => {
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
  }, [visibleSnapshot, semanticZoom, setNodes, setEdges, t]);

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
        const label = semanticZoom === "map"
          ? graphNode.title
          : semanticZoom === "compact"
            ? `${graphNode.title}${statusText}`
            : `${graphNode.title}\n(${nodeKindText})${statusText}`;
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
            boxShadow: appearance.boxShadow,
          },
        };
      }),
    );
  }, [nodeRuns, semanticZoom, setNodes, visibleSnapshot, t]);

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
    <div
      className="relative h-full w-full"
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
        nodesConnectable
        nodesDraggable
        elementsSelectable
        deleteKeyCode={["Backspace", "Delete"]}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        onPaneClick={handlePaneClick}
        onMoveEnd={handleMoveEnd}
        onNodeDragStop={handleNodeDragStop}
        onInit={(instance) => {
          flowRef.current = instance;
        }}
        colorMode="dark"
      >
        <Controls />
        <MiniMap />
        <Background gap={12} size={1} />
        <div className="absolute top-4 right-4 z-10 flex max-w-[42rem] flex-wrap items-center justify-end gap-2">
          <div className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950/90 px-3 py-2 text-xs text-slate-200 shadow">
            <span className="text-slate-400">
              {t("tasks.workbench.revisionStatus.revision")}
            </span>
            <span className="font-mono text-slate-50">
              {currentRevisionId ?? "-"}
            </span>
            <span
              className={cn(
                "rounded px-2 py-0.5 font-medium",
                canUndo
                  ? "bg-amber-400/15 text-amber-200"
                  : "bg-emerald-400/15 text-emerald-200",
              )}
            >
              {canUndo
                ? t("tasks.workbench.revisionStatus.dirty")
                : t("tasks.workbench.revisionStatus.clean")}
            </span>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950/90 px-3 py-2 text-xs text-slate-200 shadow">
            <span className="text-slate-400">
              {t("tasks.workbench.semanticZoom.label")}
            </span>
            <span className="font-medium">
              {t(`tasks.workbench.semanticZoom.${semanticZoom}`)}
            </span>
          </div>
          {phaseNodes.length > 0 && (
            <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-lg border border-slate-700 bg-slate-950/90 p-1 shadow">
              <button
                type="button"
                className={cn(
                  "h-7 shrink-0 rounded px-2 text-xs transition",
                  !phaseFilterId
                    ? "bg-cyan-400 text-slate-950"
                    : "text-slate-200 hover:bg-slate-800",
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
                      ? "bg-cyan-400 text-slate-950"
                      : "text-slate-200 hover:bg-slate-800",
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
              if (wizardStep < 3) {
                setWizardStep((current) => (current === 1 ? 2 : 3));
                return;
              }
              if (!dispatchTitle.trim() || !dispatchPrompt.trim() || !dispatchAcceptance.trim()) return;
              const goalNode = snapshot?.nodes.find((node) => node.node_kind === "goal");
              const prompt = [
                `${t("tasks.workbench.nodeWizard.intent")}: ${t(`tasks.workbench.nodeWizard.intents.${dispatchIntent}`)}`,
                dispatchPrompt.trim(),
                `${t("tasks.workbench.nodeWizard.acceptance")}: ${dispatchAcceptance.trim()}`,
              ].join("\n\n");
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
                  output_contract: { description: dispatchAcceptance.trim(), artifacts: [], schema: null },
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
                  metadata: {
                    intent: dispatchIntent,
                  },
                  executable_payload: {
                    type: "dispatch",
                    role_id: "implementer",
                    prompt,
                    project: null,
                    session: null,
                  },
                  loop_config: null,
                  approval_gate_config: null,
                },
              });
              setWizardStep(1);
              setDispatchIntent("implement");
              setDispatchTitle("");
              setDispatchPrompt("");
              setDispatchAcceptance("");
              setShowDispatchForm(false);
            }}
          >
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">
              {t("tasks.workbench.nodeWizard.step", { current: wizardStep, total: 3 })}
            </div>
            <h3 className="mt-2 text-xl font-semibold text-slate-50">
              {t("tasks.workbench.nodeWizard.title")}
            </h3>
            {wizardStep === 1 && (
              <div className="mt-5 grid gap-2">
                {(["implement", "research", "verify"] as const).map((intent) => (
                  <button
                    key={intent}
                    type="button"
                    className={cn(
                      "rounded-lg border px-4 py-3 text-left text-sm transition",
                      dispatchIntent === intent
                        ? "border-cyan-300 bg-cyan-400/15 text-cyan-50"
                        : "border-slate-700 bg-slate-900 text-slate-200 hover:border-slate-500",
                    )}
                    onClick={() => setDispatchIntent(intent)}
                  >
                    {t(`tasks.workbench.nodeWizard.intents.${intent}`)}
                  </button>
                ))}
              </div>
            )}
            {wizardStep === 2 && (
              <>
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
                    rows={5}
                    value={dispatchPrompt}
                    onChange={(event) => setDispatchPrompt(event.target.value)}
                    className="mt-2 w-full resize-y rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-cyan-400"
                  />
                </label>
                <label className="mt-4 block text-xs font-medium text-slate-300">
                  {t("tasks.workbench.nodeWizard.acceptance")}
                  <textarea
                    rows={3}
                    value={dispatchAcceptance}
                    onChange={(event) => setDispatchAcceptance(event.target.value)}
                    className="mt-2 w-full resize-y rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-cyan-400"
                  />
                </label>
              </>
            )}
            {wizardStep === 3 && (
              <div className="mt-5 space-y-3 rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-slate-200">
                <div>
                  <span className="text-slate-400">{t("tasks.workbench.nodeWizard.intent")}: </span>
                  {t(`tasks.workbench.nodeWizard.intents.${dispatchIntent}`)}
                </div>
                <div>
                  <span className="text-slate-400">{t("tasks.workbench.stepTitle")}: </span>
                  {dispatchTitle || "-"}
                </div>
                <div>
                  <span className="text-slate-400">{t("tasks.workbench.nodeWizard.acceptance")}: </span>
                  {dispatchAcceptance || "-"}
                </div>
              </div>
            )}
            <p className="mt-3 text-xs leading-5 text-slate-400">
              {t("tasks.workbench.connectHint")}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-900"
                onClick={() => {
                  setShowDispatchForm(false);
                  setWizardStep(1);
                }}
              >
                {t("common.cancel")}
              </button>
              {wizardStep > 1 && (
                <button
                  type="button"
                  className="rounded border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-900"
                  onClick={() => setWizardStep((current) => (current === 3 ? 2 : 1))}
                >
                  {t("tasks.workbench.nodeWizard.back")}
                </button>
              )}
              <button
                type="submit"
                disabled={
                  wizardStep === 2 &&
                  (!dispatchTitle.trim() || !dispatchPrompt.trim() || !dispatchAcceptance.trim())
                }
                className="rounded bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-300 disabled:opacity-40"
              >
                {wizardStep === 3
                  ? t("tasks.workbench.createStep")
                  : t("tasks.workbench.nodeWizard.next")}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
