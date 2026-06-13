import dagre from "dagre";

/**
 * Pure, transport-agnostic graph layout (design §13.2). Extracted from
 * `graph-editor.tsx` so it can run inside a Web Worker (keeping the main thread
 * free for 500-node canvases) and be unit-tested without React/xyflow.
 *
 * Layout is a pure UI concern — coordinates never enter `GraphRevision`.
 */

export const LAYOUT_NODE_WIDTH = 200;
export const LAYOUT_NODE_HEIGHT = 60;

export interface LayoutNode {
  id: string;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

export type LayoutResult = Record<string, { x: number; y: number }>;

export interface LayoutGraph {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
}

/** Compute a left-to-right hierarchical layout, returning center-offset positions. */
export function computeLayout(graph: LayoutGraph): LayoutResult {
  return computeLayoutWithOptions(graph, {
    rankdir: "LR",
    ranksep: 150,
    nodesep: 90,
    edgesep: 35,
    marginx: 40,
    marginy: 40,
  });
}

/** Layout with explicit dagre options (used by tests to pin direction). */
export function computeLayoutWithOptions(
  graph: LayoutGraph,
  options: {
    rankdir: "LR" | "TB";
    ranksep: number;
    nodesep: number;
    edgesep: number;
    marginx: number;
    marginy: number;
  },
): LayoutResult {
  if (graph.nodes.length === 0) return {};
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph(options);
  for (const node of graph.nodes) {
    dagreGraph.setNode(node.id, { width: LAYOUT_NODE_WIDTH, height: LAYOUT_NODE_HEIGHT });
  }
  for (const edge of graph.edges) {
    dagreGraph.setEdge(edge.source, edge.target);
  }
  dagre.layout(dagreGraph);
  const positions: LayoutResult = {};
  for (const node of graph.nodes) {
    const position = dagreGraph.node(node.id);
    if (!position) continue;
    positions[node.id] = {
      x: position.x - LAYOUT_NODE_WIDTH / 2,
      y: position.y - LAYOUT_NODE_HEIGHT / 2,
    };
  }
  return positions;
}
