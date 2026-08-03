// design-sync harness: a React Flow stage that shares the bundle's single
// @xyflow/react instance, so canvas nodes (NodeShell, TextNode, …) render
// truthfully outside the app. A preview importing its own React Flow copy
// would create a second context and break Handle/NodeResizer — always stage
// canvas nodes through this. Non-interactive: preview optics only.
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import type { Edge, EdgeTypes, Node, NodeTypes } from "@xyflow/react";
import type { ReactNode } from "react";
import type { CanvasDoc } from "@shared/canvas";
import type { ExecutionSnapshot } from "@shared/ipc";
import { state$ } from "../src/renderer/lib/state";
import { kernel$ } from "../src/renderer/lib/kernel-view";

// design-sync harness: seeds the bundle's OWN global stores before children
// render. This works only because ds-extras is compiled INTO _ds_bundle.js —
// it closes over the same state$/kernel$ instances the components read.
// (A preview importing lib/state directly gets a second, disconnected copy —
// the store trap; see NOTES.md.) Store-fed surfaces (InspectorPanel,
// EdgeCommandCard, StoppageRank, KindStrip, KindSurface, capability/relay
// toggles) render their real populated states only inside this wrapper.
export function SeedState({
  doc,
  selectedNodeId,
  selectedEdgeId,
  execution,
  children,
}: {
  readonly doc?: CanvasDoc;
  readonly selectedNodeId?: string;
  readonly selectedEdgeId?: string;
  readonly execution?: ExecutionSnapshot;
  readonly children: ReactNode;
}) {
  if (doc !== undefined) state$.doc.set(doc);
  if (selectedNodeId !== undefined) state$.selectedNodeId.set(selectedNodeId);
  if (selectedEdgeId !== undefined) state$.selectedEdgeId.set(selectedEdgeId);
  if (execution !== undefined) kernel$.execution.set(execution);
  return <>{children}</>;
}

export function CanvasStage({
  nodes,
  edges = [],
  nodeTypes,
  edgeTypes,
  height = 340,
}: {
  readonly nodes: ReadonlyArray<Node>;
  readonly edges?: ReadonlyArray<Edge>;
  readonly nodeTypes?: NodeTypes;
  readonly edgeTypes?: EdgeTypes;
  readonly height?: number;
}) {
  return (
    <div
      className="bg-ground"
      style={{ height, width: "100%", position: "relative", overflow: "hidden" }}
    >
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes as Node[]}
          edges={edges as Edge[]}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          nodesDraggable={false}
          nodesConnectable={false}
          zoomOnScroll={false}
          panOnDrag={false}
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
