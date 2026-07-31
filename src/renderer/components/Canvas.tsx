import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import type { EtherEdgeKind, EtherFlag, TextNode } from "@shared/canvas";
import { executionGraphContextFromActorRefs } from "@shared/graph";
import { Ban, Boxes, Expand, Eye, FileText, Globe, Link2, ListChecks, Plus, ScanLine, SquareDashed, Terminal, Timer, Trash2 } from "lucide-react";
import { allTemplates, type HarnessId } from "@shared/managed-terminal-templates";
import { state$ } from "../lib/state";
import { kernel$ } from "../lib/kernel-view";
import type { FlowEdge, FlowNode } from "../lib/convert";
import { createFlowIdentityCache, searchText, toFlow } from "../lib/convert";
import {
  edgeImpactClass,
  edgeImpactRole,
  impactModeActive$,
  nodeImpactClass,
  selectionImpact,
  type ImpactSelection,
} from "../lib/impact-mode";
import { markViewportBusy, releaseViewportBusy, viewportBusy$ } from "../lib/viewport-busy";
import { nodeTitle } from "../lib/presentation";
import { addNode, deleteNodes, setFlagForNodes } from "../lib/mutations";
import { addEdge, connectAllToTarget, deleteEdges } from "../lib/edge-mutations";
import { dragHoldMemberIds, findOpenPosition, syncPositions } from "../lib/geometry";
import { resolvePageSpawnDefaults } from "@shared/region-defaults";
import { resolveAuthoredPageHost } from "../lib/page-authoring";
import {
  makeArtifactsNode,
  makeBoardNode,
  makeFileNode,
  makeGroupNode,
  makeLinkNode,
  makeManagedAgentNode,
  makePageNode,
  makeRequestsNode,
  makeTasksNode,
  makeTextNode,
} from "../lib/node-factories";
import { openHerdrWizard } from "../lib/herdr-state";
import { describeConnectPreview } from "../lib/connect-preview";
import { resolveSpec, roleOf, type FactoryRoleName } from "@shared/physics";
import { GROUND, HUE } from "../lib/theme";
import type { MemberSeverity } from "@shared/region-rollup";
import { minimapFill, signalMark } from "../lib/signal-mark";
import { nodeTypes } from "./nodes";
import { edgeTypes } from "./edges/EtherEdge";
import { RtsBottomBar } from "./rts/RtsBottomBar";
import { TerminalWizard } from "./terminal/TerminalWizard";
import {
  AgentCascadeMenu,
  cascadeEnterKey,
  cascadeSideFor,
  type AgentConfigurationChoices,
} from "./terminal/AgentCascadeMenu";
import {
  AgentLocationModal,
  type AgentLocationRequest,
} from "./terminal/AgentLocationModal";
import { HarnessMark } from "./herdr/HarnessMark";
import { CanvasMagnifier } from "./CanvasMagnifier";

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

function stampImpactShell(
  nodes: FlowNode[],
  edges: FlowEdge[],
  selectedNodeId: string,
  selectedEdgeId: string,
): { nodes: FlowNode[]; edges: FlowEdge[]; impact: ImpactSelection } {
  const context = currentExecutionGraphContext();
  const impact = selectedNodeId
    ? selectionImpact(
        state$.doc.peek(),
        selectedNodeId,
        kernel$.execution.peek(),
        context,
      )
    : selectionImpact(state$.doc.peek(), "", null, context);
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
  const built = toFlow(
    state$.doc.peek(),
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
      const impact: ImpactSelection = selectedNodeId
        ? selectionImpact(
            state$.doc.peek(),
            selectedNodeId,
            kernel$.execution.peek(),
            context,
          )
        : selectionImpact(state$.doc.peek(), "", null, context);
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
    // Mirror the full RF set for Ctrl+N / command card multi-actions.
    state$.selectedNodeIds.set(selectedNodes.map((node) => node.id));
    // A rubber-band multi-selection has no single inspector subject; keep the
    // inspector closed and let React Flow own the selection set.
    if (selectedNodes.length > 1) {
      state$.selectedNodeId.set("");
      state$.selectedEdgeId.set("");
      return;
    }
    state$.selectedNodeId.set(selectedNodes[0]?.id ?? "");
    state$.selectedEdgeId.set(selectedNodes.length === 0 ? selectedEdges[0]?.id ?? "" : "");
  }, []);
  const onPaneClick = useCallback((event: React.MouseEvent) => {
    if (event.detail === 1) {
      state$.selectedNodeId.set("");
      state$.selectedNodeIds.set([]);
      state$.selectedEdgeId.set("");
      return;
    }
    if (event.detail !== 2) return;
    const pos = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    addNode(makeTextNode(pos.x - 120, pos.y - 50));
  }, [rf]);
  return { onConnect, onConnectEnd, onNodeDragStart, onNodeDrag, onNodeDragStop, onNodesDelete, onEdgesDelete, onSelectionChange, onPaneClick };
}

