import { useCallback, useEffect, useRef, useState } from "react";
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
import { mergeProjects } from "@shared/portfolio";
import { Ban, Bot, Boxes, Expand, Eye, FileText, Globe, Link2, ListChecks, Plus, ScanLine, SquareDashed, Terminal, Timer, Trash2 } from "lucide-react";
import { state$ } from "../lib/state";
import { kernel$ } from "../lib/kernel-view";
import type { FlowEdge, FlowNode } from "../lib/convert";
import { searchText, toFlow } from "../lib/convert";
import { addNode, deleteNodes, setFlagForNodes } from "../lib/mutations";
import { addEdge, deleteEdges } from "../lib/edge-mutations";
import { containedNodeIds, findOpenPosition, syncPositions } from "../lib/geometry";
import { resolvePageSpawnDefaults } from "@shared/region-defaults";
import { makeAgentNode, makeFileNode, makeGroupNode, makeLinkNode, makePageNode, makeProjectNode, makeTasksNode, makeTextNode } from "../lib/node-factories";
import { openHerdrWizard } from "../lib/herdr-state";
import { GROUND, HUE } from "../lib/theme";
import type { MemberSeverity } from "@shared/region-rollup";
import { minimapFill, signalMark } from "../lib/signal-mark";
import { nodeTypes } from "./nodes";
import { edgeTypes } from "./edges/EtherEdge";
import { RtsBottomBar } from "./rts/RtsBottomBar";

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

function useCanvasDocument(
  docVersion: number,
  executionRev: number,
  searchQuery: string,
  edgeFilter: EtherEdgeKind | "",
  flagFilter: EtherFlag | "",
  selectedNodeId: string,
  selectedEdgeId: string,
  setNodes: ReturnType<typeof useNodesState<FlowNode>>[1],
  setEdges: ReturnType<typeof useEdgesState<FlowEdge>>[1],
) {
  // Structural rebuild — document/filter/search + live kernel execution.
  // Selection is stamped from a peek so a click never rebuilds the whole graph.
  useEffect(() => {
    const built = toFlow(state$.doc.peek(), kernel$.execution.peek());
    const nodeId = state$.selectedNodeId.peek();
    const edgeId = state$.selectedEdgeId.peek();
    const visibleNodes = flagFilter ? built.nodes.filter((node) => node.type === "group" || node.data?.node.ether?.flags?.includes(flagFilter)) : built.nodes;
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    const filteredEdges = built.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target) && (!edgeFilter || (edge.data?.phase ?? edge.data?.edge.ether?.kind ?? "relates") === edgeFilter));
    const selectedNodes = visibleNodes.map((node) => node.id === nodeId ? { ...node, selected: true } : node);
    const selectedEdges = filteredEdges.map((edge) => edge.id === edgeId ? { ...edge, selected: true } : edge);
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      setNodes(selectedNodes);
      setEdges(selectedEdges);
      return;
    }
    const matches = selectedNodes.filter((flowNode) => searchText(flowNode.data.node).includes(query));
    const queryVisibleIds = new Set(matches.map((flowNode) => flowNode.id));
    setNodes(matches);
    setEdges(selectedEdges.filter((edge) => queryVisibleIds.has(edge.source) && queryVisibleIds.has(edge.target)));
  }, [docVersion, executionRev, edgeFilter, flagFilter, searchQuery, setNodes, setEdges]);

  // Selection sync — a light map over the existing graph, not a rebuild. A
  // live rubber-band multi-selection (no single subject) is left untouched.
  useEffect(() => {
    setNodes((nodes) => {
      if (!selectedNodeId && nodes.filter((node) => node.selected).length > 1) return nodes;
      return nodes.map((node) => node.selected === (node.id === selectedNodeId) ? node : { ...node, selected: node.id === selectedNodeId });
    });
    setEdges((edges) => edges.map((edge) => edge.selected === (edge.id === selectedEdgeId) ? edge : { ...edge, selected: edge.id === selectedEdgeId }));
  }, [selectedNodeId, selectedEdgeId, setNodes, setEdges]);
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

