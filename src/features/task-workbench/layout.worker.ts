import dagre from "dagre";

interface LayoutRequest {
  requestId: number;
  nodes: string[];
  edges: Array<{ source: string; target: string }>;
  direction: "TB" | "LR";
  nodeWidth: number;
  nodeHeight: number;
}

interface LayoutResponse {
  requestId: number;
  positions: Record<string, { x: number; y: number }>;
}

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const request = event.data;
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: request.direction,
    ranksep: 150,
    nodesep: 90,
    edgesep: 35,
    marginx: 40,
    marginy: 40,
  });

  for (const nodeId of request.nodes) {
    graph.setNode(nodeId, {
      width: request.nodeWidth,
      height: request.nodeHeight,
    });
  }
  for (const edge of request.edges) {
    graph.setEdge(edge.source, edge.target);
  }
  dagre.layout(graph);

  const positions: LayoutResponse["positions"] = {};
  for (const nodeId of request.nodes) {
    const position = graph.node(nodeId);
    positions[nodeId] = {
      x: position.x - request.nodeWidth / 2,
      y: position.y - request.nodeHeight / 2,
    };
  }
  self.postMessage({ requestId: request.requestId, positions } satisfies LayoutResponse);
};
