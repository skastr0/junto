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
import type { Connection, EdgeMouseHandler, FinalConnectionState, Node, OnBeforeDelete, OnNodeDrag } from "@xyflow/react";
import { use$ } from "@legendapp/state/react";
import { executionGraphContextFromActorRefs } from "@shared/graph";
import { Activity, BookmarkPlus, Boxes, Expand, LayoutGrid, Link2, MessageSquare, OctagonX, Pencil, Plus, ScanLine, ScrollText, SquareDashed, Trash2, Unlink, UserRoundPen, Users, X } from "lucide-react";
import {
  clearSelection,
  replaceSelection,
  selectEdge,
  selectNode,
  state$,
} from "../lib/state";
import { kernel$ } from "../lib/kernel-view";
import { dock$ } from "../lib/dock-state";
import { openingAnchors, openingViewport } from "../lib/camera-placement";
import { leaveCamera, takeCamera } from "../canvas/shell/camera-handoff";
import { keepHeldNodes } from "../lib/flow-identity";
import type { FlowEdge, FlowNode } from "../lib/convert";
import { createFlowIdentityCache, toFlowOfCanvas } from "../lib/convert";
import {
  edgeImpactClass,
  edgeImpactRole,
  connectionFocusSelection,
  impactModeActive$,
  nodeImpactClass,
  selectionImpact,
  type ImpactSelection,
} from "../lib/impact-mode";
import { regionLabelDrag$ } from "../lib/region-label-drag";
import { canvasZoomRequest$ } from "../lib/canvas-zoom";
import { useMenuDismiss } from "../lib/menu-dismiss";
import { topModal } from "../lib/modal-stack";
import { CANVAS_DELETE_KEY_CODE, canvasKeyboardTaken } from "../lib/canvas-keys";
import { claimFocus, recentGestureKind } from "../lib/focus-ownership";
import { isEditableEventTarget, toggleInSelection } from "../lib/multi-select-gesture";
import { AGENT_NODE_SIZE } from "../lib/node-geometry";
import { addNode, deleteNodes } from "../lib/mutations";
import { addEdge, canConnect, connectAllToTarget, connectMesh, deleteEdges, disconnectWithin, meshPlanOn, wireIdsWithin } from "../lib/edge-mutations";
import { agentCountLabel, seatIdsAmong } from "../lib/multi-selection";
import type { Node as ModelNode } from "@shared/model";
import { inPaintOrder, type Canvas } from "@shared/model/canvas";
import { openAgentEditor } from "../lib/agent-editor-state";
import { broadcastMenuHint, broadcastToSelection, planAgentBroadcast } from "../lib/agent-broadcast";
import { planSeatMessageFor } from "../lib/seat-message";
import { SeatMessageForm } from "./nodes/SeatMessage";
import { SeatOffboardMenuRows } from "./nodes/SeatOffboard";
import { AGENT_BROADCAST_PROMPTS, type AgentBroadcastKind } from "@shared/agent-broadcast-prompts";
import { placeAtPoint, placeBesideRect, type ScreenRect } from "../lib/menu-placement";
import { findOpenPosition, syncPositions } from "../lib/geometry";
import { observe } from "@legendapp/state";
import { heldBy } from "../lib/model-edits";
import { modelStore, nodeAt, titleAt, useCanvas } from "../lib/use-model";
import { spokenNodeName } from "../lib/flow-nodes";
import { nodeSpokenKind$, nodeStatus$ } from "../lib/node-status";
import { seatTasks$ } from "../lib/seat-tasks";
import { endReachPreview, startReachPreview, updateReachPreview } from "../lib/reach-preview";
import { resolvePageSpawnDefaults } from "@shared/region-defaults";
import { thisMachineName } from "../lib/machines";
import "../styles/factory-grammar.css";
import "../styles/canvas-lod.css";
import "../styles/canvas-lod-regions.css";
import "../styles/reach-preview.css";
import {
  newArtifacts, newAutomations, newRegion, newImage,
  newLabel, newSeat, newPage, newTaskBoard, newNote,
} from "../lib/model-factories";
import { topZ } from "../lib/model-edits";
import { useContentCalls, type ContentCalls } from "../lib/content-calls";
import { putImagesFromDataTransfer } from "../lib/image-content";
import { contentObjectUrl } from "@shared/content-url";
import {
  ARTIFACTS_ENABLED,
  BROWSER_ENABLED,
  FLEET_UI_ENABLED,
  TASKS_ENABLED,
} from "@shared/features";
import { HUE, themeFor, withAlpha } from "../lib/theme";
import { themeMode$ } from "../lib/theme-mode";
import type { MemberSeverity } from "@shared/region-rollup";
import { minimapNodeColors, useSeatRollups } from "../lib/minimap-seat-colors";
import { seatUrgency$ } from "../lib/region-urgency";
import { nodeTypes } from "./nodes";
import { edgeTypes } from "./edges/WireEdge";
import { CanvasLoom } from "./edges/CanvasLoom";
import { WirePulseFeed } from "./edges/WirePulseFeed";
import { saveSelectionToCommandGroup } from "../lib/command-group-runtime";
import { SaveToGroupPicker } from "./rts/SaveToGroupPicker";
import { SquadDialogHost } from "./squads/SquadDialog";
import { openSaveSquad, placeSquadInSlot } from "../lib/squads-state";
import { openSaveProfile, placeProfileInSlot } from "../lib/profiles-state";
import { ProfileDialogHost } from "./profiles/ProfileDialog";
import { ProfileDraftEditorHost } from "./profiles/ProfileDraftEditor";
import { openProfileDraft } from "../lib/profile-draft-state";
import { TerminalWizard, createTerminalAt } from "./terminal/TerminalWizard";
import { openTerminalGrid } from "../lib/terminal-grid-state";
import { GitWizard, createGitFromRegion } from "./git/GitWizard";
import { FilesWizard, createFilesFromRegion } from "./files/FilesWizard";
import { featureOnNow } from "../lib/experimental-features";
import { CanvasMagnifier } from "./CanvasMagnifier";
import { LegacyCanvasApiProvider } from "../canvas/shell/LegacyCanvasApi";
import { makeAddActions, ModeDeckFocus, onTop } from "./CanvasFieldTools";
import { CanvasKeyboardPan } from "./CanvasKeyboardPan";
import { RegionGlanceGate } from "./RegionGlanceGate";
import { CanvasTierGate } from "./CanvasTierGate";
import { SeatClusterLayer } from "./SeatClusterLayer";
import { RegionUrgencyGate } from "./RegionUrgencyGate";
import { canvasPerformance } from "../lib/performance/canvas-performance";
import { PERF_ENABLED } from "../lib/performance/perf-flag";
import { CountedSurface } from "../lib/performance/surface-commits";
import { useCanvasGroupFocus } from "./useCanvasGroupFocus";