function useCanvasFocus(focusNodeId: string, rf: CanvasFlow) {
  useEffect(() => {
    if (!focusNodeId) return;
    let attempts = 0;
    let frame = 0;
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
    frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [focusNodeId, rf]);
}

function useCanvasViewport(canvasName: string, nodeCount: number, rf: CanvasFlow) {
  const fittedCanvasRef = useRef("");
  useEffect(() => {
    if (!canvasName || nodeCount === 0 || fittedCanvasRef.current === canvasName) return;
    fittedCanvasRef.current = canvasName;
    const frame = requestAnimationFrame(() => {
      // A dense corpus spanning thousands of flow pixels becomes unreadable
      // if the first frame fits every node. Regions are the spatial index;
      // when none exist, show the first node cluster.
      fitReadableField(rf);
    });
    return () => cancelAnimationFrame(frame);
  }, [canvasName, nodeCount, rf]);
}

function useCanvasInteractions(rf: CanvasFlow, setNodes: ReturnType<typeof useNodesState<FlowNode>>[1]) {
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
  const onNodeDragStart: OnNodeDrag<FlowNode> = useCallback((_event, node) => {
    holdDragRef.current = null;
    if (node.data.node.type !== "group" || !node.data.node.ether?.region?.hold) return;
    const doc = state$.doc.peek();
    const regionDoc = doc.nodes.find((n) => n.id === node.id);
    if (!regionDoc || regionDoc.type !== "group") return;
    const startPositions = new Map<string, { x: number; y: number }>();
    for (const id of containedNodeIds(doc, regionDoc)) {
      const member = rf.getNode(id);
      if (!member || member.selected) continue;
      startPositions.set(id, member.position);
    }
    holdDragRef.current = { regionId: node.id, regionStart: node.position, startPositions };
  }, [rf]);
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
    holdDragRef.current = null;
    const positions = new Map<string, { x: number; y: number }>();
    for (const node of rf.getNodes()) positions.set(node.id, node.position);
    syncPositions(positions);
  }, [rf]);
  const onNodesDelete = useCallback((deleted: ReadonlyArray<FlowNode>) => deleteNodes(deleted.map((node) => node.id)), []);
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

type AddPicker = "project" | "agent" | null;

interface AddActions {
  readonly create: (kind: "text" | "file" | "link" | "group") => void;
  readonly addProject: (display: string, name: string) => void;
  readonly addAgent: (label: string, key: string) => void;
  readonly addWatcher: () => void;
  readonly addTimer: () => void;
  readonly addTasks: () => void;
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
  ether: { entity: { kind: "watcher" }, watch: { kind: "glyphs_done" } },
});

