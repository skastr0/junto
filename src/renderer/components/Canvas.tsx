import { Profiler, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ConnectionMode,
  ControlButton,
  Controls,
  Panel,
  ReactFlow,
  SelectionMode,
  useConnection,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStore,
  useStoreApi,
} from "@xyflow/react";
import type { Connection, EdgeMouseHandler, FinalConnectionState, Node, OnNodeDrag } from "@xyflow/react";
import { use$ } from "@legendapp/state/react";
import type { CanvasDoc, EtherEdgeKind } from "@shared/canvas";
import { executionGraphContextFromActorRefs } from "@shared/graph";
import { Activity, BookmarkPlus, Boxes, Expand, LayoutGrid, Link2, OctagonX, Pencil, Plus, ScanLine, ScrollText, SquareDashed, Trash2, Unlink, UserRoundPen, Users, X } from "lucide-react";
import {
  clearSelection,
  replaceSelection,
  selectEdge,
  selectNode,
  state$,
} from "../lib/state";
import { kernel$ } from "../lib/kernel-view";
import { dock$ } from "../lib/dock-state";
import type { FlowEdge, FlowNode } from "../lib/convert";
import { createFlowIdentityCache, toFlow } from "../lib/convert";
import {
  edgeImpactClass,
  edgeImpactRole,
  connectionFocusSelection,
  impactModeActive$,
  nodeImpactClass,
  selectionImpact,
  type ImpactSelection,
} from "../lib/impact-mode";
import {
  markViewportBusy,
  releaseViewportBusy,
  resetViewportBusy,
  viewportBusy$,
  withViewportBusy,
} from "../lib/viewport-busy";
import { isEditableEventTarget } from "../lib/multi-select-gesture";
import { nodeTitle } from "../lib/presentation";
import { isCommandCenterAuthoring } from "../lib/canvas-boot";
import { AGENT_NODE_SIZE } from "../lib/node-geometry";
import { addNode, deleteNodes } from "../lib/mutations";
import { addEdge, connectAllToTarget, connectAllowed, connectMesh, deleteEdges, disconnectWithin, edgeIdsWithin, planConnectMesh } from "../lib/edge-mutations";
import { agentCountLabel, agentSeatIds, isAgentSeatNode } from "../lib/multi-selection";
import { openAgentEditor } from "../lib/agent-editor-state";
import { broadcastMenuHint, broadcastToSelection, planAgentBroadcast } from "../lib/agent-broadcast";
import { AGENT_BROADCAST_PROMPTS, type AgentBroadcastKind } from "@shared/agent-broadcast-prompts";
import { placeAtPoint, placeBesideRect, type ScreenRect } from "../lib/menu-placement";
import { dragHoldMemberIds, findOpenPosition, syncPositions } from "../lib/geometry";
import { resolvePageSpawnDefaults } from "@shared/region-defaults";
import { resolveAuthoredPageHost } from "../lib/page-authoring";
import "../styles/factory-grammar.css";
import {
  makeArtifactsNode,
  makeBoardNode,
  makeCronNode,
  makePadNode,
  makeSheetNode,
  makeGroupNode,
  makeImageNode,
  makeLabelNode,
  makeManagedAgentNode,
  makePageNode,
  makeRelayNode,
  makeRequestsNode,
  makeTasksNode,
  makeTextNode,
} from "../lib/node-factories";
import { putImagesFromDataTransfer } from "../lib/image-content";
import { contentObjectUrl } from "@shared/content-url";
import {
  ARTIFACTS_ENABLED,
  BOARD_ENABLED,
  BROWSER_ENABLED,
  FLEET_UI_ENABLED,
  PAD_ENABLED,
  REQUESTS_ENABLED,
  SHEET_ENABLED,
  TASKS_ENABLED,
} from "@shared/features";
import { HUE, themeFor, withAlpha } from "../lib/theme";
import { themeMode$ } from "../lib/theme-mode";
import type { MemberSeverity } from "@shared/region-rollup";
import { minimapNodeColors, useSeatRollups } from "../lib/minimap-seat-colors";
import { nodeTypes } from "./nodes";
import { edgeTypes } from "./edges/EtherEdge";
import { CanvasLoom } from "./edges/CanvasLoom";
import { WirePulseFeed } from "./edges/WirePulseFeed";
import { RtsBottomBar, saveSelectionToCommandGroup } from "./rts/RtsBottomBar";
import { SaveToGroupPicker } from "./rts/SaveToGroupPicker";
import { SquadDialogHost } from "./squads/SquadDialog";
import { openSaveSquad, placeSquadInSlot } from "../lib/squads-state";
import { openSaveProfile, placeProfileInSlot } from "../lib/profiles-state";
import { ProfileDialogHost } from "./profiles/ProfileDialog";
import { TerminalWizard, createTerminalAt } from "./terminal/TerminalWizard";
import { openTerminalGrid } from "../lib/terminal-grid-state";
import { GitWizard, createGitFromRegion } from "./git/GitWizard";
import { CanvasMagnifier } from "./CanvasMagnifier";
import { CanvasKeyboardPan } from "./CanvasKeyboardPan";
import { RegionGlanceGate } from "./RegionGlanceGate";
import { CanvasTierGate } from "./CanvasTierGate";
import { ViewportTransformLease } from "./ViewportTransformLease";
import { FactoryMinimap } from "./FactoryMinimap";
import { canvasPerformance } from "../lib/performance/canvas-performance";
import { PERF_ENABLED } from "../lib/performance/perf-flag";
import { NodePaletteModeDeck, type ModeDeckActions } from "./node-palette/NodePaletteModeDeck";
import { FocusSurface } from "./FocusSurface";
import { useCanvasGroupFocus } from "./useCanvasGroupFocus";
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
  void withViewportBusy(() => rf.fitView({
    nodes: anchors,
    padding: 0.18,
    duration,
    maxZoom: regions.length > 0 ? 1.15 : 1.35,
  })).catch(() => undefined);
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

