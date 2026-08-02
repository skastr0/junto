import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ControlButton,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  SelectionMode,
  useConnection,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import type { Connection, FinalConnectionState, Node, OnNodeDrag } from "@xyflow/react";
import { use$ } from "@legendapp/state/react";
import type { CanvasDoc, EtherEdgeKind, EtherFlag } from "@shared/canvas";
import { executionGraphContextFromActorRefs } from "@shared/graph";
import { Ban, Boxes, Expand, Link2, Plus, ScanLine, SquareDashed, Trash2, X } from "lucide-react";
import { state$ } from "../lib/state";
import { kernel$ } from "../lib/kernel-view";
import type { FlowEdge, FlowNode } from "../lib/convert";
import { createFlowIdentityCache, searchText, toFlow } from "../lib/convert";
import {
  edgeImpactClass,
  edgeImpactRole,
  connectionFocusSelection,
  impactModeActive$,
  nodeImpactClass,
  selectionImpact,
  type ImpactSelection,
} from "../lib/impact-mode";
import { markViewportBusy, releaseViewportBusy, viewportBusy$ } from "../lib/viewport-busy";
import { nodeTitle } from "../lib/presentation";
import { AGENT_NODE_SIZE } from "../lib/node-geometry";
import { addNode, deleteNodes, setFlagForNodes } from "../lib/mutations";
import { addEdge, connectAllToTarget, deleteEdges } from "../lib/edge-mutations";
import { dragHoldMemberIds, findOpenPosition, syncPositions } from "../lib/geometry";
import { resolvePageSpawnDefaults } from "@shared/region-defaults";
import { resolveAuthoredPageHost } from "../lib/page-authoring";
import "../styles/factory-grammar.css";
import {
  makeArtifactsNode,
  makeBoardNode,
  makeCronNode,
  makeFileNode,
  makeGaugeNode,
  makeGroupNode,
  makeLabelNode,
  makeLinkNode,
  makeManagedAgentNode,
  makePageNode,
  makeRelayNode,
  makeRequestsNode,
  makeTasksNode,
  makeTextNode,
} from "../lib/node-factories";
import { openHerdrWizard } from "../lib/herdr-state";
import { describeConnectPreview } from "../lib/connect-preview";
import { GROUND, HUE } from "../lib/theme";
import type { MemberSeverity } from "@shared/region-rollup";
import { minimapFill, signalMark } from "../lib/signal-mark";
import { nodeTypes } from "./nodes";
import { edgeTypes } from "./edges/EtherEdge";
import { RtsBottomBar } from "./rts/RtsBottomBar";
import { TerminalWizard } from "./terminal/TerminalWizard";
import { CanvasMagnifier } from "./CanvasMagnifier";
import { NodePaletteModeDeck, type ModeDeckActions } from "./node-palette/NodePaletteModeDeck";
import { FocusSurface } from "./FocusSurface";
import { IconButton, OverlayHeader } from "./ui";

type CanvasNodeRef = { readonly id: string; readonly type?: string; readonly position: { readonly x: number; readonly y: number }; readonly data?: unknown; readonly selected?: boolean };
type CanvasFlow = {
  readonly fitView: (options?: { readonly nodes?: Array<CanvasNodeRef>; readonly padding?: number; readonly duration?: number; readonly maxZoom?: number }) => Promise<boolean>;
  readonly getNode: (id: string) => CanvasNodeRef | undefined;
  readonly getNodes: () => ReadonlyArray<CanvasNodeRef>;
  readonly screenToFlowPosition: (position: { readonly x: number; readonly y: number }) => { readonly x: number; readonly y: number };
};

const fitReadableField = (rf: CanvasFlow, duration = 320): void => {
  const graphNodes = rf.getNodes();
  const regions = graphNodes.filter((node) => node.type === "group");
  const meaningfulRegions = regions.filter((node) => {
    const label = ((node.data as { readonly node?: { readonly label?: string } } | undefined)?.node?.label ?? "").trim().toLowerCase();
    return Boolean(label) && !["n", "new region", "unnamed region"].includes(label);
  });
  const anchors = meaningfulRegions.length > 0 ? meaningfulRegions : regions.length > 0 ? regions : graphNodes.slice(0, 24);
  void rf.fitView({ nodes: anchors, padding: 0.18, duration, maxZoom: regions.length > 0 ? 1.15 : 1.35 }).catch(() => undefined);
};

/** Apply/clear in-cone impact token without reminting when unchanged. */
const withEdgeImpact = (
  data: FlowEdge["data"],
  role: "in" | undefined,
): FlowEdge["data"] => {
  if (!data) return data;
  if (data.impact === role) return data;
  if (role) return { ...data, impact: role };
  const { impact: _drop, ...rest } = data;
  return rest;
};

const currentExecutionGraphContext = () =>
  executionGraphContextFromActorRefs(
    state$.canvasName.peek(),
    state$.actorRefs.peek(),
  );

const selectionForCanvas = (
  selectedNodeId: string,
  context: ReturnType<typeof currentExecutionGraphContext>,
): ImpactSelection => {
  const connectionFocusNodeId = state$.connectionFocusNodeId.peek();
  if (connectionFocusNodeId) {
    return connectionFocusSelection(state$.doc.peek(), connectionFocusNodeId);
  }
  return selectedNodeId
    ? selectionImpact(
        state$.doc.peek(),
        selectedNodeId,
        kernel$.execution.peek(),
        context,
      )
    : selectionImpact(state$.doc.peek(), "", null, context);
};

const projectRuntimeFlagOverrides = (
  doc: CanvasDoc,
  overrides: Readonly<
    Record<string, Partial<Record<EtherFlag, boolean>>>
  >,
): CanvasDoc => ({
  ...doc,
  nodes: doc.nodes.map((node) => {
    const nodeOverrides = overrides[node.id];
    if (nodeOverrides === undefined) return node;
    const flags = new Set(node.ether?.flags ?? []);
    for (const [flag, enabled] of Object.entries(nodeOverrides) as Array<
      [EtherFlag, boolean | undefined]
    >) {
      if (enabled) flags.add(flag);
      else flags.delete(flag);
    }
    const ether = { ...(node.ether ?? {}) };
    if (flags.size === 0) delete ether.flags;
    else ether.flags = [...flags];
    if (Object.keys(ether).length > 0) return { ...node, ether };
    const { ether: _drop, ...withoutEther } = node;
    return withoutEther;
  }),
});