const makeTimerNode = (x: number, y: number): TextNode => ({
  ...makeTextNode(x, y),
  text: "heartbeat",
  width: 240,
  height: 96,
  ether: { entity: { kind: "timer" }, timer: { everyMinutes: 30 } },
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
  addProject: (display, name) => {
    const position = positionFor({ width: 240, height: 96 });
    const node = makeProjectNode(position.x, position.y, display, name);
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addAgent: (label, key) => {
    const position = positionFor({ width: 240, height: 96 });
    const node = makeAgentNode(position.x, position.y, label, key);
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addWatcher: () => {
    const position = positionFor({ width: 240, height: 96 });
    const node = makeWatcherNode(position.x, position.y);
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addTimer: () => {
    const position = positionFor({ width: 240, height: 96 });
    const node = makeTimerNode(position.x, position.y);
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addTasks: () => {
    const position = positionFor({ width: 240, height: 120 });
    const node = makeTasksNode(position.x, position.y);
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
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

type MenuEntry = {
  readonly key: string;
  readonly label: string;
  readonly sub: string;
  readonly icon: React.ReactNode;
  readonly ariaLabel: string;
  readonly onSelect: () => void;
};

// Auto-focused filter + arrow/Enter selection, shared by the top-level kind
// menu and both pickers. Typing narrows by label+sub; Enter commits whichever
// row is highlighted (the top match by default).
function AddMenu({ picker, setPicker, actions }: { readonly picker: AddPicker; readonly setPicker: (picker: AddPicker) => void; readonly actions: AddActions }) {
  const snapshots = use$(state$.snapshots);
  // Merged live projects (tower/quasar/booth, collapsed by title into one entry
  // bound to every source that knows it).
  const projects = mergeProjects(snapshots, { all: true });
  const agents = snapshots.bundles
    .filter((bundle) => bundle.ok && bundle.source === "hermes")
    .flatMap((bundle) => bundle.entities)
    .filter((entity) => entity.kind === "agent");

  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Drilling into (or backing out of) a picker starts the filter fresh, and
  // the filter input re-claims focus at every level.
  useEffect(() => {
    setQuery("");
    setHighlighted(0);
    inputRef.current?.focus();
  }, [picker]);

  const entries: ReadonlyArray<MenuEntry> = !picker
    ? [
      { key: "text", label: "note", sub: "freeform text", icon: <FileText size={14} />, ariaLabel: "Add note", onSelect: () => actions.create("text") },
      { key: "file", label: "file", sub: "workspace path", icon: <FileText size={14} />, ariaLabel: "Add file", onSelect: () => actions.create("file") },
      { key: "link", label: "link", sub: "web reference", icon: <Link2 size={14} />, ariaLabel: "Add link", onSelect: () => actions.create("link") },
      { key: "group", label: "region", sub: "spatial container", icon: <SquareDashed size={14} />, ariaLabel: "Add region", onSelect: () => actions.create("group") },
      { key: "watcher", label: "watcher", sub: "condition over live data", icon: <Eye size={14} />, ariaLabel: "Add watcher", onSelect: () => actions.addWatcher() },
      { key: "timer", label: "timer", sub: "pulse on an interval", icon: <Timer size={14} />, ariaLabel: "Add timer", onSelect: () => actions.addTimer() },
      { key: "tasks", label: "tasks", sub: "local checklist · blocks when edged", icon: <ListChecks size={14} />, ariaLabel: "Add tasks", onSelect: () => actions.addTasks() },
      { key: "herdr", label: "herdr", sub: "work surface · attach live pane", icon: <Terminal size={14} />, ariaLabel: "Add herdr work surface", onSelect: () => actions.addHerdr() },
      { key: "page", label: "page", sub: "work surface · browser session", icon: <Globe size={14} />, ariaLabel: "Add browser page work surface", onSelect: () => actions.addPage() },
      { key: "project", label: "project", sub: "bound live readout", icon: <Boxes size={14} />, ariaLabel: "Add project", onSelect: () => setPicker("project") },
      { key: "agent", label: "agent", sub: "hermes profile", icon: <Bot size={14} />, ariaLabel: "Add agent", onSelect: () => setPicker("agent") },
    ]
    : picker === "project"
      ? projects.map((project) => ({
        key: project.display,
        label: project.display,
        sub: [...project.sources].join(" · "),
        icon: <Boxes size={13} />,
        ariaLabel: `Add project ${project.display}`,
        onSelect: () => actions.addProject(project.display, project.name),
      }))
      : agents.map((agent) => {
        const host = typeof agent.stats.host === "string" ? agent.stats.host : undefined;
        const title = agent.title ?? agent.key;
        return {
          key: agent.key,
          label: title,
          sub: host ?? "hermes",
          icon: <Bot size={13} />,
          ariaLabel: `Add agent ${title}`,
          onSelect: () => actions.addAgent(host ? `${title} · ${host}` : title, agent.key),
        };
      });

  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? entries.filter((entry) => entry.label.toLowerCase().includes(needle) || entry.sub.toLowerCase().includes(needle))
    : entries;
  const activeIndex = Math.min(highlighted, Math.max(filtered.length - 1, 0));

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((value) => Math.min(value + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((value) => Math.max(value - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      filtered[activeIndex]?.onSelect();
    }
  };

  const isPicker = picker !== null;
  const emptyLabel = picker === "project" ? "No projects in the live snapshots." : "No agents in the live snapshots.";

  return <div className={isPicker ? "node-palette__menu node-palette__menu--picker" : "node-palette__menu"} role={isPicker ? "listbox" : undefined} aria-label={isPicker ? `Choose ${picker === "project" ? "a project" : "an agent"}` : undefined}>
    {isPicker ? <div className="node-palette__picker-head"><button type="button" aria-label="Back to add menu" onClick={() => setPicker(null)}>‹ {picker}</button></div> : null}
    <input
      ref={inputRef}
      autoFocus
      type="text"
      className="node-palette__filter"
      placeholder={isPicker ? "filter…" : "filter kinds…"}
      aria-label="Filter add menu"
      value={query}
      onChange={(event) => { setQuery(event.target.value); setHighlighted(0); }}
      onKeyDown={onKeyDown}
    />
    {isPicker && entries.length === 0 ? <div className="node-palette__picker-empty">{emptyLabel}</div>
      : filtered.length === 0 ? <div className="node-palette__picker-empty">No matches.</div>
        : filtered.map((entry, index) => (
          <button
            key={entry.key}
            role={isPicker ? "option" : undefined}
            aria-label={entry.ariaLabel}
            className={index === activeIndex ? "is-active" : undefined}
            onMouseEnter={() => setHighlighted(index)}
            onClick={entry.onSelect}
          >
            {entry.icon}<span><strong>{entry.label}</strong><small>{entry.sub}</small></span>
          </button>
        ))}
  </div>;
}

// Docked above the bottom-right minimap with fit-all — not scattered top chrome.
function CanvasFieldTools() {
  const rf = useReactFlow<FlowNode, FlowEdge>();
  const [open, setOpen] = useState(false);
  const [picker, setPicker] = useState<AddPicker>(null);
  const dismiss = useCallback(() => { setPicker(null); setOpen(false); }, []);
  useMenuDismiss(open, dismiss);

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
          type="button"
          className="node-palette__trigger"
          aria-label="Add canvas item"
          aria-expanded={open}
          onClick={() => { setPicker(null); setOpen((value) => !value); }}
        >
          <Plus size={12} /><span>add item</span>
        </button>
        {open ? <AddMenu picker={picker} setPicker={setPicker} actions={actions} /> : null}
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
  const [picker, setPicker] = useState<AddPicker>(null);
  useMenuDismiss(true, onClose);
  const positionFor = (size: { width: number; height: number }) => {
    const point = rf.screenToFlowPosition({ x: at.x, y: at.y });
    return { x: Math.round(point.x - size.width / 2), y: Math.round(point.y - size.height / 2) };
  };
  const actions = makeAddActions(positionFor, onClose);
  return (
    <div className="node-palette node-palette--context" style={{ position: "fixed", left: Math.min(at.x, window.innerWidth - 210), top: Math.min(at.y, window.innerHeight - 340), zIndex: 40 }}>
      <AddMenu picker={picker} setPicker={setPicker} actions={actions} />
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
        <button aria-label="Create region from selection" onClick={() => run(createRegionFromSelection)}><SquareDashed size={14} /><span><strong>create region</strong><small>from selection</small></span></button>
        <button aria-label="Flag blocker" onClick={() => run((ids) => setFlagForNodes(ids, "blocker"))}><Ban size={14} /><span><strong>flag blocker</strong><small>{count} node{count === 1 ? "" : "s"}</small></span></button>
        <button aria-label="Clear flags" onClick={() => run((ids) => setFlagForNodes(ids, null))}><Ban size={14} /><span><strong>clear flags</strong><small>{count} node{count === 1 ? "" : "s"}</small></span></button>
        <button aria-label={`Delete ${count} nodes`} onClick={() => run((ids) => deleteNodes(ids))}><Trash2 size={14} /><span><strong>delete {count} node{count === 1 ? "" : "s"}</strong></span></button>
      </div>
    </div>
  );
}

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
  const canvasName = use$(state$.canvasName);
  const docVersion = use$(state$.docVersion);
  const executionRev = use$(kernel$.executionRev);
  const searchQuery = use$(state$.searchQuery);
  const selectedNodeId = use$(state$.selectedNodeId);
  const selectedEdgeId = use$(state$.selectedEdgeId);
  const edgeFilter = use$(state$.edgeFilter);
  const flagFilter = use$(state$.flagFilter);
  const focusNodeId = use$(state$.focusNodeId);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const rf = useReactFlow<FlowNode, FlowEdge>();
  useCanvasDocument(docVersion, executionRev, searchQuery, edgeFilter, flagFilter, selectedNodeId, selectedEdgeId, setNodes, setEdges);
  useCanvasSearchViewport(searchQuery, nodes.length, rf, `${edgeFilter}|${flagFilter}`);
  useCanvasFocus(focusNodeId, rf);
  useCanvasViewport(canvasName, nodes.length, rf);
  return { nodes, edges, onNodesChange, onEdgesChange, interactions: useCanvasInteractions(rf, setNodes), rf };
}

function CanvasGraph() {
  const { nodes, edges, onNodesChange, onEdgesChange, interactions, rf } = useCanvasGraph();
  // While a connection drag is live, every card shows its dots so targets are
  // discoverable mid-gesture.
  const connecting = useConnection((connection) => connection.inProgress);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [multiMenu, setMultiMenu] = useState<{ x: number; y: number } | null>(null);
  // The two context menus are mutually exclusive — opening one always closes
  // the other first.
  const openContextMenu = useCallback((at: { x: number; y: number }) => {
    setMultiMenu(null);
    setCtxMenu(at);
  }, []);
  const openMultiMenu = useCallback((at: { x: number; y: number }) => {
    setCtxMenu(null);
    setMultiMenu(at);
  }, []);
  const onPaneContextMenu = useCallback((event: React.MouseEvent | MouseEvent) => {
    event.preventDefault();
    openContextMenu({ x: event.clientX, y: event.clientY });
  }, [openContextMenu]);
  // A region visually reads as empty space — right-clicking inside one offers
  // the same picker, creating the node at that spot (inside the region). A
  // right-click on a node that is part of a live multi-selection instead
  // opens the bulk action menu.
  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: FlowNode) => {
    const selectedCount = rf.getNodes().filter((n) => n.selected).length;
    if (selectedCount > 1 && node.selected) {
      event.preventDefault();
      openMultiMenu({ x: event.clientX, y: event.clientY });
      return;
    }
    if (node.data?.node.type !== "group") return;
    event.preventDefault();
    openContextMenu({ x: event.clientX, y: event.clientY });
  }, [rf, openContextMenu, openMultiMenu]);
  // Right-click on the rubber-band selection itself (not a single node).
  const onSelectionContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    openMultiMenu({ x: event.clientX, y: event.clientY });
  }, [openMultiMenu]);
  const onPaneClick = useCallback((event: React.MouseEvent) => {
    setCtxMenu(null);
    setMultiMenu(null);
    interactions.onPaneClick(event);
  }, [interactions.onPaneClick]);
  return <>
    <ReactFlow className={connecting ? "is-connecting" : undefined} nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} {...interactions} onPaneClick={onPaneClick} onPaneContextMenu={onPaneContextMenu} onNodeContextMenu={onNodeContextMenu} onSelectionContextMenu={onSelectionContextMenu} onMoveStart={() => { setCtxMenu(null); setMultiMenu(null); }} connectionMode={ConnectionMode.Loose} connectionRadius={42} panOnScroll panOnScrollSpeed={1.2} panOnDrag={[1]} selectionOnDrag selectionMode={SelectionMode.Partial} zoomOnDoubleClick={false} onlyRenderVisibleElements deleteKeyCode={["Backspace", "Delete"]} elevateNodesOnSelect={false} elevateEdgesOnSelect fitView fitViewOptions={{ padding: 0.18, maxZoom: 1.35 }} minZoom={0.15} maxZoom={2.5} proOptions={{ hideAttribution: true }} style={{ background: GROUND }}>
      <Background variant={BackgroundVariant.Dots} gap={26} size={1} color="rgba(237,230,218,0.07)" />
      {/* Bar (incl. MiniMap) must be a ReactFlow child so MiniMap binds to the instance. */}
      <Panel position="bottom-center" className="rts-bar-panel" style={{ width: "100%", margin: 0, left: 0, right: 0, transform: "none", maxWidth: "none" }}>
        <RtsBottomBar tools={<CanvasFieldTools />} minimap={<RtsMinimapStack />} />
      </Panel>
    </ReactFlow>
    {ctxMenu ? <ContextAddMenu at={ctxMenu} onClose={() => setCtxMenu(null)} /> : null}
    {multiMenu ? <MultiSelectMenu at={multiMenu} onClose={() => setMultiMenu(null)} /> : null}
  </>;
}

export function Canvas() {
  return <div className="h-full w-full"><CanvasGraph /></div>;
}
