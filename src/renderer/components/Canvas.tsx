import { useCallback, useEffect, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import type { Connection, Node } from "@xyflow/react";
import { use$ } from "@legendapp/state/react";
import type { EtherBinding, EtherEdgeKind, EtherFlag } from "@shared/canvas";
import { mergeProjects } from "@shared/portfolio";
import { Bot, Boxes, Expand, FileText, Link2, Plus, ScanLine, SquareDashed } from "lucide-react";
import { state$ } from "../lib/state";
import type { FlowEdge, FlowNode } from "../lib/convert";
import { searchText, toFlow } from "../lib/convert";
import { addNode, deleteNodes } from "../lib/mutations";
import { addEdge, deleteEdges } from "../lib/edge-mutations";
import { findOpenPosition, syncPositions } from "../lib/geometry";
import { makeAgentNode, makeFileNode, makeGroupNode, makeLinkNode, makeProjectNode, makeTextNode } from "../lib/node-factories";
import { GROUND, HUE } from "../lib/theme";
import { nodeTypes } from "./nodes";
import { edgeTypes } from "./edges/EtherEdge";

const miniMapNodeColor = (node: Node): string => {
  const data = node.data as FlowNode["data"] | undefined;
  const flags = data?.node.ether?.flags ?? [];
  if (flags.includes("blocker")) return HUE.crimson;
  if (flags.includes("attention")) return HUE.amber;
  if (flags.includes("parked")) return HUE.violet;
  if (data?.node.type === "group") return "rgba(143,163,176,0.25)";
  return "rgba(232,163,61,0.5)";
};

type CanvasNodeRef = { readonly id: string; readonly type?: string; readonly position: { readonly x: number; readonly y: number }; readonly data?: unknown };
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

function useCanvasDocument(docVersion: number, searchQuery: string, edgeFilter: EtherEdgeKind | "", flagFilter: EtherFlag | "", selectedNodeId: string, selectedEdgeId: string, setNodes: ReturnType<typeof useNodesState<FlowNode>>[1], setEdges: ReturnType<typeof useEdgesState<FlowEdge>>[1]) {
  useEffect(() => {
    const built = toFlow(state$.doc.peek());
    const visibleNodes = flagFilter ? built.nodes.filter((node) => node.type === "group" || node.data?.node.ether?.flags?.includes(flagFilter)) : built.nodes;
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    const filteredEdges = built.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target) && (!edgeFilter || (edge.data?.edge.ether?.kind ?? "relates") === edgeFilter));
    const selectedNodes = visibleNodes.map((node) => node.id === selectedNodeId ? { ...node, selected: true } : node);
    const selectedEdges = filteredEdges.map((edge) => edge.id === selectedEdgeId ? { ...edge, selected: true } : edge);
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
  }, [docVersion, edgeFilter, flagFilter, searchQuery, selectedNodeId, selectedEdgeId, setNodes, setEdges]);
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
      state$.selectedEdgeId.set("");
      void rf.fitView({ nodes: [node], padding: 0.35, maxZoom: 1.45, duration: 360 }).catch(() => undefined).finally(() => {
        state$.selectedNodeId.set(focusNodeId);
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

function useCanvasInteractions(rf: CanvasFlow) {
  const onConnect = useCallback((connection: Connection) => addEdge(connection), []);
  const onNodeDragStop = useCallback(() => {
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
    state$.selectedNodeId.set(selectedNodes[0]?.id ?? "");
    state$.selectedEdgeId.set(selectedNodes.length === 0 ? selectedEdges[0]?.id ?? "" : "");
  }, []);
  const onPaneClick = useCallback((event: React.MouseEvent) => {
    if (event.detail === 1) {
      state$.selectedNodeId.set("");
      state$.selectedEdgeId.set("");
      return;
    }
    if (event.detail !== 2) return;
    const pos = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    addNode(makeTextNode(pos.x - 120, pos.y - 50));
  }, [rf]);
  return { onConnect, onNodeDragStop, onNodesDelete, onEdgesDelete, onSelectionChange, onPaneClick };
}

function AddNodePanel() {
  const rf = useReactFlow<FlowNode, FlowEdge>();
  const snapshots = use$(state$.snapshots);
  const [open, setOpen] = useState(false);
  const [picker, setPicker] = useState<"project" | "agent" | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setPicker(null);
      setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".node-palette")) return;
      setPicker(null);
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
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

  const dismiss = () => { setPicker(null); setOpen(false); };

  const create = (kind: "text" | "file" | "link" | "group") => {
    const size = kind === "text"
      ? { width: 240, height: 100 }
      : kind === "group"
        ? { width: 560, height: 320 }
        : { width: 260, height: 110 };
    const position = nextPosition(size);
    const node = kind === "text"
      ? makeTextNode(position.x, position.y)
      : kind === "file"
        ? makeFileNode(position.x, position.y)
        : kind === "link"
          ? makeLinkNode(position.x, position.y)
          : makeGroupNode(position.x, position.y);
    addNode(node);
    dismiss();
  };

  // Merged live projects (tower/quasar/booth, collapsed by title into one entry
  // bound to every source that knows it).
  const projects = mergeProjects(snapshots, { all: true });
  const agents = snapshots.bundles
    .filter((bundle) => bundle.ok && bundle.source === "hermes")
    .flatMap((bundle) => bundle.entities)
    .filter((entity) => entity.kind === "agent");

  const addProject = (display: string, bindings: ReadonlyArray<EtherBinding>) => {
    const position = nextPosition({ width: 240, height: 96 });
    addNode(makeProjectNode(position.x, position.y, display, bindings));
    dismiss();
  };
  const addAgent = (label: string, key: string) => {
    const position = nextPosition({ width: 240, height: 96 });
    addNode(makeAgentNode(position.x, position.y, label, key));
    dismiss();
  };

  return (
    <Panel position="top-left" className="node-palette-panel">
      <div className="node-palette">
        <button className="node-palette__trigger" aria-label="Add canvas item" aria-expanded={open} onClick={() => { setPicker(null); setOpen((value) => !value); }}><Plus size={14} /><span>add item</span></button>
        {open && !picker ? <div className="node-palette__menu">
          <button aria-label="Add note" onClick={() => create("text")}><FileText size={14} /><span><strong>note</strong><small>freeform text</small></span></button>
          <button aria-label="Add file" onClick={() => create("file")}><FileText size={14} /><span><strong>file</strong><small>workspace path</small></span></button>
          <button aria-label="Add link" onClick={() => create("link")}><Link2 size={14} /><span><strong>link</strong><small>web reference</small></span></button>
          <button aria-label="Add region" onClick={() => create("group")}><SquareDashed size={14} /><span><strong>region</strong><small>spatial container</small></span></button>
          <button aria-label="Add project" onClick={() => setPicker("project")}><Boxes size={14} /><span><strong>project</strong><small>bound live readout</small></span></button>
          <button aria-label="Add agent" onClick={() => setPicker("agent")}><Bot size={14} /><span><strong>agent</strong><small>hermes profile</small></span></button>
        </div> : null}
        {open && picker === "project" ? <div className="node-palette__menu node-palette__menu--picker" role="listbox" aria-label="Choose a project">
          <div className="node-palette__picker-head"><button type="button" aria-label="Back to add menu" onClick={() => setPicker(null)}>‹ project</button></div>
          {projects.length === 0 ? <div className="node-palette__picker-empty">No projects in the live snapshots.</div>
            : projects.map((project) => <button key={project.display} role="option" aria-label={`Add project ${project.display}`} onClick={() => addProject(project.display, project.bindings)}><Boxes size={13} /><span><strong>{project.display}</strong><small>{[...project.sources].join(" · ")}</small></span></button>)}
        </div> : null}
        {open && picker === "agent" ? <div className="node-palette__menu node-palette__menu--picker" role="listbox" aria-label="Choose an agent">
          <div className="node-palette__picker-head"><button type="button" aria-label="Back to add menu" onClick={() => setPicker(null)}>‹ agent</button></div>
          {agents.length === 0 ? <div className="node-palette__picker-empty">No agents in the live snapshots.</div>
            : agents.map((agent) => {
              const host = typeof agent.stats.host === "string" ? agent.stats.host : undefined;
              const title = agent.title ?? agent.key;
              const label = host ? `${title} · ${host}` : title;
              return <button key={agent.key} role="option" aria-label={`Add agent ${title}`} onClick={() => addAgent(label, agent.key)}><Bot size={13} /><span><strong>{title}</strong><small>{host ?? "hermes"}</small></span></button>;
            })}
        </div> : null}
      </div>
    </Panel>
  );
}