function stampImpactShell(
  nodes: FlowNode[],
  edges: FlowEdge[],
  selectedNodeId: string,
  selectedEdgeId: string,
): { nodes: FlowNode[]; edges: FlowEdge[]; impact: ImpactSelection } {
  const context = currentExecutionGraphContext();
  const impact = selectionForCanvas(selectedNodeId, context);
  if (impactModeActive$.peek() !== impact.active) impactModeActive$.set(impact.active);
  return {
    impact,
    nodes: nodes.map((node) => {
      const selected = node.id === selectedNodeId;
      const className = nodeImpactClass(impact.active, impact.cone, node.id);
      if (node.selected === selected && node.className === className) return node;
      return { ...node, selected, className };
    }),
    edges: edges.map((edge) => {
      const selected = edge.id === selectedEdgeId;
      const className = edgeImpactClass(impact.active, impact.cone, edge.id);
      const role = edgeImpactRole(impact.active, impact.cone, edge.id);
      if (
        edge.selected === selected &&
        edge.className === className &&
        edge.data?.impact === role
      ) {
        return edge;
      }
      return {
        ...edge,
        selected,
        className,
        data: withEdgeImpact(edge.data, role),
      };
    }),
  };
}

function applyStructuralRebuild(
  setNodes: ReturnType<typeof useNodesState<FlowNode>>[1],
  setEdges: ReturnType<typeof useEdgesState<FlowEdge>>[1],
  flowCache: ReturnType<typeof createFlowIdentityCache>,
  searchQuery: string,
  edgeFilter: EtherEdgeKind | "",
  flagFilter: EtherFlag | "",
): void {
  const projectedDoc = projectRuntimeFlagOverrides(
    state$.doc.peek(),
    kernel$.flagOverrides.peek(),
  );
  const built = toFlow(
    projectedDoc,
    currentExecutionGraphContext(),
    kernel$.execution.peek(),
    flowCache,
  );
  const nodeId = state$.selectedNodeId.peek();
  const edgeId = state$.selectedEdgeId.peek();
  const visibleNodes = flagFilter
    ? built.nodes.filter((node) => node.type === "group" || node.data?.node.ether?.flags?.includes(flagFilter))
    : built.nodes;
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const filteredEdges = built.edges.filter(
    (edge) =>
      visibleIds.has(edge.source) &&
      visibleIds.has(edge.target) &&
      (!edgeFilter || (edge.data?.phase ?? edge.data?.edge.ether?.kind ?? "relates") === edgeFilter),
  );
  // Selection + impact cone classes live on the RF shell (not Flow data).
  const stamped = stampImpactShell(visibleNodes, filteredEdges, nodeId, edgeId);
  const query = searchQuery.trim().toLowerCase();
  const nextNodes = query
    ? stamped.nodes.filter((flowNode) => searchText(flowNode.data.node).includes(query))
    : stamped.nodes;
  const queryVisibleIds = query ? new Set(nextNodes.map((flowNode) => flowNode.id)) : null;
  const nextEdges = queryVisibleIds
    ? stamped.edges.filter((edge) => queryVisibleIds.has(edge.source) && queryVisibleIds.has(edge.target))
    : stamped.edges;

  // Preserve array identity when every element is unchanged — kernel ticks with
  // a quiet execution snapshot must not bounce React Flow.
  setNodes((prev) =>
    prev.length === nextNodes.length && prev.every((node, i) => node === nextNodes[i])
      ? prev
      : nextNodes,
  );
  setEdges((prev) =>
    prev.length === nextEdges.length && prev.every((edge, i) => edge === nextEdges[i])
      ? prev
      : nextEdges,
  );
}