/**
 * A node's class: agents carry junto-flow-agent (convert.ts), which keeps them
 * on the board at the overview tier; the impact class rides alongside.
 */
const flowNodeClass = (node: FlowNode, impactClass: string | undefined): string | undefined =>
  node.data.seatRegion !== undefined ? (impactClass ? `junto-flow-agent ${impactClass}` : "junto-flow-agent") : impactClass;

/**
 * What a node says to a screen reader: its name, and that it is selected.
 * The node's role (group) carries no selected state of its own, so the name
 * is where a reader hears it.
 */
const flowNodeLabel = (node: FlowNode, selected: boolean): string => {
  const spoken = spokenNodeName(
    titleAt(node.data.canvas, node.id),
    node.data.kind,
    node.data.blocked,
    nodeStatus$[node.id].peek(),
    nodeSpokenKind$[node.id].peek(),
  );
  return selected ? `${spoken}, selected` : spoken;
};

type CanvasNodeRef = { readonly id: string; readonly type?: string; readonly position: { readonly x: number; readonly y: number }; readonly data?: unknown; readonly selected?: boolean };
type CanvasFlow = {
  readonly fitView: (options?: { readonly nodes?: Array<CanvasNodeRef>; readonly padding?: number; readonly duration?: number; readonly maxZoom?: number }) => Promise<boolean>;
  readonly setViewport: (viewport: { readonly x: number; readonly y: number; readonly zoom: number }) => Promise<boolean>;
  readonly getNode: (id: string) => CanvasNodeRef | undefined;
  readonly getNodes: () => ReadonlyArray<CanvasNodeRef>;
  readonly screenToFlowPosition: (position: { readonly x: number; readonly y: number }) => { readonly x: number; readonly y: number };
};

/** A region's name, for choosing what the camera shows. */
const regionLabelOf = (node: CanvasNodeRef): string =>
  titleAt((node.data as FlowNode["data"]).canvas, node.id);