interface AddActions {
  readonly create: (kind: "text" | "file" | "link" | "group") => void;
  readonly addAgent: (choices: AgentConfigurationChoices) => void;
  readonly addWatcher: () => void;
  readonly addTimer: () => void;
  readonly addTasks: () => void;
  readonly addRequests: () => void;
  readonly addArtifacts: () => void;
  readonly addBoard: () => void;
  readonly addTerminal: () => void;
  readonly addHerdr: () => void;
  readonly addPage: () => void;
}

// Watcher/timer nodes are TEXT nodes carrying entity kind "watcher"/"timer" +
// ether.watch/ether.timer (open vocab per the kernel contract). Inline here
// rather than node-factories.ts — that module sits outside this lane.
const makeWatcherNode = (x: number, y: number): TextNode => ({
  ...makeTextNode(x, y),
  text: "watcher",
  width: 240,
  height: 96,
  ether: {
    entity: { kind: "watcher" },
    host: "local",
    watch: { kind: "glyphs_done" },
  },
});

const makeTimerNode = (x: number, y: number): TextNode => ({
  ...makeTextNode(x, y),
  text: "heartbeat",
  width: 240,
  height: 96,
  ether: {
    entity: { kind: "timer" },
    host: "local",
    timer: { everyMinutes: 30 },
  },
});

