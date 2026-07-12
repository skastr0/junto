import { ulid } from "ulid";
import type {
  CanvasDoc,
  CanvasEdge,
  CanvasNode,
  EtherEdgeKind,
  EtherFlag,
  NodeSide,
  TextNode,
} from "@shared/canvas";
import type { BindingHint } from "@shared/ipc";
import { state$ } from "./state";

// --- external-write guard -------------------------------------------------
// The main-process watcher reports external edits. We stamp our own writes so
// the change push can be ignored for a beat and we don't reload our own save.
let lastWriteAt = 0;
export const getLastWriteAt = () => lastWriteAt;

// --- save pipeline --------------------------------------------------------
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const roundNode = (n: CanvasNode): CanvasNode => ({
  ...n,
  x: Math.round(n.x),
  y: Math.round(n.y),
  width: Math.round(n.width),
  height: Math.round(n.height),
});

// Positions to integers; the main plane handles mirror law + canonical
// serialize + atomic write.
export const roundDoc = (doc: CanvasDoc): CanvasDoc => ({
  nodes: doc.nodes.map(roundNode),
  edges: doc.edges,
});

const flushSave = async () => {
  const name = state$.canvasName.peek();
  if (!name || !window.vellum) return;
  const doc = roundDoc(state$.doc.peek());
  lastWriteAt = Date.now();
  try {
    await window.vellum.writeCanvas(name, doc);
  } catch (error) {
    state$.error.set(error instanceof Error ? error.message : String(error));
  }
};

export const scheduleSave = () => {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushSave();
  }, 500);
};

// Commit a new document. `structural` bumps docVersion so React Flow rebuilds;
// pass false for pure position writes RF already reflects (drag stop).
export const commitDoc = (next: CanvasDoc, structural = true) => {
  state$.doc.set(next);
  if (structural) state$.docVersion.set(state$.docVersion.peek() + 1);
  scheduleSave();
};

// Replace the document from an authoritative source (open / external reload).
// Always structural; never triggers a save (it mirrors what's already on disk).
export const loadDoc = (doc: CanvasDoc) => {
  state$.doc.set(doc);
  state$.docVersion.set(state$.docVersion.peek() + 1);
};

// --- binding hints --------------------------------------------------------
export const bindingHints = (doc: CanvasDoc): ReadonlyArray<BindingHint> => {
  const seen = new Set<string>();
  const hints: BindingHint[] = [];
  for (const node of doc.nodes) {
    for (const binding of node.ether?.bindings ?? []) {
      const key = `${binding.source}:${binding.ref.key}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hints.push({ source: binding.source, key: binding.ref.key });
    }
  }
  return hints;
};

// --- graph queries used by interactions -----------------------------------
const SIDES: ReadonlyArray<NodeSide> = ["top", "right", "bottom", "left"];

export const parseSide = (handle?: string | null): NodeSide | undefined => {
  if (!handle) return undefined;
  const raw = handle.replace(/^[st]-/, "");
  return (SIDES as ReadonlyArray<string>).includes(raw) ? (raw as NodeSide) : undefined;
};

// --- mutations ------------------------------------------------------------
export const makeTextNode = (x: number, y: number): TextNode => ({
  id: `node-${ulid()}`,
  type: "text",
  text: "new note",
  x: Math.round(x),
  y: Math.round(y),
  width: 240,
  height: 100,
});

export const addNode = (node: CanvasNode) => {
  const doc = state$.doc.peek();
  commitDoc({ ...doc, nodes: [...doc.nodes, node] });
};

export const deleteNode = (id: string) => {
  const doc = state$.doc.peek();
  commitDoc({
    nodes: doc.nodes.filter((n) => n.id !== id),
    edges: doc.edges.filter((e) => e.fromNode !== id && e.toNode !== id),
  });
};

export const editText = (id: string, text: string) => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => (n.id === id && n.type === "text" ? { ...n, text } : n)),
  });
};

export const renameGroup = (id: string, label: string) => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) =>
      n.id === id && n.type === "group" ? { ...n, label: label || undefined } : n,
    ),
  });
};

export const toggleFlag = (id: string, flag: EtherFlag) => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.id !== id) return n;
      const flags = n.ether?.flags ?? [];
      const has = flags.includes(flag);
      const nextFlags = has ? flags.filter((f) => f !== flag) : [...flags, flag];
      return {
        ...n,
        ether: {
          ...(n.ether ?? {}),
          flags: nextFlags.length ? nextFlags : undefined,
        },
      };
    }),
  });
};

const KIND_CYCLE: Record<EtherEdgeKind, EtherEdgeKind> = {
  blocks: "depends",
  depends: "relates",
  relates: "blocks",
};

export const cycleEdgeKind = (id: string) => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    edges: doc.edges.map((e) => {
      if (e.id !== id) return e;
      const current = e.ether?.kind ?? "relates";
      return { ...e, ether: { ...e.ether, kind: KIND_CYCLE[current] } };
    }),
  });
};

export const addEdge = (params: {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}) => {
  if (params.source === params.target) return;
  const doc = state$.doc.peek();
  const edge: CanvasEdge = {
    id: `edge-${ulid()}`,
    fromNode: params.source,
    toNode: params.target,
    fromSide: parseSide(params.sourceHandle),
    toSide: parseSide(params.targetHandle),
    ether: { kind: "relates" },
  };
  commitDoc({ ...doc, edges: [...doc.edges, edge] });
};

// Sync live positions from React Flow after a drag. Non-structural: RF already
// shows them, so no rebuild — just persist.
export const syncPositions = (positions: ReadonlyMap<string, { x: number; y: number }>) => {
  const doc = state$.doc.peek();
  commitDoc(
    {
      ...doc,
      nodes: doc.nodes.map((n) => {
        const pos = positions.get(n.id);
        return pos ? { ...n, x: pos.x, y: pos.y } : n;
      }),
    },
    false,
  );
};