function FitAllPanel() {
  const rf = useReactFlow<FlowNode, FlowEdge>();
  return <Panel position="top-center" className="field-fit-panel"><button type="button" aria-label="Fit all nodes" title="fit all nodes" onClick={() => void rf.fitView({ padding: 0.18, duration: 320, maxZoom: 1.35 })}><Expand size={12} />fit all</button></Panel>;
}

function FieldControls() {
  const rf = useReactFlow<FlowNode, FlowEdge>();
  return <Controls showFitView={false} showInteractive={false} aria-label="Field controls"><ControlButton aria-label="Fit readable field" title="fit readable field" onClick={() => fitReadableField(rf)}><ScanLine size={14} /></ControlButton></Controls>;
}

function useCanvasGraph() {
  const canvasName = use$(state$.canvasName);
  const docVersion = use$(state$.docVersion);
  const searchQuery = use$(state$.searchQuery);
  const selectedNodeId = use$(state$.selectedNodeId);
  const selectedEdgeId = use$(state$.selectedEdgeId);
  const edgeFilter = use$(state$.edgeFilter);
  const flagFilter = use$(state$.flagFilter);
  const focusNodeId = use$(state$.focusNodeId);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const rf = useReactFlow<FlowNode, FlowEdge>();
  useCanvasDocument(docVersion, searchQuery, edgeFilter, flagFilter, selectedNodeId, selectedEdgeId, setNodes, setEdges);
  useCanvasSearchViewport(searchQuery, nodes.length, rf, `${edgeFilter}|${flagFilter}`);
  useCanvasFocus(focusNodeId, rf);
  useCanvasViewport(canvasName, nodes.length, rf);
  return { nodes, edges, onNodesChange, onEdgesChange, interactions: useCanvasInteractions(rf) };
}

function CanvasGraph() {
  const { nodes, edges, onNodesChange, onEdgesChange, interactions } = useCanvasGraph();
  return <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} {...interactions} connectOnClick connectionRadius={24} zoomOnDoubleClick={false} onlyRenderVisibleElements deleteKeyCode={["Backspace", "Delete"]} elevateNodesOnSelect={false} elevateEdgesOnSelect fitView fitViewOptions={{ padding: 0.18, maxZoom: 1.35 }} minZoom={0.15} maxZoom={2.5} proOptions={{ hideAttribution: true }} style={{ background: GROUND }}>
    <Background variant={BackgroundVariant.Dots} gap={26} size={1} color="rgba(237,230,218,0.07)" />
    <AddNodePanel />
    <FitAllPanel />
    <MiniMap pannable zoomable nodeColor={miniMapNodeColor} maskColor="rgba(12,11,10,0.72)" style={{ background: "rgba(12,11,10,0.9)", border: "1px solid rgba(237,230,218,0.1)" }} />
    <FieldControls />
  </ReactFlow>;
}

export function Canvas() {
  return <div className="h-full w-full"><CanvasGraph /></div>;
}