function useCanvasDocument(
  searchQuery: string,
  edgeFilter: EtherEdgeKind | "",
  flagFilter: EtherFlag | "",
  setNodes: ReturnType<typeof useNodesState<FlowNode>>[1],
  setEdges: ReturnType<typeof useEdgesState<FlowEdge>>[1],
  dragInProgressRef: React.MutableRefObject<boolean>,
  pendingRebuildRef: React.MutableRefObject<boolean>,
  flowCacheRef: React.MutableRefObject<ReturnType<typeof createFlowIdentityCache>>,
  rebuildTick: number,
) {
  // Keep search input live; rebuild only after pause so keystrokes do not
  // remint the full graph on every character.
  const [debouncedSearch, setDebouncedSearch] = useState(searchQuery);
  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedSearch(searchQuery), 150);
    return () => window.clearTimeout(handle);
  }, [searchQuery]);

  const rebuild = useCallback(() => {
    // Drag + viewport pan both own the RF shell — queue structural remints.
    if (dragInProgressRef.current || viewportBusy$.peek()) {
      pendingRebuildRef.current = true;
      return;
    }
    pendingRebuildRef.current = false;
    applyStructuralRebuild(
      setNodes,
      setEdges,
      flowCacheRef.current,
      debouncedSearch,
      edgeFilter,
      flagFilter,
    );
  }, [
    debouncedSearch,
    edgeFilter,
    flagFilter,
    setNodes,
    setEdges,
    dragInProgressRef,
    pendingRebuildRef,
    flowCacheRef,
  ]);

  // Filter / search / post-drag flush — React-driven.
  useEffect(() => {
    rebuild();
  }, [rebuild, rebuildTick]);

  // Document + kernel ticks — apply via setNodes without re-rendering CanvasGraph.
  // (use$ on these would re-render the whole React Flow tree every cycle.)
  useEffect(() => {
    const offs = [
      state$.docVersion.onChange(() => rebuild()),
      state$.actorRefs.onChange(() => rebuild()),
      kernel$.flagRev.onChange(() => rebuild()),
      kernel$.executionRev.onChange(() => rebuild()),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [rebuild]);

  // Pan/zoom released — flush any rebuild deferred mid-gesture.
  useEffect(() => {
    return viewportBusy$.onChange(() => {
      if (!viewportBusy$.peek() && pendingRebuildRef.current) rebuild();
    });
  }, [rebuild, pendingRebuildRef]);

  // Selection + impact-mode sync — light map over the existing graph.
  // Structural rebuild already stamps on doc/execution ticks; this path is
  // selection-only so CanvasGraph need not subscribe to selected ids.
  useEffect(() => {
    let pendingSelection = false;
    const syncSelection = () => {
      // setNodes during pan forces RF to reconcile the full shell — defer.
      if (viewportBusy$.peek()) {
        pendingSelection = true;
        return;
      }
      pendingSelection = false;
      const selectedNodeId = state$.selectedNodeId.peek();
      const selectedEdgeId = state$.selectedEdgeId.peek();
      const context = currentExecutionGraphContext();
      const impact: ImpactSelection = selectionForCanvas(selectedNodeId, context);
      if (impactModeActive$.peek() !== impact.active) impactModeActive$.set(impact.active);

      setNodes((nodes) => {
        if (!selectedNodeId && nodes.filter((node) => node.selected).length > 1) {
          let dirty = false;
          const next = nodes.map((node) => {
            if (!node.className) return node;
            dirty = true;
            return { ...node, className: undefined };
          });
          return dirty ? next : nodes;
        }
        let dirty = false;
        const next = nodes.map((node) => {
          const selected = node.id === selectedNodeId;
          const className = nodeImpactClass(impact.active, impact.cone, node.id);
          if (node.selected === selected && node.className === className) return node;
          dirty = true;
          return { ...node, selected, className };
        });
        return dirty ? next : nodes;
      });
      setEdges((edges) => {
        let dirty = false;
        const next = edges.map((edge) => {
          const selected = edge.id === selectedEdgeId;
          const className = edgeImpactClass(impact.active, impact.cone, edge.id);
          const role = edgeImpactRole(impact.active, impact.cone, edge.id);
          if (
            edge.selected === selected &&
            edge.className === className &&
            edge.data?.impact === role
          ) {
            return edge;
          }
          dirty = true;
          return {
            ...edge,
            selected,
            className,
            data: withEdgeImpact(edge.data, role),
          };
        });
        return dirty ? next : edges;
      });
    };

    syncSelection();
    const offs = [
      state$.selectedNodeId.onChange(syncSelection),
      state$.selectedEdgeId.onChange(syncSelection),
      state$.connectionFocusNodeId.onChange(syncSelection),
      viewportBusy$.onChange(() => {
        if (!viewportBusy$.peek() && pendingSelection) syncSelection();
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [setNodes, setEdges]);
}

function useCanvasSearchViewport(searchQuery: string, nodeCount: number, rf: CanvasFlow, viewKey: string) {
  const previousQuery = useRef("");
  const previousViewKey = useRef("");
  useEffect(() => {
    const query = searchQuery.trim();
    const hadQuery = previousQuery.current.length > 0;
    const hadFilter = previousViewKey.current.length > 0;
    const filterChanged = previousViewKey.current !== viewKey;
    previousQuery.current = query;
    previousViewKey.current = viewKey;
    if (!query) {
      if (hadQuery || (hadFilter && filterChanged)) {
        const frame = requestAnimationFrame(() => fitReadableField(rf, 260));
        return () => cancelAnimationFrame(frame);
      }
      return;
    }
    if (nodeCount === 0) return;
    const frame = requestAnimationFrame(() => {
      void rf.fitView({ padding: 0.25, duration: 260, maxZoom: 1.5 }).catch(() => undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [searchQuery, nodeCount, rf, viewKey]);
}

function useCanvasFocus(rf: CanvasFlow) {
  useEffect(() => {
    let attempts = 0;
    let frame = 0;
    const run = (focusNodeId: string) => {
      if (!focusNodeId) return;
      attempts = 0;
      const focus = () => {
        const node = rf.getNode(focusNodeId);
        if (!node) {
          attempts += 1;
          if (attempts < 12) frame = requestAnimationFrame(focus);
          else state$.focusNodeId.set("");
          return;
        }
        // React Flow emits an empty selection while the canvas mounts. Re-apply
        // the focus target only after it is present in the live graph.
        state$.selectedNodeId.set(focusNodeId);
        state$.selectedNodeIds.set([focusNodeId]);
        state$.selectedEdgeId.set("");
        void rf.fitView({ nodes: [node], padding: 0.35, maxZoom: 1.45, duration: 360 }).catch(() => undefined).finally(() => {
          state$.selectedNodeId.set(focusNodeId);
          state$.selectedNodeIds.set([focusNodeId]);
          state$.selectedEdgeId.set("");
          state$.focusNodeId.set("");
        });
      };
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(focus);
    };
    run(state$.focusNodeId.peek());
    const off = state$.focusNodeId.onChange(() => run(state$.focusNodeId.peek()));
    return () => {
      cancelAnimationFrame(frame);
      off();
    };
  }, [rf]);
}

function useCanvasViewport(nodeCount: number, rf: CanvasFlow) {
  const fittedCanvasRef = useRef("");
  useEffect(() => {
    let frame = 0;
    const tryFit = () => {
      const canvasName = state$.canvasName.peek();
      if (!canvasName || nodeCount === 0 || fittedCanvasRef.current === canvasName) return;
      fittedCanvasRef.current = canvasName;
      frame = requestAnimationFrame(() => {
        // A dense corpus spanning thousands of flow pixels becomes unreadable
        // if the first frame fits every node. Regions are the spatial index;
        // when none exist, show the first node cluster.
        fitReadableField(rf);
      });
    };
    tryFit();
    const off = state$.canvasName.onChange(() => tryFit());
    return () => {
      cancelAnimationFrame(frame);
      off();
    };
  }, [nodeCount, rf]);
}

function useCanvasInteractions(
  rf: CanvasFlow,
  setNodes: ReturnType<typeof useNodesState<FlowNode>>[1],
  dragInProgressRef: React.MutableRefObject<boolean>,
  pendingRebuildRef: React.MutableRefObject<boolean>,
  flushRebuild: () => void,
) {
  const onConnect = useCallback((connection: Connection) => addEdge(connection), []);
  // Dropping a connection on a card body (not a handle) still creates the
  // edge — the whole node is a legitimate target, the dots are just anchors.
  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
    if (connectionState.isValid) return;
    const from = connectionState.fromNode?.id;
    if (!from) return;
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    if (!point) return;
    const element = document.elementFromPoint(point.clientX, point.clientY);
    const nodeEl = element?.closest?.(".react-flow__node");
    const targetId = nodeEl?.getAttribute("data-id");
    if (!targetId || targetId === from) return;
    const targetNode = state$.doc.peek().nodes.find((node) => node.id === targetId);
    if (!targetNode || targetNode.type === "group") return;
    // Infer criteria from source (tasks → tasks criteria). No static kind.
    addEdge({ source: from, target: targetId, sourceHandle: connectionState.fromHandle?.id });
  }, []);
  // Region hold: dragging a `hold` region moves every node geometrically
  // inside it. Membership is snapshotted at drag start — never stored — and a
  // member that is ITSELF part of the same multi-selection is skipped, since
  // React Flow already translates the rest of a selected group; without that
  // guard a selected member would double-translate.
  const holdDragRef = useRef<{
    readonly regionId: string;
    readonly regionStart: { readonly x: number; readonly y: number };
    readonly startPositions: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
  } | null>(null);
  // End drag: clear latch, optionally stamp RF positions, flush deferred rebuild.
  // Idempotent — safe when both onNodeDragStop and pointerup fire.
  const finishDrag = useCallback((sync: boolean) => {
    if (!dragInProgressRef.current) return;
    holdDragRef.current = null;
    if (sync) {
      const positions = new Map<string, { x: number; y: number }>();
      for (const node of rf.getNodes()) positions.set(node.id, node.position);
      syncPositions(positions);
    }
    dragInProgressRef.current = false;
    if (pendingRebuildRef.current) {
      pendingRebuildRef.current = false;
      flushRebuild();
    }
  }, [rf, dragInProgressRef, pendingRebuildRef, flushRebuild]);

  // Recover from pointercancel / missing dragStop / unmount so rebuilds never stick.
  useEffect(() => {
    const onPointerEnd = () => finishDrag(true);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    return () => {
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      // Unmount mid-drag: drop latch without writing RF positions into a dying tree.
      if (dragInProgressRef.current) {
        dragInProgressRef.current = false;
        holdDragRef.current = null;
        pendingRebuildRef.current = false;
      }
    };
  }, [finishDrag, dragInProgressRef, pendingRebuildRef]);

  const onNodeDragStart: OnNodeDrag<FlowNode> = useCallback((_event, node) => {
    dragInProgressRef.current = true;
    holdDragRef.current = null;
    if (node.data.node.type !== "group" || !node.data.node.ether?.region?.hold) return;
    const doc = state$.doc.peek();
    const regionDoc = doc.nodes.find((n) => n.id === node.id);
    if (!regionDoc || regionDoc.type !== "group") return;
    const startPositions = new Map<string, { x: number; y: number }>();
    for (const id of dragHoldMemberIds(doc, regionDoc)) {
      const member = rf.getNode(id);
      if (!member || member.selected) continue;
      startPositions.set(id, member.position);
    }
    holdDragRef.current = { regionId: node.id, regionStart: node.position, startPositions };
  }, [rf, dragInProgressRef]);
  const onNodeDrag: OnNodeDrag<FlowNode> = useCallback((_event, node) => {
    const drag = holdDragRef.current;
    if (!drag || node.id !== drag.regionId || drag.startPositions.size === 0) return;
    const dx = node.position.x - drag.regionStart.x;
    const dy = node.position.y - drag.regionStart.y;
    setNodes((nodes) => nodes.map((n) => {
      const start = drag.startPositions.get(n.id);
      return start ? { ...n, position: { x: start.x + dx, y: start.y + dy } } : n;
    }));
  }, [setNodes]);
  const onNodeDragStop = useCallback(() => {
    finishDrag(true);
  }, [finishDrag]);
  const onNodesDelete = useCallback((deleted: ReadonlyArray<FlowNode>) => {
    // Deleting mid-drag would otherwise leave the rebuild latch stuck.
    if (dragInProgressRef.current) finishDrag(false);
    deleteNodes(deleted.map((node) => node.id));
  }, [dragInProgressRef, finishDrag]);
  const onEdgesDelete = useCallback((deleted: ReadonlyArray<FlowEdge>) => deleteEdges(deleted.map((edge) => edge.id)), []);
  const onSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges }: { readonly nodes: ReadonlyArray<FlowNode>; readonly edges: ReadonlyArray<FlowEdge> }) => {
    // React Flow emits empty selections while the graph remounts. A pane
    // click is the explicit deselection gesture; do not erase an inspector
    // selection from an internal remount event.
    if (selectedNodes.length === 0 && selectedEdges.length === 0) return;
    const nextSelectedNodeId = selectedNodes.length === 1 ? selectedNodes[0]?.id ?? "" : "";
    if (
      state$.connectionFocusNodeId.peek() &&
      state$.connectionFocusNodeId.peek() !== nextSelectedNodeId
    ) {
      state$.connectionFocusNodeId.set("");
    }
    // Mirror the full RF set for Ctrl+N / command card multi-actions.
    state$.selectedNodeIds.set(selectedNodes.map((node) => node.id));
    // A rubber-band multi-selection has no single inspector subject; keep the
    // inspector closed and let React Flow own the selection set.
    if (selectedNodes.length > 1) {
      state$.selectedNodeId.set("");
      state$.selectedEdgeId.set("");
      return;
    }
    state$.selectedNodeId.set(nextSelectedNodeId);
    state$.selectedEdgeId.set(selectedNodes.length === 0 ? selectedEdges[0]?.id ?? "" : "");
  }, []);
  const onPaneClick = useCallback((event: React.MouseEvent) => {
    if (event.detail === 1) {
      state$.selectedNodeId.set("");
      state$.selectedNodeIds.set([]);
      state$.selectedEdgeId.set("");
      state$.connectionFocusNodeId.set("");
      return;
    }
    if (event.detail !== 2) return;
    const pos = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    addNode(makeTextNode(pos.x - 120, pos.y - 50));
  }, [rf]);
  return { onConnect, onConnectEnd, onNodeDragStart, onNodeDrag, onNodeDragStop, onNodesDelete, onEdgesDelete, onSelectionChange, onPaneClick };
}

// Node creation against a caller-supplied placement strategy — the toolbar
// places near the viewport center, the context menu at the click point.
const makeAddActions = (
  positionFor: (size: { width: number; height: number }) => { x: number; y: number },
  dismiss: () => void,
): ModeDeckActions => ({
  create: (kind) => {
    const size = kind === "text"
      ? { width: 240, height: 100 }
      : kind === "group"
        ? { width: 560, height: 320 }
        : { width: 260, height: 110 };
    const position = positionFor(size);
    const node = kind === "text"
      ? makeTextNode(position.x, position.y)
      : kind === "file"
        ? makeFileNode(position.x, position.y)
        : kind === "link"
          ? makeLinkNode(position.x, position.y)
          : makeGroupNode(position.x, position.y);
    addNode(node);
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addConfiguredAgent: (choices, position) => {
    const node = makeManagedAgentNode(position.x, position.y, choices);
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addGauge: () => {
    const position = positionFor({ width: 240, height: 96 });
    const stationHost = state$.settings.station.hostId.peek() || "local";
    const node = {
      ...makeGaugeNode(position.x, position.y),
      ether: {
        entity: { kind: "watcher" as const },
        host: stationHost,
        watch: { kind: "stat_threshold" as const, source: "hermes" as const },
      },
    };
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addCron: () => {
    const position = positionFor({ width: 240, height: 96 });
    const stationHost = state$.settings.station.hostId.peek() || "local";
    const node = {
      ...makeCronNode(position.x, position.y),
      ether: {
        entity: { kind: "cron" as const },
        host: stationHost,
        timer: { everyMinutes: 30 },
      },
    };
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addRelay: () => {
    const position = positionFor({ width: 220, height: 96 });
    const stationHost = state$.settings.station.hostId.peek() || "local";
    const node = makeRelayNode(position.x, position.y, "", stationHost);
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addTasks: () => {
    const position = positionFor({ width: 240, height: 120 });
    const stationHost = state$.settings.station.hostId.peek() || "local";
    const node = makeTasksNode(position.x, position.y, stationHost);
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addRequests: () => {
    const position = positionFor({ width: 240, height: 120 });
    const node = makeRequestsNode(position.x, position.y);
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addArtifacts: () => {
    const position = positionFor({ width: 240, height: 120 });
    const node = makeArtifactsNode(position.x, position.y);
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addBoard: () => {
    const position = positionFor({ width: 240, height: 120 });
    const node = makeBoardNode(position.x, position.y);
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addTerminal: () => {
    const position = positionFor({ width: 260, height: 110 });
    window.dispatchEvent(new CustomEvent("vellum:new-terminal", { detail: position }));
    dismiss();
  },
  addHerdr: () => {
    const position = positionFor({ width: 260, height: 110 });
    openHerdrWizard(position);
    dismiss();
  },
  addPage: () => {
    const size = { width: 260, height: 110 };
    const position = positionFor(size);
    // Create-time stamp from containing region defaults (center-in-region).
    // Escape hatch: place outside the region, or edit url/profile after create.
    const seed = resolvePageSpawnDefaults(
      state$.doc.peek(),
      position.x + size.width / 2,
      position.y + size.height / 2,
    );
    const node = makePageNode(
      position.x,
      position.y,
      seed?.url?.trim() || "https://example.com",
      seed?.profile ? { profile: seed.profile } : undefined,
      resolveAuthoredPageHost(
        seed?.host,
        state$.settings.station.hostId.peek(),
      ),
    );
    addNode(node);
    dismiss();
  },
  addLabel: () => {
    const size = { width: 160, height: 40 };
    const position = positionFor(size);
    const node = makeLabelNode(position.x, position.y);
    addNode(node);
    state$.focusNodeId.set(node.id);
    dismiss();
  },
});

// Escape / outside-pointerdown dismissal shared by both menu hosts.
const useMenuDismiss = (active: boolean, dismiss: () => void) => {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismiss();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("[data-canvas-menu-surface]")
      ) return;
      dismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [active, dismiss]);
};

function ModeDeckFocus({
  actions,
  agentPosition,
  onClose,
}: {
  readonly actions: ModeDeckActions;
  readonly agentPosition: { readonly x: number; readonly y: number };
  readonly onClose: () => void;
}) {
  return (
    <FocusSurface
      measure="workspace"
      height="fit"
      layer="work"
      label="Add canvas item"
      onClose={onClose}
      panelClassName="node-deck-focus-panel"
    >
      <OverlayHeader
        title="Add item"
        status="Choose an agent or work surface"
        actions={
          <IconButton aria-label="Close add canvas item" title="Close" onClick={onClose}>
            <X size={14} />
          </IconButton>
        }
      />
      <NodePaletteModeDeck actions={actions} agentPosition={agentPosition} />
    </FocusSurface>
  );
}

// Add from the field opens a focused workspace; creation still chooses the
// same unobstructed canvas positions as the former docked deck.
function CanvasFieldTools() {
  const rf = useReactFlow<FlowNode, FlowEdge>();
  const [open, setOpen] = useState(false);
  const dismiss = useCallback(() => { setOpen(false); }, []);

  // A non-overlapping slot near the viewport center for a node of the given size.
  const nextPosition = (size: { width: number; height: number }) => {
    const docNodes = state$.doc.peek().nodes;
    const slot = docNodes.length;
    const gridPlacement = slot < 6
      ? { x: (slot % 3) * 340 - 120, y: Math.floor(slot / 3) * 190 - 60 }
      : null;
    const center = gridPlacement
      ? { x: gridPlacement.x + size.width / 2, y: gridPlacement.y + size.height / 2 }
      : rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    return gridPlacement ? gridPlacement : findOpenPosition(docNodes, center, size);
  };

  const actions = makeAddActions(nextPosition, dismiss);
  // This position is shared with the persistent launch context while the deck
  // is open, so its region default describes the same next-agent placement.
  const agentPosition = useMemo(
    () => nextPosition(AGENT_NODE_SIZE),
    // Recompute only when the deck opens; do not make folder/host interaction
    // shift the containing-region decision underneath the operator.
    [open],
  );

  return (
    <div className="rts-field-tools" aria-label="Canvas field tools">
      <div className="node-deck-host node-deck-host--docked" data-canvas-menu-surface>
        <button
          type="button"
          className="node-deck-trigger"
          aria-label="Add canvas item"
          aria-expanded={open}
          onClick={() => { setOpen((value) => !value); }}
        >
          <Plus size={12} /><span>add item</span>
        </button>
        {open ? <ModeDeckFocus actions={actions} agentPosition={agentPosition} onClose={dismiss} /> : null}
      </div>
      <button
        type="button"
        className="rts-field-tools__fit"
        aria-label="Fit all nodes"
        title="fit all nodes"
        onClick={() => void rf.fitView({ padding: 0.18, duration: 320, maxZoom: 1.35 })}
      >
        <Expand size={12} />fit all
      </button>
    </div>
  );
}

// Right-click on empty canvas opens the same centered surface. Its placement
// strategy stays bound to the click, independent of where the modal renders.
function ContextModeDeck({ at, onClose }: { readonly at: { x: number; y: number }; readonly onClose: () => void }) {
  const rf = useReactFlow<FlowNode, FlowEdge>();
  const positionFor = (size: { width: number; height: number }) => {
    const point = rf.screenToFlowPosition({ x: at.x, y: at.y });
    return { x: Math.round(point.x - size.width / 2), y: Math.round(point.y - size.height / 2) };
  };
  const actions = makeAddActions(positionFor, onClose);
  const agentPosition = positionFor(AGENT_NODE_SIZE);
  return <ModeDeckFocus actions={actions} agentPosition={agentPosition} onClose={onClose} />;
}

// Right-click on (or inside) a live rubber-band selection: a small action
// menu applying to every currently selected node. Reads the working set fresh
// off the React Flow instance at action time, per the owner's contract.
function MultiSelectMenu({ at, onClose }: { readonly at: { x: number; y: number }; readonly onClose: () => void }) {
  const rf = useReactFlow<FlowNode, FlowEdge>();
  useMenuDismiss(true, onClose);
  const selected = rf.getNodes().filter((node) => node.selected);
  const count = selected.length;

  const run = (mutate: (ids: ReadonlyArray<string>) => void) => {
    mutate(rf.getNodes().filter((node) => node.selected).map((node) => node.id));
    onClose();
  };

  const createRegionFromSelection = (ids: ReadonlyArray<string>) => {
    const targets = state$.doc.peek().nodes.filter((node) => ids.includes(node.id));
    if (targets.length === 0) return;
    const pad = 48;
    const minX = Math.min(...targets.map((node) => node.x)) - pad;
    const minY = Math.min(...targets.map((node) => node.y)) - pad;
    const maxX = Math.max(...targets.map((node) => node.x + node.width)) + pad;
    const maxY = Math.max(...targets.map((node) => node.y + node.height)) + pad;
    const region = makeGroupNode(minX, minY, { width: maxX - minX, height: maxY - minY });
    // The selection is already fully in view — a fitView jump here would be
    // jarring, so this add skips the usual focus-zoom.
    addNode(region, { edit: false, focus: false });
  };

  return (
    <div className="canvas-action-menu-host" data-canvas-menu-surface style={{ position: "fixed", left: Math.min(at.x, window.innerWidth - 210), top: Math.min(at.y, window.innerHeight - 200), zIndex: 40 }}>
      <div className="canvas-action-menu">
        <button aria-label="Create region from selection" onClick={() => run(createRegionFromSelection)}><span className="canvas-action-menu__icon" aria-hidden><SquareDashed size={14} /></span><span><strong>create region</strong><small>from selection</small></span></button>
        <button aria-label="Flag blocker" onClick={() => run((ids) => setFlagForNodes(ids, "blocker"))}><span className="canvas-action-menu__icon" aria-hidden><Ban size={14} /></span><span><strong>flag blocker</strong><small>{count} node{count === 1 ? "" : "s"}</small></span></button>
        <button aria-label="Clear flags" onClick={() => run((ids) => setFlagForNodes(ids, null))}><span className="canvas-action-menu__icon" aria-hidden><Ban size={14} /></span><span><strong>clear flags</strong><small>{count} node{count === 1 ? "" : "s"}</small></span></button>
        <button aria-label={`Delete ${count} nodes`} onClick={() => run((ids) => deleteNodes(ids))}><span className="canvas-action-menu__icon" aria-hidden><Trash2 size={14} /></span><span><strong>delete {count} node{count === 1 ? "" : "s"}</strong></span></button>
      </div>
    </div>
  );
}

// Multi-select (or single source) + RMB on a non-selected target: offer
// "Connect all → target". Soft relates; direction selected → target.
function TargetConnectMenu({
  at,
  targetId,
  sourceIds,
  onClose,
}: {
  readonly at: { x: number; y: number };
  readonly targetId: string;
  readonly sourceIds: ReadonlyArray<string>;
  readonly onClose: () => void;
}) {
  useMenuDismiss(true, onClose);
  const target = state$.doc.peek().nodes.find((node) => node.id === targetId);
  const title = target ? nodeTitle(target) : targetId;
  const count = sourceIds.length;
  const label = count === 1 ? "Connect → target" : "Connect all → target";

  return (
    <div className="canvas-action-menu-host" data-canvas-menu-surface style={{ position: "fixed", left: Math.min(at.x, window.innerWidth - 210), top: Math.min(at.y, window.innerHeight - 120), zIndex: 40 }}>
      <div className="canvas-action-menu">
        <button
          aria-label={`${label}: ${count} source${count === 1 ? "" : "s"} to ${title}`}
          onClick={() => {
            connectAllToTarget(sourceIds, targetId);
            onClose();
          }}
        >
          <span className="canvas-action-menu__icon" aria-hidden><Link2 size={14} /></span>
          <span>
            <strong>{label}</strong>
            <small>{count} → {title}</small>
          </span>
        </button>
      </div>
    </div>
  );
}

/** Selected RF nodes that can act as edge sources (non-group, non-label, not the target). */
const connectableSourceIds = (
  nodes: ReadonlyArray<CanvasNodeRef>,
  targetId: string,
): string[] =>
  nodes
    .filter((node) => {
      if (!node.selected || node.id === targetId || node.type === "group") return false;
      const canvasNode = (node.data as { node?: { ether?: { entity?: { kind?: string } } } } | undefined)?.node;
      return canvasNode?.ether?.entity?.kind !== "label";
    })
    .map((node) => node.id);

function FieldControls() {
  const rf = useReactFlow<FlowNode, FlowEdge>();
  return (
    <Controls showFitView={false} showInteractive={false} aria-label="Canvas controls">
      <ControlButton aria-label="Fit readable view" title="fit readable view" onClick={() => fitReadableField(rf)}>
        <ScanLine size={14} />
      </ControlButton>
    </Controls>
  );
}

function RtsMinimapStack() {
  const rf = useReactFlow<FlowNode, FlowEdge>();
  const severityByNodeId = use$(state$.regionSeverityByNodeId) as Readonly<Record<string, string>>;
  const lastClickAt = useRef(0);
  const lastClickPos = useRef<{ x: number; y: number } | null>(null);

  const miniMapNodeColor = useCallback((node: Node): string => {
    const data = node.data as FlowNode["data"] | undefined;
    const canvasNode = data?.node;
    const severity = severityByNodeId[node.id] as MemberSeverity | undefined;
    if (canvasNode) return minimapFill(canvasNode, severity);
    return HUE.amber;
  }, [severityByNodeId]);

  // Click = pan camera to that world point; double-click = zoom in on it.
  // Stock MiniMap onClick already yields flow coordinates.
  const onMiniMapClick = useCallback((event: React.MouseEvent, position: { x: number; y: number }) => {
    const now = Date.now();
    const prev = lastClickPos.current;
    const dt = now - lastClickAt.current;
    const near =
      prev !== null &&
      Math.hypot(prev.x - position.x, prev.y - position.y) < 40;
    const isDouble = dt > 0 && dt < 320 && near;
    lastClickAt.current = now;
    lastClickPos.current = position;

    const zoom = rf.getZoom();
    if (isDouble) {
      const nextZoom = Math.min(Math.max(zoom * 1.55, 0.35), 1.6);
      void rf.setCenter(position.x, position.y, { zoom: nextZoom, duration: 280 });
      return;
    }
    void rf.setCenter(position.x, position.y, { zoom, duration: 240 });
  }, [rf]);

  const onMiniMapNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    // Prefer unit pick over empty-map click bubbling.
    event.stopPropagation();
    state$.selectedNodeId.set(node.id);
    state$.selectedNodeIds.set([node.id]);
    state$.selectedEdgeId.set("");
    // Focus path = camera fit on the entity (same as command Focus / chip).
    state$.focusNodeId.set(node.id);
  }, []);

  // MiniMap stays mounted for every pan/zoom frame — chrome must not blank.
  // Viewport-busy only freezes rebuilds/IPC/CSS, not this panel.
  return (
    <>
      <MiniMap
        pannable
        zoomable
        nodeColor={miniMapNodeColor}
        nodeStrokeColor={(node) => {
          const severity = severityByNodeId[node.id] as MemberSeverity | undefined;
          if (severity && severity !== "idle") return signalMark(severity).hue;
          return "rgba(12,11,10,0.85)";
        }}
        nodeStrokeWidth={1.5}
        maskColor="rgba(12,11,10,0.72)"
        onClick={onMiniMapClick}
        onNodeClick={onMiniMapNodeClick}
        ariaLabel="Strategic minimap — click to move camera, double-click to zoom, click a node to focus"
        // Never put width/height: "100%" here. xyflow reads style.width/height as
        // *numbers* for viewScale + mask path math (`M${x}h${w}v${h}…`). A percent
        // string → NaN → console spam on every pan/scroll. Size the panel via
        // .rts-minimap-wrap CSS (100% inset); math falls back to 200×150 defaults.
        style={{ background: "rgba(12,11,10,0.9)", border: "1px solid rgba(237,230,218,0.1)" }}
      />
      <FieldControls />
    </>
  );
}

function useCanvasGraph() {
  // Narrow React subscriptions: filters/search only. Doc/execution/selection
  // drive RF via onChange → setNodes so CanvasGraph does not re-render on
  // every kernel cycle.
  const searchQuery = use$(state$.searchQuery);
  const edgeFilter = use$(state$.edgeFilter);
  const flagFilter = use$(state$.flagFilter);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const rf = useReactFlow<FlowNode, FlowEdge>();
  const dragInProgressRef = useRef(false);
  const pendingRebuildRef = useRef(false);
  const flowCacheRef = useRef(createFlowIdentityCache());
  // Bump after drag-stop when a rebuild was deferred mid-gesture.
  const [rebuildTick, setRebuildTick] = useState(0);
  const flushRebuild = useCallback(() => setRebuildTick((n) => n + 1), []);
  useCanvasDocument(
    searchQuery,
    edgeFilter,
    flagFilter,
    setNodes,
    setEdges,
    dragInProgressRef,
    pendingRebuildRef,
    flowCacheRef,
    rebuildTick,
  );
  useCanvasSearchViewport(searchQuery, nodes.length, rf, `${edgeFilter}|${flagFilter}`);
  useCanvasFocus(rf);
  useCanvasViewport(nodes.length, rf);
  return {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    interactions: useCanvasInteractions(rf, setNodes, dragInProgressRef, pendingRebuildRef, flushRebuild),
    rf,
  };
}

/** Isolated so selection/execution ticks do not re-render React Flow. */
function ImpactSeedChip() {
  const selectedNodeId = use$(state$.selectedNodeId);
  const connectionFocusNodeId = use$(state$.connectionFocusNodeId);
  const docVersion = use$(state$.docVersion);
  const executionRev = use$(kernel$.executionRev);
  const canvasName = use$(state$.canvasName);
  const actorRefs = use$(state$.actorRefs);
  const impact = useMemo(() => {
    const context = executionGraphContextFromActorRefs(
      canvasName,
      actorRefs,
    );
    return selectionForCanvas(selectedNodeId, context);
  }, [actorRefs, canvasName, connectionFocusNodeId, selectedNodeId, docVersion, executionRev]);
  if (!impact.active) return null;
  return (
    <Panel position="top-left" className="impact-hud-panel">
      <div
        className="impact-hud"
        role="status"
        aria-live="polite"
        title={connectionFocusNodeId ? "Focused node connections" : "Stoppage impact cone for selection"}
      >
        <span className="impact-hud__mark" aria-hidden />
        <span className="impact-hud__eyebrow">{connectionFocusNodeId ? "focus" : "impact"}</span>
        <span className="impact-hud__label">{impact.seedLabel}</span>
      </div>
    </Panel>
  );
}

/**
 * Connect preview — role pair + would-be grant, live while a connection drag
 * hovers a candidate target, before the edge is drawn. Copy is computed by
 * describeConnectPreview (grantLawForRoles + target offers, the same
 * inputs admit itself uses) — never a hardcoded per-pair table.
 */
function ConnectPreviewChip() {
  const connection = useConnection<FlowNode>();
  if (!connection.inProgress || !connection.toNode) return null;
  const preview = describeConnectPreview(connection.fromNode.data.node, connection.toNode.data.node);
  return (
    <Panel position="top-center" className="connect-preview-panel">
      <div className="connect-preview-chip" role="status" aria-live="polite">
        <span className="connect-preview-chip__pair">{preview.fromRole} → {preview.toRole}</span>
        <span className="connect-preview-chip__grant">{preview.label}</span>
      </div>
    </Panel>
  );
}

function CanvasGraph() {
  const { nodes, edges, onNodesChange, onEdgesChange, interactions, rf } = useCanvasGraph();
  // While a connection drag is live, every card shows its dots so targets are
  // discoverable mid-gesture.
  const connecting = useConnection((connection) => connection.inProgress);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [terminalAnchor, setTerminalAnchor] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const openTerminal = (event: Event) =>
      setTerminalAnchor((event as CustomEvent<{ x: number; y: number }>).detail);
    window.addEventListener("vellum:new-terminal", openTerminal);
    return () => {
      window.removeEventListener("vellum:new-terminal", openTerminal);
    };
  }, []);
  const [multiMenu, setMultiMenu] = useState<{ x: number; y: number } | null>(null);
  const [connectMenu, setConnectMenu] = useState<{
    readonly x: number;
    readonly y: number;
    readonly targetId: string;
    readonly sourceIds: ReadonlyArray<string>;
  } | null>(null);
  // Context menus are mutually exclusive — opening one always closes the rest.
  const closeMenus = useCallback(() => {
    setCtxMenu(null);
    setMultiMenu(null);
    setConnectMenu(null);
  }, []);
  const openContextMenu = useCallback((at: { x: number; y: number }) => {
    setMultiMenu(null);
    setConnectMenu(null);
    setCtxMenu(at);
  }, []);
  const openMultiMenu = useCallback((at: { x: number; y: number }) => {
    setCtxMenu(null);
    setConnectMenu(null);
    setMultiMenu(at);
  }, []);
  const openConnectMenu = useCallback((
    at: { x: number; y: number },
    targetId: string,
    sourceIds: ReadonlyArray<string>,
  ) => {
    setCtxMenu(null);
    setMultiMenu(null);
    setConnectMenu({ ...at, targetId, sourceIds });
  }, []);
  const onPaneContextMenu = useCallback((event: React.MouseEvent | MouseEvent) => {
    event.preventDefault();
    openContextMenu({ x: event.clientX, y: event.clientY });
  }, [openContextMenu]);
  // Region → add menu (empty-space read). Multi-selection on a selected node →
  // bulk actions. Selection + RMB on a *different* non-group node → connect
  // all selected sources → that target. Shift+RMB keeps selection so one
  // source can fan out to multiple targets without a menu each time.
  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: FlowNode) => {
    const live = rf.getNodes();
    const selectedCount = live.filter((n) => n.selected).length;
    const isGroup = node.data?.node.type === "group" || node.type === "group";

    if (selectedCount >= 1 && !node.selected && !isGroup) {
      const sourceIds = connectableSourceIds(live, node.id);
      if (sourceIds.length > 0) {
        event.preventDefault();
        // Shift+RMB: immediate connect, keep selection for multi-target fan-out.
        if (event.shiftKey) {
          connectAllToTarget(sourceIds, node.id, { keepSelection: true });
          closeMenus();
          return;
        }
        openConnectMenu({ x: event.clientX, y: event.clientY }, node.id, sourceIds);
        return;
      }
    }

    if (selectedCount > 1 && node.selected) {
      event.preventDefault();
      openMultiMenu({ x: event.clientX, y: event.clientY });
      return;
    }
    if (!isGroup) return;
    event.preventDefault();
    openContextMenu({ x: event.clientX, y: event.clientY });
  }, [rf, openContextMenu, openMultiMenu, openConnectMenu, closeMenus]);
  // Right-click on the rubber-band selection itself (not a single node).
  const onSelectionContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    openMultiMenu({ x: event.clientX, y: event.clientY });
  }, [openMultiMenu]);
  const onPaneClick = useCallback((event: React.MouseEvent) => {
    closeMenus();
    interactions.onPaneClick(event);
  }, [interactions.onPaneClick, closeMenus]);
  // Boolean only — flips when a cone appears/clears, not on every kernel tick.
  const impactMode = use$(impactModeActive$);
  const connectionFocusNodeId = use$(state$.connectionFocusNodeId);
  // Viewport freeze: boolean flip at gesture edges only (never per-frame setState).
  // Does not unmount MiniMap/Background — chrome stays live.
  const viewportBusy = use$(viewportBusy$);
  const onMoveStart = useCallback(() => {
    markViewportBusy();
    closeMenus();
  }, [closeMenus]);
  // Continuous move keeps the freeze latched across wheel bursts; no React work.
  const onMove = useCallback(() => {
    markViewportBusy();
  }, []);
  const onMoveEnd = useCallback(() => {
    releaseViewportBusy();
  }, []);

  return <>
    {terminalAnchor ? <TerminalWizard anchor={terminalAnchor} onClose={() => setTerminalAnchor(null)} /> : null}
    <ReactFlow
      className={[
        connecting ? "is-connecting" : "",
        impactMode ? (connectionFocusNodeId ? "connection-focus-mode" : "impact-mode") : "",
        viewportBusy ? "is-viewport-busy" : "",
      ].filter(Boolean).join(" ") || undefined}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      {...interactions}
      onPaneClick={onPaneClick}
      onPaneContextMenu={onPaneContextMenu}
      onNodeContextMenu={onNodeContextMenu}
      onSelectionContextMenu={onSelectionContextMenu}
      onMoveStart={onMoveStart}
      onMove={onMove}
      onMoveEnd={onMoveEnd}
      connectionMode={ConnectionMode.Loose}
      connectionRadius={42}
      panOnScroll
      panOnScrollSpeed={1.2}
      panOnDrag={[1]}
      // Default panActivationKeyCode is "Space". xyflow's useKeyPress
      // preventDefaults Space whenever *any* modifier is held — including
      // Shift — even while focus is inside xterm's textarea. With Caps Lock
      // on, Shift is held to type lowercase, so Shift+Space silently drops
      // the space into the PTY. Pan is already mid-drag + scroll; kill Space.
      panActivationKeyCode={null}
      selectionOnDrag
      selectionMode={SelectionMode.Partial}
      // Shift+click / Shift+marquee additive multi-select (RF default is Meta/Ctrl).
      multiSelectionKeyCode="Shift"
      zoomOnDoubleClick={false}
      onlyRenderVisibleElements
      deleteKeyCode={["Backspace", "Delete"]}
      elevateNodesOnSelect={false}
      elevateEdgesOnSelect
      fitView
      fitViewOptions={{ padding: 0.18, maxZoom: 1.35 }}
      minZoom={0.15}
      maxZoom={2.5}
      proOptions={{ hideAttribution: true }}
      style={{ background: GROUND }}
    >
      <Background variant={BackgroundVariant.Dots} gap={26} size={1} color="rgba(237,230,218,0.07)" />
      <CanvasMagnifier />
      <ImpactSeedChip />
      <ConnectPreviewChip />
      {/* Bar (incl. MiniMap) must be a ReactFlow child so MiniMap binds to the instance. */}
      <Panel position="bottom-center" className="rts-bar-panel" style={{ width: "100%", margin: 0, left: 0, right: 0, transform: "none", maxWidth: "none" }}>
        <RtsBottomBar tools={<CanvasFieldTools />} minimap={<RtsMinimapStack />} />
      </Panel>
    </ReactFlow>
    {ctxMenu ? <ContextModeDeck at={ctxMenu} onClose={() => setCtxMenu(null)} /> : null}
    {multiMenu ? <MultiSelectMenu at={multiMenu} onClose={() => setMultiMenu(null)} /> : null}
    {connectMenu ? (
      <TargetConnectMenu
        at={{ x: connectMenu.x, y: connectMenu.y }}
        targetId={connectMenu.targetId}
        sourceIds={connectMenu.sourceIds}
        onClose={() => setConnectMenu(null)}
      />
    ) : null}
  </>;
}

export function Canvas() {
  return <div className="h-full w-full"><CanvasGraph /></div>;
}