/**
 * Legend mirrors React Flow's full selection separately from its single-node
 * inspector subject. Resolve the live set once so structural rebuilds cannot
 * collapse a multi-selection back to the single-node channel.
 */
const selectedNodeSet = (
  selectedNodeId: string,
  selectedNodeIds: ReadonlyArray<string>,
): ReadonlySet<string> => {
  const multiSelectionIsCurrent =
    selectedNodeIds.length > 1 &&
    (selectedNodeId === "" || selectedNodeIds.includes(selectedNodeId));
  if (multiSelectionIsCurrent) return new Set(selectedNodeIds);
  const single =
    selectedNodeId || (selectedNodeIds.length === 1 ? selectedNodeIds[0] ?? "" : "");
  return single ? new Set([single]) : new Set();
};

function stampImpactShell(
  nodes: FlowNode[],
  edges: FlowEdge[],
  selectedNodeId: string,
  selectedNodeIds: ReadonlyArray<string>,
  selectedEdgeId: string,
): { nodes: FlowNode[]; edges: FlowEdge[]; impact: ImpactSelection } {
  const context = currentExecutionGraphContext();
  const impact = selectionForCanvas(selectedNodeId, context);
  const selectedIds = selectedNodeSet(selectedNodeId, selectedNodeIds);
  if (impactModeActive$.peek() !== impact.active) impactModeActive$.set(impact.active);
  return {
    impact,
    nodes: nodes.map((node) => {
      const selected = selectedIds.has(node.id);
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
  edgeFilter: EtherEdgeKind | "",
): void {
  const built = toFlow(
    state$.doc.peek(),
    currentExecutionGraphContext(),
    kernel$.execution.peek(),
    flowCache,
  );
  const nodeId = state$.selectedNodeId.peek();
  const nodeIds = state$.selectedNodeIds.peek();
  const edgeId = state$.selectedEdgeId.peek();
  const filteredEdges = built.edges.filter(
    (edge) => !edgeFilter || (edge.data?.phase ?? "relates") === edgeFilter,
  );
  // Selection + impact cone classes live on the RF shell (not Flow data).
  const stamped = stampImpactShell(built.nodes, filteredEdges, nodeId, nodeIds, edgeId);
  // The command bar filters a LIST, never the graph: canvas search thinning
  // was retired with the station search field.
  const nextNodes = stamped.nodes;
  const nextEdges = stamped.edges;

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
  edgeFilter: EtherEdgeKind | "",
  setNodes: ReturnType<typeof useNodesState<FlowNode>>[1],
  setEdges: ReturnType<typeof useEdgesState<FlowEdge>>[1],
  dragInProgressRef: React.MutableRefObject<boolean>,
  pendingRebuildRef: React.MutableRefObject<boolean>,
  flowCacheRef: React.MutableRefObject<ReturnType<typeof createFlowIdentityCache>>,
  rebuildTick: number,
) {
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
      edgeFilter,
    );
  }, [
    edgeFilter,
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
      const selectedNodeIds = state$.selectedNodeIds.peek();
      const selectedEdgeId = state$.selectedEdgeId.peek();
      const context = currentExecutionGraphContext();
      const impact: ImpactSelection = selectionForCanvas(selectedNodeId, context);
      const selectedIds = selectedNodeSet(selectedNodeId, selectedNodeIds);
      if (impactModeActive$.peek() !== impact.active) impactModeActive$.set(impact.active);

      setNodes((nodes) => {
        let dirty = false;
        const next = nodes.map((node) => {
          const selected = selectedIds.has(node.id);
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
      state$.selectedNodeIds.onChange(syncSelection),
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

function useCanvasFilterViewport(viewKey: string, rf: CanvasFlow) {
  const previousViewKey = useRef("");
  useEffect(() => {
    const filterChanged = previousViewKey.current !== viewKey;
    previousViewKey.current = viewKey;
    if (!filterChanged) return;
    const frame = requestAnimationFrame(() => fitReadableField(rf, 260));
    return () => cancelAnimationFrame(frame);
  }, [viewKey, rf]);
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
        selectNode(focusNodeId);
        void withViewportBusy(() => rf.fitView({
          nodes: [node],
          padding: 0.35,
          maxZoom: 1.45,
          duration: 360,
        })).catch(() => undefined).finally(() => {
          selectNode(focusNodeId);
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
  // Live validity while dragging — the verb grammar, read on the pair. A pair
  // no verb speaks to never lights up, so a landing zone only ever appears
  // where the drop would actually commit.
  const isValidConnection = useCallback((connection: Connection | { source: string | null; target: string | null }) => {
    const sourceId = connection.source;
    const targetId = connection.target;
    if (!sourceId || !targetId || sourceId === targetId) return false;
    const doc = state$.doc.peek();
    return connectAllowed(
      doc.nodes.find((n) => n.id === sourceId),
      doc.nodes.find((n) => n.id === targetId),
    );
  }, []);
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
  // Selection only. A verb is authored by drawing the wire, so there is no
  // settings surface behind a double click.
  const onEdgeDoubleClick: EdgeMouseHandler<FlowEdge> = useCallback((event, edge) => {
    event.preventDefault();
    event.stopPropagation();
    selectEdge(edge.id);
  }, []);
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
    const nextSelectedNodeIds = selectedNodes.map((node) => node.id);
    // A rubber-band multi-selection has no single inspector subject; keep the
    // inspector closed and let React Flow own the selection set.
    if (selectedNodes.length > 1) {
      replaceSelection({ nodeIds: nextSelectedNodeIds });
      return;
    }
    const nextSelectedEdgeId = selectedNodes.length === 0 ? selectedEdges[0]?.id ?? "" : "";
    replaceSelection({
      nodeId: nextSelectedNodeId,
      nodeIds: nextSelectedNodeIds,
      edgeId: nextSelectedEdgeId,
    });
  }, []);
  const onPaneClick = useCallback((event: React.MouseEvent) => {
    if (event.detail === 1) {
      clearSelection();
      state$.connectionFocusNodeId.set("");
      return;
    }
    if (event.detail !== 2) return;
    const pos = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    addNode(makeTextNode(pos.x - 120, pos.y - 50));
  }, [rf]);
  return {
    onConnect,
    onConnectEnd,
    isValidConnection,
    onNodeDragStart,
    onNodeDrag,
    onNodeDragStop,
    onNodesDelete,
    onEdgesDelete,
    onEdgeDoubleClick,
    onSelectionChange,
    onPaneClick,
  };
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
      : { width: 560, height: 320 };
    const position = positionFor(size);
    const node = kind === "text"
      ? makeTextNode(position.x, position.y)
      : makeGroupNode(position.x, position.y);
    addNode(node);
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addSquad: async (squadId, launch) => {
    const outcome = await placeSquadInSlot(squadId, positionFor, launch);
    if (outcome !== "needs-folder") dismiss();
    return outcome;
  },
  addProfile: async (profileId, launch) => {
    const outcome = await placeProfileInSlot(profileId, positionFor, launch);
    if (outcome !== "needs-folder") dismiss();
    return outcome;
  },
  addConfiguredAgent: (choices, position) => {
    const node = makeManagedAgentNode(position.x, position.y, choices);
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
    const node = makeRelayNode(position.x, position.y, stationHost);
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addTasks: () => {
    if (!TASKS_ENABLED) return;
    const position = positionFor({ width: 240, height: 120 });
    const stationHost = state$.settings.station.hostId.peek() || "local";
    const node = makeTasksNode(position.x, position.y, stationHost);
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addRequests: () => {
    if (!REQUESTS_ENABLED) return;
    const position = positionFor({ width: 240, height: 120 });
    const node = makeRequestsNode(position.x, position.y);
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addArtifacts: () => {
    if (!ARTIFACTS_ENABLED) return;
    const position = positionFor({ width: 240, height: 120 });
    const node = makeArtifactsNode(position.x, position.y);
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addBoard: () => {
    if (!BOARD_ENABLED) return;
    const position = positionFor({ width: 240, height: 120 });
    const node = makeBoardNode(position.x, position.y);
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addPad: () => {
    if (!PAD_ENABLED) return;
    const position = positionFor({ width: 240, height: 120 });
    const node = makePadNode(position.x, position.y);
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addSheet: () => {
    if (!SHEET_ENABLED) return;
    const position = positionFor({ width: 260, height: 120 });
    const node = makeSheetNode(position.x, position.y);
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addGit: () => {
    const position = positionFor({ width: 280, height: 128 });
    window.dispatchEvent(new CustomEvent("junto:new-git", { detail: position }));
    dismiss();
  },
  addTerminal: () => {
    const position = positionFor({ width: 260, height: 110 });
    window.dispatchEvent(new CustomEvent("junto:new-terminal", { detail: position }));
    dismiss();
  },
  addPage: () => {
    if (!BROWSER_ENABLED) return;
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
    // focus-law: Escape-only dismissal of the open canvas menu.
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
  // Shared with the command bar action: the palette opens from either the
  // field trigger or "Add canvas item" in the palette.
  const open = use$(state$.nodePaletteOpen);
  const dismiss = useCallback(() => { state$.nodePaletteOpen.set(false); }, []);

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

  const authoring = isCommandCenterAuthoring(use$(state$.settings.station.role));

  return (
    <div className="rts-field-tools" aria-label="Canvas field tools">
      {authoring ? (
      <div className="node-deck-host node-deck-host--docked" data-canvas-menu-surface>
        <button
          type="button"
          className="node-deck-trigger"
          aria-label="Add canvas item"
          aria-expanded={open}
          onClick={() => { state$.nodePaletteOpen.set(!state$.nodePaletteOpen.peek()); }}
        >
          <Plus size={12} /><span>add item</span>
        </button>
        {open ? <ModeDeckFocus actions={actions} agentPosition={agentPosition} onClose={dismiss} /> : null}
      </div>
      ) : null}
      <button
        type="button"
        className="rts-field-tools__fit"
        aria-label="Fit all nodes"
        title="Fit all nodes"
        onClick={() => {
          void withViewportBusy(() => rf.fitView({
            padding: 0.18,
            duration: 320,
            maxZoom: 1.35,
          })).catch(() => undefined);
        }}
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

/** Where the multi-select menu opens: a right-click point, or the box a rubber-band selection just closed. */
type MultiMenuAnchor =
  | { readonly kind: "point"; readonly x: number; readonly y: number }
  | { readonly kind: "rect"; readonly rect: ScreenRect };

/** One row of the multi-select menu. Agent actions act on the selection's agent seats only. */
type MultiMenuEntry = {
  readonly key: string;
  readonly label: string;
  readonly detail?: string;
  readonly ariaLabel: string;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
};

const MultiMenuRow = ({ entry }: { readonly entry: MultiMenuEntry }) => (
  <button aria-label={entry.ariaLabel} disabled={entry.disabled} onClick={entry.onSelect}>
    <span className="canvas-action-menu__icon" aria-hidden>{entry.icon}</span>
    <span><strong>{entry.label}</strong>{entry.detail ? <small>{entry.detail}</small> : null}</span>
  </button>
);

// Opens on its own when a rubber-band selection of 2+ nodes ends, or on
// right-click of a selection: actions applying to every selected node. Reads
// the working set fresh off the React Flow instance at action time, and closes
// when that set changes underneath it.
function MultiSelectMenu({ anchor, onClose }: { readonly anchor: MultiMenuAnchor; readonly onClose: () => void }) {
  const rf = useReactFlow<FlowNode, FlowEdge>();
  useMenuDismiss(true, onClose);
  const authoring = isCommandCenterAuthoring(use$(state$.settings.station.role));
  const selectionKey = useStore((store) => store.nodes.filter((node) => node.selected).map((node) => node.id).join(" "));
  const openedWith = useRef(selectionKey);
  useEffect(() => {
    if (selectionKey !== openedWith.current) onClose();
  }, [selectionKey, onClose]);

  const hostRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ readonly x: number; readonly y: number } | null>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const size = { width: host.offsetWidth, height: host.offsetHeight };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    setPosition(anchor.kind === "rect" ? placeBesideRect(anchor.rect, size, viewport) : placeAtPoint(anchor, size, viewport));
  }, [anchor]);

  const doc = state$.doc.peek();
  const selectedIds = new Set(selectionKey.split(" ").filter(Boolean));
  const count = selectedIds.size;
  const agentIds = agentSeatIds(doc.nodes.filter((node) => selectedIds.has(node.id)));
  const agents = agentCountLabel(agentIds.length);
  const meshAdds = planConnectMesh(agentIds, doc.nodes, doc.edges).toAdd.length;
  const innerEdges = edgeIdsWithin(agentIds, doc.edges).length;
  const broadcast = planAgentBroadcast(doc.nodes.filter((node) => agentIds.includes(node.id)));

  const run = (mutate: (ids: ReadonlyArray<string>) => void) => {
    mutate(rf.getNodes().filter((node) => node.selected).map((node) => node.id));
    onClose();
  };
  const runOnAgents = (act: (agentIds: ReadonlyArray<string>) => void) => () => {
    const live = new Set(rf.getNodes().filter((node) => node.selected).map((node) => node.id));
    act(agentSeatIds(state$.doc.peek().nodes.filter((node) => live.has(node.id))));
    onClose();
  };
  const broadcastEntry = (kind: AgentBroadcastKind, icon: ReactNode): MultiMenuEntry | null => {
    if (!authoring) return null;
    const prompt = AGENT_BROADCAST_PROMPTS[kind];
    return {
      key: kind,
      label: prompt.label,
      detail: broadcastMenuHint(broadcast),
      ariaLabel: `${prompt.ariaLabel}, ${broadcastMenuHint(broadcast)}`,
      icon,
      disabled: broadcast.live.length === 0,
      onSelect: runOnAgents((ids) => {
        void broadcastToSelection(kind, state$.doc.peek().nodes.filter((node) => ids.includes(node.id)));
      }),
    };
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

  // Agent actions, in menu order: connect, open, disconnect, stop, check.
  // Each owner fills its own slot; a null slot renders nothing. The whole
  // group is absent when the selection holds no agent seat.
  const agentActions: ReadonlyArray<MultiMenuEntry | null> = agentIds.length === 0 ? [] : [
    authoring ? {
      key: "connect",
      label: "connect",
      detail: meshAdds === 0 && agentIds.length > 1 ? `${agents}, all connected` : agents,
      ariaLabel: `Connect ${agents} to each other`,
      icon: <Link2 size={14} />,
      disabled: meshAdds === 0,
      onSelect: runOnAgents(connectMesh),
    } : null,
    {
      key: "open",
      label: "open",
      detail: `${agents}, grid`,
      ariaLabel: `Open ${agents} in a grid`,
      icon: <LayoutGrid size={14} />,
      onSelect: runOnAgents((ids) => openTerminalGrid(ids)),
    },
    authoring ? {
      key: "disconnect",
      label: "disconnect",
      detail: `${innerEdges} edge${innerEdges === 1 ? "" : "s"}`,
      ariaLabel: `Disconnect ${innerEdges} edges between ${agents}`,
      icon: <Unlink size={14} />,
      disabled: innerEdges === 0,
      onSelect: runOnAgents(disconnectWithin),
    } : null,
    broadcastEntry("stop", <OctagonX size={14} />),
    broadcastEntry("check", <Activity size={14} />),
    authoring && agentIds.length === 1 ? {
      key: "profile",
      label: "save as profile",
      detail: "1 agent, reusable",
      ariaLabel: "Save the agent as a profile",
      icon: <BookmarkPlus size={14} />,
      onSelect: runOnAgents((ids) => {
        if (ids[0]) openSaveProfile(ids[0]);
      }),
    } : null,
    authoring ? {
      key: "squad",
      label: "save as squad",
      detail: `${agents}, reusable`,
      ariaLabel: `Save ${agents} as a squad`,
      icon: <Users size={14} />,
      onSelect: runOnAgents((ids) => openSaveSquad(ids)),
    } : null,
  ];
  const agentRows = agentActions.filter((entry): entry is MultiMenuEntry => entry !== null);

  const nodes = `${count} node${count === 1 ? "" : "s"}`;
  const selectionActions: ReadonlyArray<MultiMenuEntry> = [
    { key: "region", label: "create region", detail: "from selection", ariaLabel: "Create region from selection", icon: <SquareDashed size={14} />, onSelect: () => run(createRegionFromSelection) },
    { key: "delete", label: `delete ${nodes}`, ariaLabel: `Delete ${count} nodes`, icon: <Trash2 size={14} />, onSelect: () => run((ids) => deleteNodes(ids)) },
  ];

  return (
    <div
      ref={hostRef}
      className="canvas-action-menu-host"
      data-canvas-menu-surface
      style={{ position: "fixed", left: position?.x ?? 0, top: position?.y ?? 0, zIndex: 40, visibility: position ? "visible" : "hidden" }}
    >
      <div className="canvas-action-menu" role="menu" aria-label={`Actions for ${nodes}`}>
        {agentRows.map((entry) => <MultiMenuRow key={entry.key} entry={entry} />)}
        {agentRows.length > 0 ? <hr className="canvas-action-menu__rule" /> : null}
        <SaveToGroupPicker count={count} onPick={(slot) => run((ids) => saveSelectionToCommandGroup(ids, slot))} />
        <hr className="canvas-action-menu__rule" />
        {selectionActions.map((entry) => <MultiMenuRow key={entry.key} entry={entry} />)}
      </div>
    </div>
  );
}

// Right-click on one agent seat: the customize-agent editor, whole or at its
// name. The editor opens beside the seat.
function SeatMenu({ at, seatId, onClose }: {
  readonly at: { readonly x: number; readonly y: number };
  readonly seatId: string;
  readonly onClose: () => void;
}) {
  useMenuDismiss(true, onClose);
  const hostRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ readonly x: number; readonly y: number } | null>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setPosition(placeAtPoint(at, { width: host.offsetWidth, height: host.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
  }, [at]);
  const open = (section: string) => () => {
    onClose();
    openAgentEditor(seatId, { section });
  };
  const entries: ReadonlyArray<MultiMenuEntry> = [
    { key: "customize", label: "customize character", detail: "look, mood, name", ariaLabel: "Customize character", icon: <UserRoundPen size={14} />, onSelect: open("look") },
    { key: "rename", label: "rename", ariaLabel: "Rename agent", icon: <Pencil size={14} />, onSelect: open("name") },
    { key: "soul", label: "soul and instructions", detail: "who it is, how it works", ariaLabel: "Edit soul and instructions", icon: <ScrollText size={14} />, onSelect: open("soul") },
    { key: "profile", label: "save as profile", detail: "reuse anywhere", ariaLabel: "Save agent as a profile", icon: <BookmarkPlus size={14} />, onSelect: () => { onClose(); openSaveProfile(seatId); } },
  ];
  return (
    <div
      ref={hostRef}
      className="canvas-action-menu-host"
      data-canvas-menu-surface
      style={{ position: "fixed", left: position?.x ?? 0, top: position?.y ?? 0, zIndex: 40, visibility: position ? "visible" : "hidden" }}
    >
      <div className="canvas-action-menu" role="menu" aria-label="Agent actions" data-testid="seat-menu">
        {entries.map((entry) => <MultiMenuRow key={entry.key} entry={entry} />)}
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
      <ControlButton aria-label="Fit readable view" title="Fit readable view" onClick={() => fitReadableField(rf)}>
        <ScanLine size={14} />
      </ControlButton>
    </Controls>
  );
}

function RtsMinimapStack() {
  const rf = useReactFlow<FlowNode, FlowEdge>();
  const severityByNodeId = use$(state$.regionSeverityByNodeId) as Readonly<Record<string, string>>;
  const minimapTheme = themeFor(use$(themeMode$));
  const lastClickAt = useRef(0);
  const lastClickPos = useRef<{ x: number; y: number } | null>(null);

  // Agent seats paint their seat rollup (signal, proven attention, Jev's
  // reading, control state), the order their ring and name line use.
  const seatRollups = useSeatRollups();
  const ground = minimapTheme.ground!;
  const miniMapNodeColor = useCallback((node: Node): string => {
    const data = node.data as FlowNode["data"] | undefined;
    const canvasNode = data?.node;
    const severity = severityByNodeId[node.id] as MemberSeverity | undefined;
    if (canvasNode) return minimapNodeColors(canvasNode, severity, seatRollups.get(node.id), ground).fill;
    return HUE.amber;
  }, [severityByNodeId, seatRollups, ground]);
  const miniMapNodeStroke = useCallback((node: Node): string => {
    const data = node.data as FlowNode["data"] | undefined;
    const severity = severityByNodeId[node.id] as MemberSeverity | undefined;
    return minimapNodeColors(data?.node, severity, seatRollups.get(node.id), ground).stroke;
  }, [severityByNodeId, seatRollups, ground]);

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
      void withViewportBusy(() => rf.setCenter(position.x, position.y, {
        zoom: nextZoom,
        duration: 280,
      })).catch(() => undefined);
      return;
    }
    void withViewportBusy(() => rf.setCenter(position.x, position.y, {
      zoom,
      duration: 240,
    })).catch(() => undefined);
  }, [rf]);

  const onMiniMapNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    // Prefer unit pick over empty-map click bubbling.
    event.stopPropagation();
    selectNode(node.id);
    // Focus path = camera fit on the entity (same as command Focus / chip).
    state$.focusNodeId.set(node.id);
  }, []);

  // The map stays mounted for every pan/zoom frame — chrome must not blank.
  // FactoryMinimap applies the camera imperatively, so a pan costs it one
  // attribute write and no React work (see FactoryMinimap.tsx).
  return (
    <>
      <FactoryMinimap
        nodeColor={miniMapNodeColor}
        nodeStrokeColor={miniMapNodeStroke}
        nodeStrokeWidth={1.5}
        maskColor={withAlpha(minimapTheme.ground!, 0.72)}
        onClick={onMiniMapClick}
        onNodeClick={onMiniMapNodeClick}
        ariaLabel="Strategic minimap — click to move camera, double-click to zoom, click a node to focus"
        style={{ background: "color-mix(in oklab, var(--color-ground) 90%, transparent)", border: "1px solid var(--color-overlay-4)" }}
      />
      <FieldControls />
    </>
  );
}

function useCanvasGraph() {
  // Narrow React subscriptions: filters only. Doc/execution/selection
  // drive RF via onChange → setNodes so CanvasGraph does not re-render on
  // every kernel cycle.
  const edgeFilter = use$(state$.edgeFilter);
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
    edgeFilter,
    setNodes,
    setEdges,
    dragInProgressRef,
    pendingRebuildRef,
    flowCacheRef,
    rebuildTick,
  );
  useCanvasFilterViewport(edgeFilter, rf);
  useCanvasFocus(rf);
  useCanvasGroupFocus(rf);
  // One-shot fit request from the command bar "Fit view" action.
  useEffect(() => {
    return state$.fitViewRequest.onChange(() => {
      fitReadableField(rf);
    });
  }, [rf]);
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

// The connect gesture answers itself on the card. A wire being drawn used to
// raise a chip at the top of the canvas counting the ports the drop would
// mint ("allows 6 actions"): the port mask was the thing being authored, so
// its size was the thing to preview. An edge now carries one verb, the pair's
// verbs are offered as coloured halves of the card under the cursor, and a
// pair with no verb simply offers nothing to land on. A count of actions at
// the other end of the screen names neither the verb nor the card, and it
// still reads the retired role-pair grant rather than the verb table. So the
// gesture is silent, and the colour under the cursor is the whole answer.

function CanvasPerformanceBoundary({ children }: { readonly children: ReactNode }) {
  // Dev always profiles; a packaged build profiles only when JUNTO_PERF armed
  // the harness, which is also what makes the recorder non-null.
  if (!import.meta.env.DEV && !PERF_ENABLED) return children;
  return (
    <Profiler
      id="canvas"
      onRender={(_id, _phase, actualDuration) => {
        canvasPerformance.recordReactCommit("canvas", actualDuration);
      }}
    >
      {children}
    </Profiler>
  );
}

function CanvasGraph() {
  const { nodes, edges, onNodesChange, onEdgesChange, interactions, rf } = useCanvasGraph();
  const authoring = isCommandCenterAuthoring(use$(state$.settings.station.role));
  // Focus-zone presence (any kind) — the canvas delete/Escape keys must not
  // act through an open focus surface.
  const hasFocusSurfaces = use$(() =>
    dock$.registry.surfaces.get().some((s) => s.zone === "focus"),
  );
  const fieldTheme = themeFor(use$(themeMode$));
  // While a connection drag is live, every card shows its dots so targets are
  // discoverable mid-gesture.
  const connecting = useConnection((connection) => connection.inProgress);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [terminalAnchor, setTerminalAnchor] = useState<{ x: number; y: number } | null>(null);
  const [gitAnchor, setGitAnchor] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const openTerminal = (event: Event) => {
      const anchor = (event as CustomEvent<{ x: number; y: number }>).detail;
      // Host choice is a fleet surface; without it there is nothing to ask.
      if (!FLEET_UI_ENABLED) {
        void createTerminalAt(anchor);
        return;
      }
      setTerminalAnchor(anchor);
    };
    window.addEventListener("junto:new-terminal", openTerminal);
    return () => {
      window.removeEventListener("junto:new-terminal", openTerminal);
    };
  }, []);
  useEffect(() => {
    const openGit = (event: Event) => {
      const anchor = (event as CustomEvent<{ x: number; y: number }>).detail;
      if (createGitFromRegion(anchor)) return;
      setGitAnchor(anchor);
    };
    window.addEventListener("junto:new-git", openGit);
    return () => {
      window.removeEventListener("junto:new-git", openGit);
    };
  }, []);
  const [multiMenu, setMultiMenu] = useState<MultiMenuAnchor | null>(null);
  const [seatMenu, setSeatMenu] = useState<{ readonly x: number; readonly y: number; readonly seatId: string } | null>(null);
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
    setSeatMenu(null);
  }, []);
  const openContextMenu = useCallback((at: { x: number; y: number }) => {
    setMultiMenu(null);
    setConnectMenu(null);
    setSeatMenu(null);
    setCtxMenu(at);
  }, []);
  const openSeatMenu = useCallback((at: { x: number; y: number }, seatId: string) => {
    setCtxMenu(null);
    setMultiMenu(null);
    setConnectMenu(null);
    setSeatMenu({ ...at, seatId });
  }, []);
  const closeMultiMenu = useCallback(() => setMultiMenu(null), []);
  const openMultiMenu = useCallback((anchor: MultiMenuAnchor) => {
    setCtxMenu(null);
    setConnectMenu(null);
    setSeatMenu(null);
    setMultiMenu(anchor);
  }, []);
  const openConnectMenu = useCallback((
    at: { x: number; y: number },
    targetId: string,
    sourceIds: ReadonlyArray<string>,
  ) => {
    setCtxMenu(null);
    setMultiMenu(null);
    setSeatMenu(null);
    setConnectMenu({ ...at, targetId, sourceIds });
  }, []);
  const onPaneContextMenu = useCallback((event: React.MouseEvent | MouseEvent) => {
    event.preventDefault();
    if (!isCommandCenterAuthoring(state$.settings.station.role.peek())) return;
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
      openMultiMenu({ kind: "point", x: event.clientX, y: event.clientY });
      return;
    }
    const seat = node.data?.node;
    if (seat && isAgentSeatNode(seat)) {
      event.preventDefault();
      openSeatMenu({ x: event.clientX, y: event.clientY }, seat.id);
      return;
    }
    if (!isGroup) return;
    event.preventDefault();
    openContextMenu({ x: event.clientX, y: event.clientY });
  }, [rf, openContextMenu, openMultiMenu, openConnectMenu, openSeatMenu, closeMenus]);
  // Right-click on the rubber-band selection itself (not a single node).
  const onSelectionContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    openMultiMenu({ kind: "point", x: event.clientX, y: event.clientY });
  }, [openMultiMenu]);
  // A finished rubber-band pick of 2+ nodes opens the menu beside its box.
  // React Flow fires this only when a marquee actually moved, so shift-click
  // adds and node drags never reach it. Read after a frame so the controlled
  // node list carries the final selection.
  const onSelectionEnd = useCallback(() => {
    requestAnimationFrame(() => {
      const selected = rf.getNodes().filter((node) => node.selected);
      if (selected.length < 2) return;
      const bounds = rf.getNodesBounds(selected);
      const topLeft = rf.flowToScreenPosition({ x: bounds.x, y: bounds.y });
      const bottomRight = rf.flowToScreenPosition({ x: bounds.x + bounds.width, y: bounds.y + bounds.height });
      openMultiMenu({ kind: "rect", rect: { left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y } });
    });
  }, [rf, openMultiMenu]);
  const onPaneClick = useCallback((event: React.MouseEvent) => {
    closeMenus();
    interactions.onPaneClick(event);
  }, [interactions.onPaneClick, closeMenus]);

  /** Drop / paste images onto the field → content store → image file nodes. */
  const placeImagesAt = useCallback(
    async (data: DataTransfer | null | undefined, flow: { x: number; y: number }) => {
      const result = await putImagesFromDataTransfer(data);
      if (result.kind === "none") return false;
      if (result.kind === "error") {
        state$.error.set(result.error);
        return true;
      }
      let offset = 0;
      for (const ref of result.refs) {
        const node = makeImageNode(
          flow.x + offset,
          flow.y + offset,
          contentObjectUrl(ref),
        );
        addNode(node, { edit: false });
        state$.focusNodeId.set(node.id);
        offset += 24;
      }
      return true;
    },
    [],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      if (!event.dataTransfer) return;
      // Only intercept file drops; node/edge RF drags stay native.
      if (![...event.dataTransfer.types].includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      const flow = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      void placeImagesAt(event.dataTransfer, {
        x: flow.x - 140,
        y: flow.y - 100,
      });
    },
    [rf, placeImagesAt],
  );

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      const data = event.clipboardData;
      if (!data) return;
      const hasImageItem =
        Array.from(data.items ?? []).some(
          (item) => item.kind === "file" && item.type.startsWith("image/"),
        ) ||
        Array.from(data.files ?? []).some((file) => file.type.startsWith("image/"));
      if (!hasImageItem) return;
      // Must cancel default paste synchronously before the async put.
      event.preventDefault();
      const center = rf.screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });
      void placeImagesAt(data, { x: center.x - 140, y: center.y - 100 });
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [rf, placeImagesAt]);

  // Shift multi-select is product law: a shift+primary press on a node is
  // additive selection — never open, rename, edit, or React Flow's own
  // marquee. React Flow's pane capture handler (an ancestor of the node
  // shell) runs before the per-node shell handlers and would swallow the
  // event, so the dominance handler lives at window capture: it fires first,
  // toggles the node in the selection, and stops the event from ever
  // reaching the pane or any node chrome.
  const rfStore = useStoreApi();
  useEffect(() => {
    const dominateShiftMultiSelect = (event: PointerEvent): void => {
      if (!event.shiftKey || event.button !== 0) return;
      if (isEditableEventTarget(event.target)) return;
      const target = event.target instanceof Element ? event.target : null;
      const nodeElement = target?.closest(".react-flow__node") ?? null;
      const nodeId = nodeElement?.getAttribute("data-id");
      if (nodeElement === null || nodeId === null || nodeId === undefined) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const state = rfStore.getState();
      if (!state.multiSelectionActive) {
        rfStore.setState({ multiSelectionActive: true });
      }
      const node = state.nodeLookup.get(nodeId);
      if (node === undefined) return;
      if (!node.selected) {
        state.addSelectedNodes([nodeId]);
      } else {
        state.unselectNodesAndEdges({ nodes: [node], edges: [] });
      }
    };
    window.addEventListener("pointerdown", dominateShiftMultiSelect, {
      capture: true,
    });
    return () =>
      window.removeEventListener("pointerdown", dominateShiftMultiSelect, {
        capture: true,
      });
  }, [rfStore]);

  // Boolean only — flips when a cone appears/clears, not on every kernel tick.
  const impactMode = use$(impactModeActive$);
  const connectionFocusNodeId = use$(state$.connectionFocusNodeId);
  // Viewport freeze without React: viewport-busy stamps html[data-viewport-busy]
  // directly, so a pan gesture costs zero renders and no canvas render can
  // clear it mid-gesture. MiniMap stays mounted.
  useEffect(() => () => resetViewportBusy(), []);
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

  return <CanvasPerformanceBoundary><>
    {terminalAnchor ? <TerminalWizard anchor={terminalAnchor} onClose={() => setTerminalAnchor(null)} /> : null}
    {gitAnchor ? <GitWizard anchor={gitAnchor} onClose={() => setGitAnchor(null)} /> : null}
    <ReactFlow
      className={[
        connecting ? "is-connecting" : "",
        impactMode ? (connectionFocusNodeId ? "connection-focus-mode" : "impact-mode") : "",
      ].filter(Boolean).join(" ") || undefined}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      {...interactions}
      onEdgeDoubleClick={interactions.onEdgeDoubleClick}
      onPaneClick={onPaneClick}
      onPaneContextMenu={onPaneContextMenu}
      onNodeContextMenu={onNodeContextMenu}
      onSelectionContextMenu={onSelectionContextMenu}
      onSelectionEnd={onSelectionEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onMoveStart={onMoveStart}
      onMove={onMove}
      onMoveEnd={onMoveEnd}
      nodesDraggable={authoring}
      nodesConnectable={authoring}
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
      deleteKeyCode={
        // xyflow binds Delete/Backspace at the document level, so the chord
        // reaches the canvas even while the operator works inside a focus
        // surface (browser page chrome, note draft chrome). While a focus-zone
        // surface exists the canvas has no delete key; pinned docks stay out
        // of this gate.
        hasFocusSurfaces ? null : ["Backspace", "Delete"]
      }
      elevateNodesOnSelect={false}
      elevateEdgesOnSelect
      fitView
      fitViewOptions={{ padding: 0.18, maxZoom: 1.35 }}
      minZoom={0.15}
      maxZoom={2.5}
      proOptions={{ hideAttribution: true }}
      style={{ background: fieldTheme.ground }}
    >
      {/* No painted ground pattern: any pattern inside the composited viewport
          pays per-tile raster on every pan frame (see styles.css note above the
          busy gate); React Flow's <Background> re-rendered a full-window SVG
          pattern per viewport change, which was worse. Flat ground wins. */}
      <ViewportTransformLease />
      <CanvasLoom edges={edges} />
      <WirePulseFeed edges={edges} />
      <CanvasMagnifier />
      <CanvasKeyboardPan />
      <RegionGlanceGate />
      <CanvasTierGate />
      <ImpactSeedChip />
      {/* Bar (incl. MiniMap) must be a ReactFlow child so MiniMap binds to the instance. */}
      <Panel position="bottom-center" className="rts-bar-panel" style={{ width: "100%", margin: 0, left: 0, right: 0, transform: "none", maxWidth: "none" }}>
        <RtsBottomBar tools={<CanvasFieldTools />} minimap={<RtsMinimapStack />} />
      </Panel>
    </ReactFlow>
    {ctxMenu ? <ContextModeDeck at={ctxMenu} onClose={() => setCtxMenu(null)} /> : null}
    {multiMenu ? <MultiSelectMenu anchor={multiMenu} onClose={closeMultiMenu} /> : null}
    {seatMenu ? <SeatMenu at={seatMenu} seatId={seatMenu.seatId} onClose={() => setSeatMenu(null)} /> : null}
    <SquadDialogHost />
    <ProfileDialogHost />
    {connectMenu ? (
      <TargetConnectMenu
        at={{ x: connectMenu.x, y: connectMenu.y }}
        targetId={connectMenu.targetId}
        sourceIds={connectMenu.sourceIds}
        onClose={() => setConnectMenu(null)}
      />
    ) : null}
  </></CanvasPerformanceBoundary>;
}

export function Canvas() {
  return <div className="h-full w-full"><CanvasGraph /></div>;
}