// Node creation against a caller-supplied placement strategy — the toolbar
// places near the viewport center, the context menu at the click point.
const makeAddActions = (
  positionFor: (size: { width: number; height: number }) => { x: number; y: number },
  dismiss: () => void,
): AddActions => ({
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
  addAgent: (choices) => {
    const size = { width: 260, height: 110 };
    const position = positionFor(size);
    dismiss();
    window.dispatchEvent(
      new CustomEvent<AgentLocationRequest>("vellum:configure-agent-location", {
        detail: { choices, position },
      }),
    );
  },
  addWatcher: () => {
    const position = positionFor({ width: 240, height: 96 });
    const stationHost = state$.settings.station.hostId.peek() || "local";
    const node = {
      ...makeWatcherNode(position.x, position.y),
      ether: {
        entity: { kind: "watcher" as const },
        host: stationHost,
        watch: { kind: "glyphs_done" as const },
      },
    };
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addTimer: () => {
    const position = positionFor({ width: 240, height: 96 });
    const stationHost = state$.settings.station.hostId.peek() || "local";
    const node = {
      ...makeTimerNode(position.x, position.y),
      ether: {
        entity: { kind: "timer" as const },
        host: stationHost,
        timer: { everyMinutes: 30 },
      },
    };
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
      if (target instanceof Element && target.closest(".node-palette")) return;
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

// Palette sections — derived from the same roleOf the capability kernel
// uses (geography holds no seat and wields no ocap). Never a hand-maintained
// per-entry group list.
type PaletteGroup = "Actors" | "Sinks" | "Schedulers" | "Geography";

const PALETTE_GROUP_BY_ROLE: Record<FactoryRoleName, PaletteGroup> = {
  actor: "Actors",
  sink: "Sinks",
  scheduler: "Schedulers",
  geography: "Geography",
};

const paletteGroupFor = (kind: string | undefined, isGroupNode: boolean): PaletteGroup =>
  PALETTE_GROUP_BY_ROLE[roleOf(resolveSpec({ isGroup: isGroupNode, kind }))];

type MenuEntryBase = {
  readonly key: string;
  readonly label: string;
  readonly sub: string;
  readonly icon: React.ReactNode;
  readonly ariaLabel: string;
  readonly group: PaletteGroup;
};

type MenuEntry =
  | (MenuEntryBase & {
      readonly harness: HarnessId;
      readonly onSelect?: never;
    })
  | (MenuEntryBase & {
      readonly harness?: never;
      readonly onSelect: () => void;
    });

// Auto-focused filter + arrow/Enter selection. Typing narrows by label+sub;
// Enter commits the highlighted row. Managed agents are direct rows whose
// pointer/focus cascade progressively exposes model and effort overrides.
// Keyboard path: ↑/↓ highlight → Enter/→ open cascade with focus → cascade
// arrows/Enter → Esc steps back column-by-column then to the filter.
function AddMenu({ actions }: { readonly actions: AddActions }) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const [agentCascade, setAgentCascade] = useState<{
    readonly harness: HarnessId;
    readonly anchor: HTMLButtonElement;
    readonly focusOnOpen: boolean;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cascadeCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      if (cascadeCloseTimer.current) clearTimeout(cascadeCloseTimer.current);
    };
  }, []);

  const keepCascadeOpen = useCallback(() => {
    if (!cascadeCloseTimer.current) return;
    clearTimeout(cascadeCloseTimer.current);
    cascadeCloseTimer.current = null;
  }, []);

  const closeCascade = useCallback(() => {
    keepCascadeOpen();
    setAgentCascade(null);
  }, [keepCascadeOpen]);

  const closeCascadeSoon = useCallback(() => {
    keepCascadeOpen();
    // Pointer gap + keyboard focus handoff both race this timer. Keep the
    // cascade if focus landed inside it (or the palette) before the delay.
    cascadeCloseTimer.current = setTimeout(() => {
      const active = document.activeElement;
      if (
        active instanceof Element &&
        active.closest(".agent-cascade, .node-palette__menu")
      ) {
        return;
      }
      setAgentCascade(null);
    }, 140);
  }, [keepCascadeOpen]);

  const openCascade = useCallback(
    (
      harness: HarnessId,
      anchor: HTMLButtonElement,
      focusOnOpen = false,
    ) => {
      keepCascadeOpen();
      setAgentCascade((current) => {
        if (
          current?.harness === harness &&
          current.anchor === anchor &&
          current.focusOnOpen === focusOnOpen
        ) {
          return current;
        }
        return { harness, anchor, focusOnOpen };
      });
    },
    [keepCascadeOpen],
  );

  const exitCascadeToPalette = useCallback(() => {
    const anchor = agentCascade?.anchor;
    closeCascade();
    // Prefer the agent row so → can re-enter; fall back to the filter.
    requestAnimationFrame(() => {
      if (anchor?.isConnected) {
        anchor.focus();
        return;
      }
      inputRef.current?.focus();
    });
  }, [agentCascade?.anchor, closeCascade]);

  // Grouped Actors / Sinks / Schedulers / Geography — group membership is
  // paletteGroupFor(kind, isGroup). Harnesses are first-class actor choices.
  const entries: ReadonlyArray<MenuEntry> = [
    ...allTemplates().map((template) => ({
      key: `agent-${template.harness}`,
      label: template.displayName,
      sub: "",
      icon: <HarnessMark agent={template.harness} size={20} />,
      ariaLabel: `Configure ${template.displayName} agent`,
      group: paletteGroupFor("agent", false),
      harness: template.harness,
    })),
    { key: "terminal", label: "terminal", sub: "native shell · geography", icon: <Terminal size={14} />, ariaLabel: "Add native terminal work surface", group: paletteGroupFor("terminal", false), onSelect: () => actions.addTerminal() },
    { key: "herdr", label: "herdr", sub: "attach an existing pane", icon: <Terminal size={14} />, ariaLabel: "Add herdr work surface", group: paletteGroupFor("herdr", false), onSelect: () => actions.addHerdr() },
    { key: "tasks", label: "tasks", sub: "task list · blocks when edged", icon: <ListChecks size={14} />, ariaLabel: "Add tasks", group: paletteGroupFor("task", false), onSelect: () => actions.addTasks() },
    { key: "requests", label: "requests", sub: "input-required · blocks when edged", icon: <ListChecks size={14} />, ariaLabel: "Add requests", group: paletteGroupFor("requests", false), onSelect: () => actions.addRequests() },
    { key: "artifacts", label: "artifacts", sub: "published parts shelf", icon: <FileText size={14} />, ariaLabel: "Add artifacts", group: paletteGroupFor("artifacts", false), onSelect: () => actions.addArtifacts() },
    { key: "board", label: "board", sub: "bulletin · topics + posts", icon: <FileText size={14} />, ariaLabel: "Add bulletin board", group: paletteGroupFor("board", false), onSelect: () => actions.addBoard() },
    { key: "page", label: "page", sub: "work surface · browser session", icon: <Globe size={14} />, ariaLabel: "Add browser page work surface", group: paletteGroupFor("page", false), onSelect: () => actions.addPage() },
    { key: "watcher", label: "watcher", sub: "condition over live data", icon: <Eye size={14} />, ariaLabel: "Add watcher", group: paletteGroupFor("watcher", false), onSelect: () => actions.addWatcher() },
    { key: "timer", label: "timer", sub: "pulse on an interval", icon: <Timer size={14} />, ariaLabel: "Add timer", group: paletteGroupFor("timer", false), onSelect: () => actions.addTimer() },
    { key: "text", label: "note", sub: "freeform text", icon: <FileText size={14} />, ariaLabel: "Add note", group: paletteGroupFor(undefined, false), onSelect: () => actions.create("text") },
    { key: "file", label: "file", sub: "workspace path", icon: <FileText size={14} />, ariaLabel: "Add file", group: paletteGroupFor(undefined, false), onSelect: () => actions.create("file") },
    { key: "link", label: "link", sub: "web reference", icon: <Link2 size={14} />, ariaLabel: "Add link", group: paletteGroupFor(undefined, false), onSelect: () => actions.create("link") },
    { key: "group", label: "region", sub: "spatial container", icon: <SquareDashed size={14} />, ariaLabel: "Add region", group: paletteGroupFor(undefined, true), onSelect: () => actions.create("group") },
  ];

  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? entries.filter((entry) => entry.label.toLowerCase().includes(needle) || entry.sub.toLowerCase().includes(needle))
    : entries;
  const activeIndex = Math.min(highlighted, Math.max(filtered.length - 1, 0));

  const activateEntry = (
    entry: MenuEntry,
    suppliedAnchor?: HTMLButtonElement,
    opts: { readonly keyboard?: boolean } = {},
  ): void => {
    if (entry.harness) {
      const anchor =
        suppliedAnchor ??
        document.querySelector<HTMLButtonElement>(
          `[data-palette-entry="${entry.key}"]`,
        );
      if (!anchor) return;
      if (opts.keyboard) {
        // Keyboard commit enters the cascade with focus; click keeps filter focus.
        openCascade(entry.harness, anchor, true);
        return;
      }
      openCascade(entry.harness, anchor, false);
      return;
    }
    entry.onSelect();
  };

  const enterCascadeFromHighlight = (): boolean => {
    const entry = filtered[activeIndex];
    if (!entry?.harness) return false;
    const anchor = document.querySelector<HTMLButtonElement>(
      `[data-palette-entry="${entry.key}"]`,
    );
    if (!anchor) return false;
    openCascade(entry.harness, anchor, true);
    return true;
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((value) => Math.min(value + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((value) => Math.max(value - 1, 0));
    } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      // Horizontal entry follows cascade side: mirrored menus open leftward,
      // so ← (not →) steps into the first column.
      const entry = filtered[activeIndex];
      if (!entry?.harness) return;
      const anchor = document.querySelector<HTMLButtonElement>(
        `[data-palette-entry="${entry.key}"]`,
      );
      if (!anchor) return;
      if (event.key !== cascadeEnterKey(cascadeSideFor(anchor))) return;
      if (enterCascadeFromHighlight()) {
        event.preventDefault();
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      const entry = filtered[activeIndex];
      if (entry) activateEntry(entry, undefined, { keyboard: true });
    } else if (event.key === "Escape" && agentCascade) {
      // Cascade owns layered Escape when focus is inside it; when focus is still
      // on the filter, the first Escape closes only the open cascade.
      event.preventDefault();
      event.stopPropagation();
      closeCascade();
    }
  };

  return <div className="node-palette__menu" onWheel={(event) => event.stopPropagation()}>
    <input
      ref={inputRef}
      autoFocus
      type="text"
      className="node-palette__filter"
      placeholder="filter…"
      aria-label="Filter add menu"
      value={query}
      onChange={(event) => { setQuery(event.target.value); setHighlighted(0); }}
      onKeyDown={onKeyDown}
    />
    {filtered.length === 0 ? <div className="node-palette__picker-empty">No matches.</div>
        : (() => {
            // Root menu is already group-major order — a header renders once
            // per group boundary crossed while walking the filtered list.
            let lastGroup: PaletteGroup | null = null;
            return filtered.map((entry, index) => {
              const showHeader = entry.group !== lastGroup;
              lastGroup = entry.group;
              return (
                <Fragment key={entry.key}>
                  {showHeader ? <div className="node-palette__group-label">{entry.group}</div> : null}
                  <button
                    data-palette-entry={entry.key}
                    aria-label={entry.ariaLabel}
                    aria-haspopup={entry.harness ? "menu" : undefined}
                    aria-expanded={
                      entry.harness ? agentCascade?.harness === entry.harness : undefined
                    }
                    data-tooltip=""
                    className={[
                      index === activeIndex ? "is-active" : "",
                      entry.harness ? "node-palette__agent-row" : "",
                    ].filter(Boolean).join(" ") || undefined}
                    onFocus={(event) => {
                      setHighlighted(index);
                      if (entry.harness) {
                        openCascade(entry.harness, event.currentTarget, false);
                      }
                    }}
                    onBlur={() => {
                      if (entry.harness) closeCascadeSoon();
                    }}
                    onMouseEnter={(event) => {
                      setHighlighted(index);
                      if (entry.harness) {
                        openCascade(entry.harness, event.currentTarget, false);
                      } else {
                        setAgentCascade(null);
                      }
                    }}
                    onMouseLeave={() => {
                      if (entry.harness) closeCascadeSoon();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        const next = Math.min(index + 1, filtered.length - 1);
                        setHighlighted(next);
                        document
                          .querySelector<HTMLButtonElement>(
                            `[data-palette-entry="${filtered[next]?.key}"]`,
                          )
                          ?.focus();
                        return;
                      }
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        if (index === 0) {
                          inputRef.current?.focus();
                          return;
                        }
                        const next = index - 1;
                        setHighlighted(next);
                        document
                          .querySelector<HTMLButtonElement>(
                            `[data-palette-entry="${filtered[next]?.key}"]`,
                          )
                          ?.focus();
                        return;
                      }
                      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                        if (!entry.harness) {
                          if (event.key === "ArrowLeft") {
                            event.preventDefault();
                            inputRef.current?.focus();
                          }
                          return;
                        }
                        const side = cascadeSideFor(event.currentTarget);
                        if (event.key === cascadeEnterKey(side)) {
                          event.preventDefault();
                          openCascade(entry.harness, event.currentTarget, true);
                          return;
                        }
                        // Retreat key on the actor row returns to the filter.
                        event.preventDefault();
                        inputRef.current?.focus();
                        return;
                      }
                      if (!entry.harness) return;
                      if (event.key === "Enter") {
                        event.preventDefault();
                        openCascade(entry.harness, event.currentTarget, true);
                      }
                    }}
                    onClick={(event) =>
                      activateEntry(entry, event.currentTarget)
                    }
                  >
                    <span className="node-palette__icon" aria-hidden>{entry.icon}</span>
                    <span><strong>{entry.label}</strong>{entry.sub ? <small>{entry.sub}</small> : null}</span>
                  </button>
                </Fragment>
              );
            });
          })()}
    {agentCascade ? (
      <AgentCascadeMenu
        key={agentCascade.harness}
        harness={agentCascade.harness}
        anchor={agentCascade.anchor}
        focusOnOpen={agentCascade.focusOnOpen}
        onConfigure={actions.addAgent}
        onPointerEnter={keepCascadeOpen}
        onPointerLeave={closeCascadeSoon}
        onExit={exitCascadeToPalette}
      />
    ) : null}
  </div>;
}

