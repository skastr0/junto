import { useCallback, useEffect } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import type { Connection, Node } from "@xyflow/react";
import { use$ } from "@legendapp/state/react";
import { state$ } from "../lib/state";
import type { FlowEdge, FlowNode } from "../lib/convert";
import { toFlow } from "../lib/convert";
import { addEdge, addNode, makeTextNode, syncPositions } from "../lib/mutations";
import { GROUND, HUE } from "../lib/theme";
import { nodeTypes } from "./nodes";
import { edgeTypes } from "./edges/EtherEdge";

const miniMapNodeColor = (node: Node): string => {
  const data = node.data as FlowNode["data"] | undefined;
  if (data?.node.ether?.flags?.includes("blocker")) return HUE.crimson;
  if (data?.node.type === "group") return "rgba(143,163,176,0.25)";
  return "rgba(232,163,61,0.5)";
};

export function Canvas() {
  const docVersion = use$(state$.docVersion);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const rf = useReactFlow<FlowNode, FlowEdge>();

  // Rebuild the RF graph whenever the document changes structurally.
  useEffect(() => {
    const built = toFlow(state$.doc.peek());
    setNodes(built.nodes);
    setEdges(built.edges);
  }, [docVersion, setNodes, setEdges]);

  const onConnect = useCallback((connection: Connection) => {
    addEdge(connection);
  }, []);

  const onNodeDragStop = useCallback(() => {
    const positions = new Map<string, { x: number; y: number }>();
    for (const node of rf.getNodes()) positions.set(node.id, node.position);
    syncPositions(positions);
  }, [rf]);

  const onDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      const target = event.target as HTMLElement;
      // Only fire on empty pane, not on a node.
      if (target.closest(".react-flow__node")) return;
      if (!target.closest(".react-flow__pane") && !target.classList.contains("react-flow__pane")) {
        return;
      }
      const pos = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      addNode(makeTextNode(pos.x - 120, pos.y - 50));
    },
    [rf],
  );

  return (
    <div className="h-full w-full" onDoubleClick={onDoubleClick}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={onNodeDragStop}
        deleteKeyCode={null}
        elevateNodesOnSelect={false}
        elevateEdgesOnSelect
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1.1 }}
        minZoom={0.15}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        style={{ background: GROUND }}
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={1} color="rgba(237,230,218,0.07)" />
        <MiniMap
          pannable
          zoomable
          nodeColor={miniMapNodeColor}
          maskColor="rgba(12,11,10,0.72)"
          style={{ background: "rgba(12,11,10,0.9)", border: "1px solid rgba(237,230,218,0.1)" }}
        />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