const fitReadableField = (rf: CanvasFlow, duration = 320): void => {
  const graphNodes = rf.getNodes();
  const regions = graphNodes.filter((node) => node.type === "group");
  const anchors = [...openingAnchors(graphNodes, regionLabelOf)];
  void rf.fitView({
    nodes: anchors,
    padding: 0.18,
    duration,
    maxZoom: regions.length > 0 ? 1.15 : 1.35,
  }).catch(() => undefined);
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

/** The nodes of a canvas named by `ids`, in paint order. */
const selectedOn = (canvas: Canvas, ids: ReadonlySet<string>): ReadonlyArray<ModelNode> =>
  inPaintOrder(canvas).filter((node) => ids.has(node.id));

const currentExecutionGraphContext = () =>
  executionGraphContextFromActorRefs(
    state$.canvasName.peek(),
    state$.actorRefs.peek(),
    seatTasks$.bySeat.peek(),
  );

const selectionForCanvas = (
  selectedNodeId: string,
  context: ReturnType<typeof currentExecutionGraphContext>,
): ImpactSelection => {
  const connectionFocusNodeId = state$.connectionFocusNodeId.peek();
  const canvas = modelStore.canvasOf(context.canvasName);
  if (connectionFocusNodeId) {
    return connectionFocusSelection(canvas, connectionFocusNodeId);
  }
  return selectedNodeId
    ? selectionImpact(canvas, selectedNodeId, kernel$.execution.peek(), context)
    : selectionImpact(canvas, "", null, context);
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
      const className = flowNodeClass(node, nodeImpactClass(impact.active, impact.cone, node.id));
      const ariaLabel = flowNodeLabel(node, selected);
      if (node.selected === selected && node.className === className && node.ariaLabel === ariaLabel) return node;
      return { ...node, selected, className, ariaLabel };
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
): void {
  const built = toFlowOfCanvas(
    modelStore.canvasOf(state$.canvasName.peek()),
    currentExecutionGraphContext(),
    kernel$.execution.peek(),
    flowCache,
  );
  const nodeId = state$.selectedNodeId.peek();
  const nodeIds = state$.selectedNodeIds.peek();
  const edgeId = state$.selectedEdgeId.peek();
  // Selection + impact cone classes live on the RF shell (not Flow data).
  const stamped = stampImpactShell(built.nodes, built.edges, nodeId, nodeIds, edgeId);
  // The command bar filters a LIST, never the graph: canvas search thinning
  // was retired with the station search field.
  const nextNodes = stamped.nodes;
  const nextEdges = stamped.edges;

  // React Flow keeps every node object that still says what the rebuild
  // says, with what it measured for it, so a change to ten cards replaces ten
  // nodes and renders ten cards (flow-identity.ts). A rebuild that changes
  // nothing hands back the same array and tells React Flow nothing.
  setNodes((prev) => keepHeldNodes(prev, nextNodes));
  setEdges((prev) =>
    prev.length === nextEdges.length && prev.every((edge, i) => edge === nextEdges[i])
      ? prev
      : nextEdges,
  );
}

function useCanvasDocument(
  setNodes: ReturnType<typeof useNodesState<FlowNode>>[1],
  setEdges: ReturnType<typeof useEdgesState<FlowEdge>>[1],
  dragInProgressRef: React.MutableRefObject<boolean>,
  pendingRebuildRef: React.MutableRefObject<boolean>,
  flowCacheRef: React.MutableRefObject<ReturnType<typeof createFlowIdentityCache>>,
  rebuildTick: number,
) {
  const rebuild = useCallback(() => {
    // A drag owns node positions until it commits — queue structural remints.
    if (dragInProgressRef.current || regionLabelDrag$.peek()) {
      pendingRebuildRef.current = true;
      return;
    }
    pendingRebuildRef.current = false;
    applyStructuralRebuild(
      setNodes,
      setEdges,
      flowCacheRef.current,
    );
  }, [
    setNodes,
    setEdges,
    dragInProgressRef,
    pendingRebuildRef,
    flowCacheRef,
  ]);

  // Post-drag flush — React-driven.
  useEffect(() => {
    rebuild();
  }, [rebuild, rebuildTick]);

  // Canvas + kernel ticks — apply via setNodes without re-rendering CanvasGraph.
  // (use$ on these would re-render the whole React Flow tree every cycle.)
  useEffect(() => {
    const offs = [
      // Any node or wire of the open canvas: a move, a resize, a rename, one
      // added or removed. What the projection reads off positions (a wire's
      // sockets, a region's name slot, a seat's ring room) follows a move.
      // The projection keeps every flow node and edge that did not change.
      observe(() => {
        const open$ = modelStore.canvas$(state$.canvasName.get());
        open$.nodes.get();
        open$.wires.get();
        rebuild();
      }),
      // What is blocked depends on the tasks each seat holds, which the app
      // keeps for the open canvas.
      observe(() => {
        seatTasks$.bySeat.get();
        rebuild();
      }),
      state$.actorRefs.onChange(() => rebuild()),
      kernel$.executionRev.onChange(() => rebuild()),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [rebuild]);

  // Region label drag committed — flush any rebuild deferred mid-drag.
  useEffect(() => {
    return regionLabelDrag$.onChange(() => {
      if (!regionLabelDrag$.peek() && pendingRebuildRef.current) rebuild();
    });
  }, [rebuild, pendingRebuildRef]);

  // Selection + impact-mode sync — light map over the existing graph.
  // Structural rebuild already stamps on doc/execution ticks; this path is
  // selection-only so CanvasGraph need not subscribe to selected ids.
  useEffect(() => {
    const syncSelection = () => {
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
          const className = flowNodeClass(node, nodeImpactClass(impact.active, impact.cone, node.id));
          const ariaLabel = flowNodeLabel(node, selected);
          // React Flow marks a node selected itself, so the name is compared too.
          if (node.selected === selected && node.className === className && node.ariaLabel === ariaLabel) return node;
          dirty = true;
          return { ...node, selected, className, ariaLabel };
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
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [setNodes, setEdges]);

  // A card's status tag changes its spoken name, and only its own: the ids
  // that changed are gathered and relabelled once per microtask, so hundreds
  // of cards publishing at mount cost one pass, and selection, impact and
  // classes are not recomputed.
  useEffect(() => {
    const changed = new Set<string>();
    let queued = false;
    const flush = () => {
      queued = false;
      const ids = new Set(changed);
      changed.clear();
      setNodes((nodes) => {
        let dirty = false;
        const next = nodes.map((node) => {
          if (!ids.has(node.id)) return node;
          const ariaLabel = flowNodeLabel(node, node.selected === true);
          if (node.ariaLabel === ariaLabel) return node;
          dirty = true;
          return { ...node, ariaLabel };
        });
        return dirty ? next : nodes;
      });
    };
    const mark = ({ changes }: { readonly changes: ReadonlyArray<{ readonly path: ReadonlyArray<string | number> }> }) => {
      for (const change of changes) {
        const id = change.path[0];
        if (typeof id === "string") changed.add(id);
      }
      if (queued || changed.size === 0) return;
      queued = true;
      queueMicrotask(flush);
    };
    const offs = [nodeStatus$.onChange(mark), nodeSpokenKind$.onChange(mark)];
    return () => {
      for (const off of offs) off();
    };
  }, [setNodes]);
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
        void rf.fitView({
          nodes: [node],
          padding: 0.35,
          maxZoom: 1.45,
          duration: 360,
        }).catch(() => undefined).finally(() => {
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

function useCanvasViewport(nodes: ReadonlyArray<FlowNode>, rf: CanvasFlow) {
  const placedRef = useRef("");
  const canvasName = use$(state$.canvasName);
  // The pane has a size, and the camera can be set, once React Flow has seen
  // its element.
  const paneWidth = useStore((store) => store.width);
  const paneHeight = useStore((store) => store.height);
  const minZoom = useStore((store) => store.minZoom);
  const ready = useStore((store) => store.panZoom !== null);
  // The camera is placed once for a canvas, the moment it has cards: on what
  // the canvas opens on, worked out from the size each card is drawn at, with
  // no glide and before the frame is painted. Nothing waits for a card to be
  // measured, so the canvas is where it will stay before anyone can touch it,
  // whether its cards arrive in one step or several.
  useLayoutEffect(() => {
    if (!ready || !canvasName || placedRef.current === canvasName) return;
    // A camera handed across the GPU canvas switch wins over the opening one.
    const viewport = takeCamera(canvasName) ?? openingViewport(nodes, regionLabelOf, { width: paneWidth, height: paneHeight }, minZoom);
    if (viewport === undefined) return;
    placedRef.current = canvasName;
    void rf.setViewport(viewport);
  }, [ready, canvasName, nodes, paneWidth, paneHeight, minZoom, rf]);
  // Unmounting (the GPU canvas switch), leave the camera for the next canvas.
  const storeApi = useStoreApi();
  useEffect(() => () => {
    const placed = placedRef.current;
    if (!placed || state$.canvasName.peek() !== placed) return;
    const [x, y, zoom] = storeApi.getState().transform;
    leaveCamera(placed, { x, y, zoom });
  }, [storeApi]);
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
    const canvas = state$.canvasName.peek();
    return canConnect(nodeAt(canvas, sourceId), nodeAt(canvas, targetId));
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
    // The card under the drop, from the store. A region is not a target; the
    // wire writer refuses one too, and a card that has gone.
    const targetNode = nodeAt(state$.canvasName.peek(), targetId);
    if (!targetNode || targetNode.kind === "region") return;
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
  // Idempotent — safe when both onNodeDragStop and pointerup fire. `dropped`
  // is what React Flow says the dragged nodes ended on: it applies the last
  // step of a drag as the drag ends, so those are the places to take, over
  // whatever the node list held a moment earlier.
  const finishDrag = useCallback((sync: boolean, dropped: ReadonlyArray<FlowNode> = []) => {
    if (!dragInProgressRef.current) return;
    holdDragRef.current = null;
    endReachPreview();
    // The drag is over before the drop is sent, not after. The Move shows in
    // the store at once, and the canvas is rebuilt from the store in the same
    // turn, which sets each dropped card on the whole-number place the model
    // holds. With the latch still set that rebuild was put off to a later
    // frame, so the cards moved once at the drop and once more after it, and
    // everything that reads their geometry ran twice.
    dragInProgressRef.current = false;
    if (sync) {
      const positions = new Map<string, { x: number; y: number }>();
      for (const node of rf.getNodes()) positions.set(node.id, node.position);
      for (const node of dropped) positions.set(node.id, node.position);
      syncPositions(positions);
    }
    if (pendingRebuildRef.current) {
      pendingRebuildRef.current = false;
      flushRebuild();
    }
  }, [rf, dragInProgressRef, pendingRebuildRef, flushRebuild]);

  // Recover from pointercancel / missing dragStop / unmount so rebuilds never stick.
  // This is the fallback and never the first to act: the pointer goes up
  // before React Flow has ended its drag and applied the last step, so taking
  // the positions here left the cards one step short of where they were let
  // go, and the rebuild then moved them back. It waits a frame, by which time
  // onNodeDragStop has taken the drop if there was a drag to end.
  useEffect(() => {
    const onPointerEnd = () => {
      if (!dragInProgressRef.current) return;
      requestAnimationFrame(() => finishDrag(true));
    };
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    return () => {
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      // Unmount mid-drag: drop latch without writing RF positions into a dying tree.
      if (dragInProgressRef.current) {
        dragInProgressRef.current = false;
        holdDragRef.current = null;
        endReachPreview();
        pendingRebuildRef.current = false;
      }
    };
  }, [finishDrag, dragInProgressRef, pendingRebuildRef]);

  const onNodeDragStart: OnNodeDrag<FlowNode> = useCallback((_event, node) => {
    dragInProgressRef.current = true;
    holdDragRef.current = null;
    // What the drop would do to reach shows before the drop (01 rule 6).
    startReachPreview(modelStore.canvasOf(node.data.canvas), seatTasks$.bySeat.peek());
    const region = nodeAt(node.data.canvas, node.id);
    if (region?.kind !== "region" || !region.hold) return;
    const startPositions = new Map<string, { x: number; y: number }>();
    for (const id of heldBy(modelStore.canvasOf(node.data.canvas), node.id)) {
      const member = rf.getNode(id);
      if (!member || member.selected) continue;
      startPositions.set(id, member.position);
    }
    holdDragRef.current = { regionId: node.id, regionStart: node.position, startPositions };
  }, [rf, dragInProgressRef]);
  const onNodeDrag: OnNodeDrag<FlowNode> = useCallback((_event, node, dragged) => {
    const positions = new Map<string, { x: number; y: number }>();
    for (const moving of dragged) positions.set(moving.id, moving.position);
    positions.set(node.id, node.position);
    const drag = holdDragRef.current;
    if (drag && node.id === drag.regionId && drag.startPositions.size > 0) {
      const dx = node.position.x - drag.regionStart.x;
      const dy = node.position.y - drag.regionStart.y;
      for (const [id, start] of drag.startPositions) positions.set(id, { x: start.x + dx, y: start.y + dy });
      setNodes((nodes) => nodes.map((n) => {
        const start = drag.startPositions.get(n.id);
        return start ? { ...n, position: { x: start.x + dx, y: start.y + dy } } : n;
      }));
    }
    updateReachPreview(positions, node.id);
  }, [setNodes]);
  const onNodeDragStop: OnNodeDrag<FlowNode> = useCallback((_event, _node, dropped) => {
    finishDrag(true, dropped);
  }, [finishDrag]);
  // React Flow drops what the delete key names from its own view before it
  // reports the deletion, and the document's delete can still refuse (the
  // confirm, a page that will not stop). So the key never deletes in React
  // Flow: it hands the request to the document, and the rebuild that follows
  // a real delete is what removes the card.
  const onBeforeDelete: OnBeforeDelete<FlowNode, FlowEdge> = useCallback(async ({ nodes: doomedNodes, edges: doomedEdges }) => {
    // The chord reaches the canvas from under a focus surface or a modal, and
    // the delete is refused here, while the key itself stays bound: xyflow
    // never clears the keys it saw while a chord was bound, so unbinding it
    // swallowed the first delete after the modal closed (11, Q6 walk).
    if (canvasKeyboardTaken(dock$.registry.surfaces.peek().length > 0, topModal() !== undefined)) return false;
    // Deleting mid-drag would otherwise leave the rebuild latch stuck.
    if (dragInProgressRef.current) finishDrag(false);
    // A node takes its wires with it; wires alone are a wire delete.
    if (doomedNodes.length > 0) deleteNodes(doomedNodes.map((node) => node.id));
    else deleteEdges(doomedEdges.map((edge) => edge.id));
    return false;
  }, [dragInProgressRef, finishDrag]);
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
    addNode(newNote(onTop({ x: pos.x - 120, y: pos.y - 50 })));
  }, [rf]);
  return {
    onConnect,
    onConnectEnd,
    isValidConnection,
    onNodeDragStart,
    onNodeDrag,
    onNodeDragStop,
    onBeforeDelete,
    onEdgeDoubleClick,
    onSelectionChange,
    onPaneClick,
  };
}

const MENU_ITEMS = "button:not(:disabled)";

/**
 * The canvas menus are vertical toolbars of buttons, not ARIA menus: their
 * rows are buttons (and one holds a group of buttons), which a menu may not
 * contain, and every surface that looks a row up finds a button.
 *
 * A canvas menu worked by keyboard: opened by a key, focus enters at its
 * first row; the arrows, Home and End move between rows; Escape closes it;
 * and closing hands focus back to where it came from. A menu opened by the
 * pointer leaves focus alone, so a marquee never moves it.
 */
const useMenuKeys = (
  menuRef: React.RefObject<HTMLDivElement | null>,
  shown: boolean,
  onClose: () => void,
): ((event: React.KeyboardEvent) => void) => {
  useEffect(() => {
    if (!shown || recentGestureKind() !== "key") return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    claimFocus(menuRef.current?.querySelector<HTMLElement>(MENU_ITEMS), "open");
    return () => {
      const held = document.activeElement;
      // Hand focus back only when the menu still held it as it closed.
      if (opener?.isConnected && (held === null || held === document.body)) claimFocus(opener, "open");
    };
  }, [menuRef, shown]);
  return (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step === 0 && event.key !== "Home" && event.key !== "End") return;
    const rows = [...(menuRef.current?.querySelectorAll<HTMLElement>(MENU_ITEMS) ?? [])];
    if (rows.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home" ? 0
      : event.key === "End" ? rows.length - 1
      : at === -1 ? (step === 1 ? 0 : rows.length - 1)
      : (at + step + rows.length) % rows.length;
    claimFocus(rows[next], "gesture", { event: event.nativeEvent });
  };
};

// Right-click on empty canvas opens the same centered surface. Its placement
// strategy stays bound to the click, independent of where the modal renders.
function ContextModeDeck({ at, onClose }: { readonly at: { x: number; y: number }; readonly onClose: () => void }) {
  const rf = useReactFlow<FlowNode, FlowEdge>();
  const positionFor = (size: { width: number; height: number }) => {
    const point = rf.screenToFlowPosition({ x: at.x, y: at.y });
    return { x: Math.round(point.x - size.width / 2), y: Math.round(point.y - size.height / 2) };
  };
  const content = useContentCalls();
  const actions = makeAddActions(positionFor, onClose, content);
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

/** The multi-select menu's last agent rows: saving the selection for reuse. */
const SAVE_ROW_KEYS: ReadonlySet<string> = new Set(["profile", "squad"]);

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
  const selectionKey = useStore((store) => store.nodes.filter((node) => node.selected).map((node) => node.id).join(" "));
  const openedWith = useRef(selectionKey);
  useEffect(() => {
    if (selectionKey !== openedWith.current) onClose();
  }, [selectionKey, onClose]);

  // "message" turns the menu into a composer in place: same spot, same
  // selection, and the selection changing still closes it.
  const [composing, setComposing] = useState(false);

  const hostRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ readonly x: number; readonly y: number } | null>(null);
  // Hidden until placed: focus can only enter once it shows.
  const menuRef = useRef<HTMLDivElement>(null);
  const onMenuKeyDown = useMenuKeys(menuRef, position !== null && !composing, onClose);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const size = { width: host.offsetWidth, height: host.offsetHeight };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    setPosition(anchor.kind === "rect" ? placeBesideRect(anchor.rect, size, viewport) : placeAtPoint(anchor, size, viewport));
  }, [anchor, composing]);

  const selectedIds = new Set(selectionKey.split(" ").filter(Boolean));
  const count = selectedIds.size;
  // The selection as the store holds it, in paint order: its seats, what a
  // mesh between them would add, what already runs between them, and who a
  // broadcast would reach.
  const held = modelStore.canvasOf(state$.canvasName.peek());
  const agentIds = seatIdsAmong(selectedOn(held, selectedIds));
  const agents = agentCountLabel(agentIds.length);
  const meshAdds = meshPlanOn(held, agentIds).toAdd.length;
  const innerEdges = wireIdsWithin(held, agentIds).length;
  const broadcast = planAgentBroadcast(selectedOn(held, new Set(agentIds)));
  const reachable = planSeatMessageFor(agentIds).targets.length;

  const run = (mutate: (ids: ReadonlyArray<string>) => void) => {
    mutate(rf.getNodes().filter((node) => node.selected).map((node) => node.id));
    onClose();
  };
  const runOnAgents = (act: (agentIds: ReadonlyArray<string>) => void) => () => {
    const live = new Set(rf.getNodes().filter((node) => node.selected).map((node) => node.id));
    act(seatIdsAmong(selectedOn(modelStore.canvasOf(state$.canvasName.peek()), live)));
    onClose();
  };
  const broadcastEntry = (kind: AgentBroadcastKind, icon: ReactNode): MultiMenuEntry | null => {
    const prompt = AGENT_BROADCAST_PROMPTS[kind];
    return {
      key: kind,
      label: prompt.label,
      detail: broadcastMenuHint(broadcast),
      ariaLabel: `${prompt.ariaLabel}, ${broadcastMenuHint(broadcast)}`,
      icon,
      disabled: broadcast.live.length === 0,
      onSelect: runOnAgents((ids) => {
        void broadcastToSelection(kind, selectedOn(modelStore.canvasOf(state$.canvasName.peek()), new Set(ids)));
      }),
    };
  };

  const createRegionFromSelection = (ids: ReadonlyArray<string>) => {
    const targets = selectedOn(modelStore.canvasOf(state$.canvasName.peek()), new Set(ids));
    if (targets.length === 0) return;
    const pad = 48;
    const minX = Math.min(...targets.map((node) => node.x)) - pad;
    const minY = Math.min(...targets.map((node) => node.y)) - pad;
    const maxX = Math.max(...targets.map((node) => node.x + node.width)) + pad;
    const maxY = Math.max(...targets.map((node) => node.y + node.height)) + pad;
    const region = newRegion(onTop({ x: minX, y: minY }), { width: maxX - minX, height: maxY - minY });
    // The selection is already fully in view — a fitView jump here would be
    // jarring, so this add skips the usual focus-zoom.
    addNode(region, { edit: false, focus: false });
  };

  // Agent actions, in menu order: message, connect, open, disconnect, stop, check.
  // Each owner fills its own slot; a null slot renders nothing. The whole
  // group is absent when the selection holds no agent seat.
  const agentActions: ReadonlyArray<MultiMenuEntry | null> = agentIds.length === 0 ? [] : [
    {
      key: "message",
      label: "message",
      detail: reachable === agentIds.length ? agents : `${reachable} of ${agents} can receive`,
      ariaLabel: `Message ${agents}`,
      icon: <MessageSquare size={14} />,
      disabled: reachable === 0,
      onSelect: () => setComposing(true),
    },
    {
      key: "connect",
      label: "connect",
      detail: meshAdds === 0 && agentIds.length > 1 ? `${agents}, all connected` : agents,
      ariaLabel: `Connect ${agents} to each other`,
      icon: <Link2 size={14} />,
      disabled: meshAdds === 0,
      onSelect: runOnAgents(connectMesh),
    },
    {
      key: "open",
      label: "open",
      detail: `${agents}, grid`,
      ariaLabel: `Open ${agents} in a grid`,
      icon: <LayoutGrid size={14} />,
      onSelect: runOnAgents((ids) => openTerminalGrid(ids)),
    },
    {
      key: "disconnect",
      label: "disconnect",
      detail: `${innerEdges} edge${innerEdges === 1 ? "" : "s"}`,
      ariaLabel: `Disconnect ${innerEdges} edges between ${agents}`,
      icon: <Unlink size={14} />,
      disabled: innerEdges === 0,
      onSelect: runOnAgents(disconnectWithin),
    },
    broadcastEntry("stop", <OctagonX size={14} />),
    broadcastEntry("check", <Activity size={14} />),
    agentIds.length === 1 ? {
      key: "profile",
      label: "save as profile",
      detail: "1 agent, reusable",
      ariaLabel: "Save the agent as a profile",
      icon: <BookmarkPlus size={14} />,
      onSelect: runOnAgents((ids) => {
        if (ids[0]) openSaveProfile(ids[0]);
      }),
    } : null,
    {
      key: "squad",
      label: "save as squad",
      detail: `${agents}, reusable`,
      ariaLabel: `Save ${agents} as a squad`,
      icon: <Users size={14} />,
      onSelect: runOnAgents((ids) => openSaveSquad(ids)),
    },
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
      {composing ? (
        <div className="seat-message-menu" role="dialog" aria-label={`Message ${agents}`}>
          <SeatMessageForm nodeIds={agentIds} />
        </div>
      ) : (
        <div ref={menuRef} className="canvas-action-menu" role="toolbar" aria-orientation="vertical" aria-label={`Actions for ${nodes}`} onKeyDown={onMenuKeyDown}>
          {agentRows.filter((entry) => !SAVE_ROW_KEYS.has(entry.key)).map((entry) => <MultiMenuRow key={entry.key} entry={entry} />)}
          {/* Offboard sits with stop and check, before the save rows. */}
          <SeatOffboardMenuRows nodeIds={agentIds} />
          {agentRows.filter((entry) => SAVE_ROW_KEYS.has(entry.key)).map((entry) => <MultiMenuRow key={entry.key} entry={entry} />)}
          {agentRows.length > 0 ? <hr className="canvas-action-menu__rule" /> : null}
          <SaveToGroupPicker count={count} onPick={(slot) => run((ids) => saveSelectionToCommandGroup(ids, slot))} />
          <hr className="canvas-action-menu__rule" />
          {selectionActions.map((entry) => <MultiMenuRow key={entry.key} entry={entry} />)}
        </div>
      )}
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
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ readonly x: number; readonly y: number } | null>(null);
  const onMenuKeyDown = useMenuKeys(menuRef, position !== null, onClose);
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
      <div ref={menuRef} className="canvas-action-menu" role="toolbar" aria-orientation="vertical" aria-label="Agent actions" data-testid="seat-menu" onKeyDown={onMenuKeyDown}>
        {entries.map((entry) => <MultiMenuRow key={entry.key} entry={entry} />)}
        <hr className="canvas-action-menu__rule" />
        <SeatOffboardMenuRows nodeIds={[seatId]} />
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
  const menuRef = useRef<HTMLDivElement>(null);
  const onMenuKeyDown = useMenuKeys(menuRef, true, onClose);
  const title = titleAt(state$.canvasName.peek(), targetId);
  const count = sourceIds.length;
  const label = count === 1 ? "Connect → target" : "Connect all → target";

  return (
    <div className="canvas-action-menu-host" data-canvas-menu-surface style={{ position: "fixed", left: Math.min(at.x, window.innerWidth - 210), top: Math.min(at.y, window.innerHeight - 120), zIndex: 40 }}>
      <div ref={menuRef} className="canvas-action-menu" role="toolbar" aria-orientation="vertical" aria-label="Connect" onKeyDown={onMenuKeyDown}>
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
      return nodeAt(state$.canvasName.peek(), node.id)?.kind !== "label";
    })
    .map((node) => node.id);

function useCanvasGraph() {
  // No React subscriptions here: doc/execution/selection drive RF via
  // onChange → setNodes so CanvasGraph does not re-render on every kernel
  // cycle.
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
    setNodes,
    setEdges,
    dragInProgressRef,
    pendingRebuildRef,
    flowCacheRef,
    rebuildTick,
  );
  useCanvasFocus(rf);
  useCanvasGroupFocus(rf);
  // One-shot fit request from the command bar "Fit view" action.
  useEffect(() => {
    return state$.fitViewRequest.onChange(() => {
      fitReadableField(rf);
    });
  }, [rf]);
  // Zoom asked for from outside the canvas (canvas-zoom.ts).
  useEffect(() => {
    return canvasZoomRequest$.onChange(() => {
      const asked = canvasZoomRequest$.peek();
      if (!asked) return;
      const moved =
        asked.kind === "in"
          ? rf.zoomIn({ duration: 160 })
          : asked.kind === "out"
            ? rf.zoomOut({ duration: 160 })
            : rf.zoomTo(1, { duration: 200 });
      void moved.catch(() => undefined);
    });
  }, [rf]);
  useCanvasViewport(nodes, rf);
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
  const executionRev = use$(kernel$.executionRev);
  const canvasName = use$(state$.canvasName);
  const actorRefs = use$(state$.actorRefs);
  const canvas = useCanvas(canvasName);
  const heldBy = use$(seatTasks$.bySeat);
  const impact = useMemo(() => {
    const context = executionGraphContextFromActorRefs(canvasName, actorRefs, heldBy);
    return selectionForCanvas(selectedNodeId, context);
  }, [actorRefs, canvasName, connectionFocusNodeId, selectedNodeId, canvas, executionRev, heldBy]);
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
  const fieldTheme = themeFor(use$(themeMode$));
  // While a connection drag is live, every card shows its dots so targets are
  // discoverable mid-gesture.
  const connecting = useConnection((connection) => connection.inProgress);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [terminalAnchor, setTerminalAnchor] = useState<{ x: number; y: number } | null>(null);
  const [gitAnchor, setGitAnchor] = useState<{ x: number; y: number } | null>(null);
  const [filesAnchor, setFilesAnchor] = useState<{ x: number; y: number } | null>(null);
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
  useEffect(() => {
    const openFiles = (event: Event) => {
      if (!featureOnNow("files")) return;
      const anchor = (event as CustomEvent<{ x: number; y: number }>).detail;
      if (createFilesFromRegion(anchor)) return;
      setFilesAnchor(anchor);
    };
    window.addEventListener("junto:new-files", openFiles);
    return () => {
      window.removeEventListener("junto:new-files", openFiles);
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
    openContextMenu({ x: event.clientX, y: event.clientY });
  }, [openContextMenu]);
  // Region → add menu (empty-space read). Multi-selection on a selected node →
  // bulk actions. Selection + RMB on a *different* non-group node → connect
  // all selected sources → that target. Shift+RMB keeps selection so one
  // source can fan out to multiple targets without a menu each time.
  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: FlowNode) => {
    const live = rf.getNodes();
    const selectedCount = live.filter((n) => n.selected).length;
    const isGroup = node.data?.kind === "region" || node.type === "group";

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
    if (node.data?.kind === "agent") {
      event.preventDefault();
      openSeatMenu({ x: event.clientX, y: event.clientY }, node.id);
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

  const content = useContentCalls();
  /** Drop / paste images onto the field → content store → image file nodes. */
  const placeImagesAt = useCallback(
    async (data: DataTransfer | null | undefined, flow: { x: number; y: number }) => {
      const result = await putImagesFromDataTransfer(content, data);
      if (result.kind === "none") return false;
      if (result.kind === "error") {
        state$.error.set(result.error);
        return true;
      }
      let offset = 0;
      for (const ref of result.refs) {
        const node = newImage(
          onTop({ x: flow.x + offset, y: flow.y + offset }),
          contentObjectUrl(ref),
        );
        addNode(node, { edit: false });
        state$.focusNodeId.set(node.id);
        offset += 24;
      }
      return true;
    },
    [content],
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
      toggleInSelection(rfStore, nodeId);
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

  return <CanvasPerformanceBoundary>
    <LegacyCanvasApiProvider>
    {terminalAnchor ? <TerminalWizard anchor={terminalAnchor} onClose={() => setTerminalAnchor(null)} /> : null}
    {gitAnchor ? <GitWizard anchor={gitAnchor} onClose={() => setGitAnchor(null)} /> : null}
    {filesAnchor ? <FilesWizard anchor={filesAnchor} onClose={() => setFilesAnchor(null)} /> : null}
    <ReactFlow
      className={[
        "junto-canvas",
        connecting ? "is-connecting" : "",
        impactMode ? (connectionFocusNodeId ? "connection-focus-mode" : "impact-mode") : "",
      ].filter(Boolean).join(" ")}
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
      onMoveStart={closeMenus}
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
      // Shift is not xyflow's selection latch: selectionOnDrag already draws
      // the marquee on a plain drag, so the latch only made Shift a modifier
      // of the canvas. Each press flipped it on the FlowRenderer, which
      // re-registered xyflow's wheel listener and repainted the board (about
      // 10 ms), and Shift is also the multi-select key held while clicking and
      // the key a terminal holds for capitals. Cmd stays: it turns the wheel
      // into zoom over panOnScroll.
      selectionKeyCode={null}
      zoomOnDoubleClick={false}
      deleteKeyCode={
        // xyflow binds Delete/Backspace at the document level, so the chord
        // reaches the canvas even while the operator works inside a focus
        // surface (browser page chrome, note draft chrome) or any modal
        // (Files, Artifacts, a dialog). It stays bound whatever is in front:
        // unbinding leaves xyflow's pressed-key set holding the chords of the
        // modal that opened, and the first delete after it came back matched
        // nothing. The delete is refused in onBeforeDelete instead.
        CANVAS_DELETE_KEY_CODE
      }
      elevateNodesOnSelect={false}
      // A wire never rises over a card, selected or not (convert.ts z bands).
      elevateEdgesOnSelect={false}
      minZoom={0.15}
      maxZoom={2.5}
      proOptions={{ hideAttribution: true }}
      style={{ background: fieldTheme.ground }}
    >
      {/* No painted ground pattern: any pattern under the camera pays raster
          on every pan frame (see the ground note in styles.css); React
          Flow's <Background> re-rendered a full-window SVG pattern per
          viewport change, which was worse. Flat ground wins. */}
      <CountedSurface id="loom">
        <CanvasLoom edges={edges} />
      </CountedSurface>
      <CountedSurface id="wire-pulse">
        <WirePulseFeed edges={edges} />
      </CountedSurface>
      <CountedSurface id="magnifier">
        <CanvasMagnifier />
      </CountedSurface>
      <CanvasKeyboardPan />
      <CountedSurface id="region-glance">
        <RegionGlanceGate />
      </CountedSurface>
      <CanvasTierGate />
      <CountedSurface id="seat-clusters">
        <SeatClusterLayer />
      </CountedSurface>
      <CountedSurface id="region-urgency">
        <RegionUrgencyGate />
      </CountedSurface>
      <CountedSurface id="impact-chip">
        <ImpactSeedChip />
      </CountedSurface>
    </ReactFlow>
    {ctxMenu ? <ContextModeDeck at={ctxMenu} onClose={() => setCtxMenu(null)} /> : null}
    {multiMenu ? <MultiSelectMenu anchor={multiMenu} onClose={closeMultiMenu} /> : null}
    {seatMenu ? <SeatMenu at={seatMenu} seatId={seatMenu.seatId} onClose={() => setSeatMenu(null)} /> : null}
    <SquadDialogHost />
    <ProfileDialogHost />
    <ProfileDraftEditorHost />
    {connectMenu ? (
      <TargetConnectMenu
        at={{ x: connectMenu.x, y: connectMenu.y }}
        targetId={connectMenu.targetId}
        sourceIds={connectMenu.sourceIds}
        onClose={() => setConnectMenu(null)}
      />
    ) : null}
    </LegacyCanvasApiProvider>
  </CanvasPerformanceBoundary>;
}

export function Canvas() {
  return <div className="h-full w-full"><CanvasGraph /></div>;
}