// Canvas chrome insets for palette placement — stay between station top bar
// and the docked field tools / RTS bottom chrome, never over either.
const NODE_PALETTE_WIDTH = 268;
const NODE_PALETTE_MARGIN = 8;

const stationBarBottom = (): number => {
  const bar = document.querySelector(".station-bar");
  if (!(bar instanceof HTMLElement)) return 72;
  return bar.getBoundingClientRect().bottom + NODE_PALETTE_MARGIN;
};

// Docked above the bottom-right minimap with fit-all — not scattered top chrome.
// Menu portals to body: .rts-right overflow:hidden would clip an absolute popover.
function CanvasFieldTools() {
  const rf = useReactFlow<FlowNode, FlowEdge>();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuBox, setMenuBox] = useState<{
    readonly left: number;
    readonly bottom: number;
    readonly maxHeight: number;
  } | null>(null);
  const dismiss = useCallback(() => { setOpen(false); }, []);
  useMenuDismiss(open, dismiss);

  useLayoutEffect(() => {
    if (!open) {
      setMenuBox(null);
      return;
    }
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      // Anchor above the trigger; clamp height under the station top bar.
      const topLimit = stationBarBottom();
      setMenuBox({
        left: Math.min(
          Math.max(NODE_PALETTE_MARGIN, rect.left),
          window.innerWidth - NODE_PALETTE_WIDTH - NODE_PALETTE_MARGIN,
        ),
        bottom: Math.max(NODE_PALETTE_MARGIN, window.innerHeight - rect.top + 6),
        maxHeight: Math.max(140, rect.top - topLimit),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

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

  return (
    <div className="rts-field-tools" aria-label="Canvas field tools">
      <div className="node-palette node-palette--docked">
        <button
          ref={triggerRef}
          type="button"
          className="node-palette__trigger"
          aria-label="Add canvas item"
          aria-expanded={open}
          onClick={() => { setOpen((value) => !value); }}
        >
          <Plus size={12} /><span>add item</span>
        </button>
        {open && menuBox
          ? createPortal(
              <div
                className="node-palette node-palette--context"
                style={{
                  position: "fixed",
                  left: menuBox.left,
                  bottom: menuBox.bottom,
                  zIndex: 60,
                  "--node-palette-max-height": `${menuBox.maxHeight}px`,
                } as React.CSSProperties}
              >
                <AddMenu actions={actions} />
              </div>,
              document.body,
            )
          : null}
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

// Right-click on empty canvas: the same add menu, anchored at the cursor,
// creating the node exactly where you clicked.
function ContextAddMenu({ at, onClose }: { readonly at: { x: number; y: number }; readonly onClose: () => void }) {
  const rf = useReactFlow<FlowNode, FlowEdge>();
  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState({
    left: at.x,
    top: at.y,
    maxHeight: Math.max(140, window.innerHeight - 88),
  });
  useMenuDismiss(true, onClose);
  useLayoutEffect(() => {
    const place = () => {
      const rect = menuRef.current?.getBoundingClientRect();
      if (!rect) return;
      const gap = 5;
      const margin = NODE_PALETTE_MARGIN;
      const topLimit = stationBarBottom();
      const left =
        at.x + rect.width + gap <= window.innerWidth - margin
          ? at.x + gap
          : at.x - rect.width - gap;
      const preferredTop =
        at.y + rect.height + gap <= window.innerHeight - margin
          ? at.y + gap
          : at.y - rect.height - gap;
      setPlacement({
        left: Math.max(margin, Math.min(left, window.innerWidth - rect.width - margin)),
        top: Math.max(topLimit, Math.min(preferredTop, window.innerHeight - rect.height - margin)),
        maxHeight: Math.max(140, window.innerHeight - topLimit - margin * 2),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [at.x, at.y]);
  const positionFor = (size: { width: number; height: number }) => {
    const point = rf.screenToFlowPosition({ x: at.x, y: at.y });
    return { x: Math.round(point.x - size.width / 2), y: Math.round(point.y - size.height / 2) };
  };
  const actions = makeAddActions(positionFor, onClose);
  return (
    <div
      ref={menuRef}
      className="node-palette node-palette--context"
      style={{
        position: "fixed",
        left: placement.left,
        top: placement.top,
        zIndex: 40,
        "--node-palette-max-height": `${placement.maxHeight}px`,
      } as React.CSSProperties}
    >
      <AddMenu actions={actions} />
    </div>
  );
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
    <div className="node-palette node-palette--context" style={{ position: "fixed", left: Math.min(at.x, window.innerWidth - 210), top: Math.min(at.y, window.innerHeight - 200), zIndex: 40 }}>
      <div className="node-palette__menu">
        <button aria-label="Create region from selection" onClick={() => run(createRegionFromSelection)}><span className="node-palette__icon" aria-hidden><SquareDashed size={14} /></span><span><strong>create region</strong><small>from selection</small></span></button>
        <button aria-label="Flag blocker" onClick={() => run((ids) => setFlagForNodes(ids, "blocker"))}><span className="node-palette__icon" aria-hidden><Ban size={14} /></span><span><strong>flag blocker</strong><small>{count} node{count === 1 ? "" : "s"}</small></span></button>
        <button aria-label="Clear flags" onClick={() => run((ids) => setFlagForNodes(ids, null))}><span className="node-palette__icon" aria-hidden><Ban size={14} /></span><span><strong>clear flags</strong><small>{count} node{count === 1 ? "" : "s"}</small></span></button>
        <button aria-label={`Delete ${count} nodes`} onClick={() => run((ids) => deleteNodes(ids))}><span className="node-palette__icon" aria-hidden><Trash2 size={14} /></span><span><strong>delete {count} node{count === 1 ? "" : "s"}</strong></span></button>
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
    <div className="node-palette node-palette--context" style={{ position: "fixed", left: Math.min(at.x, window.innerWidth - 210), top: Math.min(at.y, window.innerHeight - 120), zIndex: 40 }}>
      <div className="node-palette__menu">
        <button
          aria-label={`${label}: ${count} source${count === 1 ? "" : "s"} to ${title}`}
          onClick={() => {
            connectAllToTarget(sourceIds, targetId);
            onClose();
          }}
        >
          <span className="node-palette__icon" aria-hidden><Link2 size={14} /></span>
          <span>
            <strong>{label}</strong>
            <small>{count} → {title}</small>
          </span>
        </button>
      </div>
    </div>
  );
}

/** Selected RF nodes that can act as edge sources (non-group, not the target). */
const connectableSourceIds = (
  nodes: ReadonlyArray<CanvasNodeRef>,
  targetId: string,
): string[] =>
  nodes
    .filter((node) => node.selected && node.id !== targetId && node.type !== "group")
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
  const docVersion = use$(state$.docVersion);
  const executionRev = use$(kernel$.executionRev);
  const canvasName = use$(state$.canvasName);
  const actorRefs = use$(state$.actorRefs);
  const impact = useMemo(() => {
    const context = executionGraphContextFromActorRefs(
      canvasName,
      actorRefs,
    );
    return selectedNodeId
      ? selectionImpact(
          state$.doc.peek(),
          selectedNodeId,
          kernel$.execution.peek(),
          context,
        )
      : selectionImpact(state$.doc.peek(), "", null, context);
  }, [actorRefs, canvasName, selectedNodeId, docVersion, executionRev]);
  if (!impact.active) return null;
  return (
    <Panel position="top-left" className="impact-hud-panel">
      <div className="impact-hud" role="status" aria-live="polite" title="Stoppage impact cone for selection">
        <span className="impact-hud__mark" aria-hidden />
        <span className="impact-hud__eyebrow">impact</span>
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
  const [agentLocation, setAgentLocation] = useState<AgentLocationRequest | null>(null);
  useEffect(() => {
    const openTerminal = (event: Event) =>
      setTerminalAnchor((event as CustomEvent<{ x: number; y: number }>).detail);
    const configureAgent = (event: Event) =>
      setAgentLocation((event as CustomEvent<AgentLocationRequest>).detail);
    window.addEventListener("vellum:new-terminal", openTerminal);
    window.addEventListener("vellum:configure-agent-location", configureAgent);
    return () => {
      window.removeEventListener("vellum:new-terminal", openTerminal);
      window.removeEventListener("vellum:configure-agent-location", configureAgent);
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
    {agentLocation ? (
      <AgentLocationModal
        request={agentLocation}
        onClose={() => setAgentLocation(null)}
        onCreate={(choices) => {
          const node = makeManagedAgentNode(
            agentLocation.position.x,
            agentLocation.position.y,
            choices,
          );
          addNode(node, { edit: false });
          state$.focusNodeId.set(node.id);
          setAgentLocation(null);
          // A new actor is lazy: it lands as a node and nothing else. Its
          // process starts when the operator activates it (double-click) or
          // when the factory hands it a task — authoring a region should not
          // charge a harness launch per card.
        }}
      />
    ) : null}
    <ReactFlow
      className={[
        connecting ? "is-connecting" : "",
        impactMode ? "impact-mode" : "",
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
    {ctxMenu ? <ContextAddMenu at={ctxMenu} onClose={() => setCtxMenu(null)} /> : null}
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
