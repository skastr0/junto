import type {
  CanvasDoc,
  CanvasNode,
  EtherFlag,
  NodeSide,
} from "@shared/canvas";
import type { BindingHint } from "@shared/ipc";
import { state$ } from "./state";

// --- external-write guard -------------------------------------------------
// The main-process watcher reports external edits. We stamp our own writes so
// the change push can be ignored for a beat and we don't reload our own save.
let lastWriteAt = 0;
export const getLastWriteAt = (): number => lastWriteAt;

const past: CanvasDoc[] = [];
const future: CanvasDoc[] = [];

const syncHistoryState = (): void => {
  state$.canUndo.set(past.length > 0);
  state$.canRedo.set(future.length > 0);
};

const confirmDestructive = (message: string): boolean =>
  typeof window === "undefined" || typeof window.confirm !== "function" || window.confirm(message);

// --- save pipeline --------------------------------------------------------
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const roundNode = (n: CanvasNode): CanvasNode => ({
  ...n,
  x: Math.round(n.x),
  y: Math.round(n.y),
  width: Math.round(n.width),
  height: Math.round(n.height),
});

const without = <T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> => {
  const { [key]: _removed, ...rest } = value;
  return rest;
};

const stripUndefined = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(stripUndefined) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([entryKey, entry]) => [entryKey, stripUndefined(entry)]),
    ) as T;
  }
  return value;
};

// Positions to integers; the main plane handles mirror law + canonical
// serialize + atomic write.
export const roundDoc = (doc: CanvasDoc): CanvasDoc => stripUndefined({
  nodes: doc.nodes.map(roundNode),
  edges: doc.edges,
});

const flushSave = async () => {
  const name = state$.canvasName.peek();
  if (!name || !window.vellum) return;
  state$.saveState.set("saving");
  const doc = roundDoc(state$.doc.peek());
  try {
    await window.vellum.writeCanvas(name, doc);
    // Stamp after IPC returns: the watcher can report the atomic rename after
    // the main-process write completes, so the suppression window must begin
    // at the boundary where the renderer knows the write is durable.
    lastWriteAt = Date.now();
    state$.saveState.set("saved");
    state$.error.set("");
  } catch (error) {
    state$.saveState.set("error");
    state$.error.set(error instanceof Error ? error.message : String(error));
  }
};

export const retrySave = (): void => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  state$.error.set("");
  void flushSave().catch(() => undefined);
};

export const scheduleSave = (): void => {
  if (saveTimer) clearTimeout(saveTimer);
  state$.saveState.set("saving");
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushSave().catch(() => undefined);
  }, 500);
};

// Commit a new document. `structural` bumps docVersion so React Flow rebuilds;
// pass false for pure position writes RF already reflects (drag stop).
export const commitDoc = (next: CanvasDoc, structural = true, recordHistory = structural): void => {
  if (recordHistory) {
    past.push(state$.doc.peek());
    future.length = 0;
    syncHistoryState();
  }
  state$.doc.set(next);
  if (structural) state$.docVersion.set(state$.docVersion.peek() + 1);
  scheduleSave();
};

// Replace the document from an authoritative source (open / external reload).
// Always structural; never triggers a save (it mirrors what's already on disk).
export const loadDoc = (doc: CanvasDoc): void => {
  past.length = 0;
  future.length = 0;
  state$.editNodeId.set("");
  state$.selectedNodeId.set("");
  state$.selectedEdgeId.set("");
  state$.focusNodeId.set("");
  syncHistoryState();
  state$.saveState.set("saved");
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
// `edit` opens the inline editor right away — right for blank notes, wrong for
// entity nodes that arrive already named and bound. `focus` defaults to true;
// pass false to skip the fitView jump (e.g. a region drawn around a selection
// that is already fully in view — a zoom jump there would be jarring).
export const addNode = (node: CanvasNode, options?: { readonly edit?: boolean; readonly focus?: boolean }): void => {
  state$.searchQuery.set("");
  state$.edgeFilter.set("");
  state$.flagFilter.set("");
  state$.selectedNodeId.set(node.id);
  state$.selectedEdgeId.set("");
  const doc = state$.doc.peek();
  commitDoc({ ...doc, nodes: [...doc.nodes, node] });
  if (options?.focus === false) return;
  window.setTimeout(() => {
    state$.focusNodeId.set(node.id);
    if (options?.edit !== false) state$.editNodeId.set(node.id);
  }, 0);
};

export const undo = (): void => {
  const previous = past.pop();
  if (!previous) return;
  future.push(state$.doc.peek());
  state$.editNodeId.set("");
  state$.doc.set(previous);
  state$.docVersion.set(state$.docVersion.peek() + 1);
  syncHistoryState();
  scheduleSave();
};

export const redo = (): void => {
  const next = future.pop();
  if (!next) return;
  past.push(state$.doc.peek());
  state$.editNodeId.set("");
  state$.doc.set(next);
  state$.docVersion.set(state$.docVersion.peek() + 1);
  syncHistoryState();
  scheduleSave();
};

export const deleteNode = (id: string): void => {
  deleteNodes([id]);
};

export const deleteNodes = (ids: ReadonlyArray<string>): void => {
  const removed = new Set(ids);
  if (removed.size === 0) return;
  const doc = state$.doc.peek();
  const existingNodes = doc.nodes.filter((node) => removed.has(node.id));
  if (existingNodes.length === 0) return;
  const connectedEdges = doc.edges.filter((edge) => removed.has(edge.fromNode) || removed.has(edge.toNode)).length;
  const nodeLabel = existingNodes.length === 1 ? "this node" : `${existingNodes.length} nodes`;
  const relationLabel = connectedEdges === 0 ? "" : ` Connected edges (${connectedEdges}) will also be removed.`;
  if (!confirmDestructive(`Delete ${nodeLabel}?${relationLabel}`)) return;
  if (removed.has(state$.selectedNodeId.peek())) state$.selectedNodeId.set("");
  if (removed.has(state$.selectedEdgeId.peek())) state$.selectedEdgeId.set("");
  commitDoc({
    nodes: doc.nodes.filter((n) => !removed.has(n.id)),
    edges: doc.edges.filter((e) => !removed.has(e.fromNode) && !removed.has(e.toNode)),
  });
};

export const editText = (id: string, text: string): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => (n.id === id && n.type === "text" ? { ...n, text } : n)),
  });
};

export const editFile = (id: string, file: string): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => (n.id === id && n.type === "file" ? { ...n, file } : n)),
  });
};

export const editFileDetails = (id: string, file: string, subpath: string): void => {
  const doc = state$.doc.peek();
  const nextFile = file.trim();
  if (!nextFile) return;
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => n.id === id && n.type === "file"
      ? subpath.trim()
        ? { ...n, file: nextFile, subpath: subpath.trim() }
        : { ...without(n, "subpath"), file: nextFile }
      : n),
  });
};

export const editLink = (id: string, url: string): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => (n.id === id && n.type === "link" ? { ...n, url } : n)),
  });
};

export const renameGroup = (id: string, label: string): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) =>
      n.id === id && n.type === "group"
        ? label.trim() ? { ...n, label: label.trim() } : without(n, "label")
        : n,
    ),
  });
};

export const editGroupBackground = (id: string, background: string, backgroundStyle: "cover" | "ratio" | "repeat"): void => {
  const doc = state$.doc.peek();
  const source = background.trim();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => n.id === id && n.type === "group"
      ? source
        ? { ...n, background: source, backgroundStyle }
        : without(without(n, "background"), "backgroundStyle")
      : n),
  });
};

export const setNodeColor = (id: string, color?: string): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => n.id === id
      ? (color ? { ...n, color } : without(n, "color")) as CanvasNode
      : n),
  });
};

export const toggleFlag = (id: string, flag: EtherFlag): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.id !== id) return n;
      const flags = n.ether?.flags ?? [];
      const has = flags.includes(flag);
      const nextFlags = has ? flags.filter((f) => f !== flag) : [...flags, flag];
      if (nextFlags.length) {
        return { ...n, ether: { ...(n.ether ?? {}), flags: nextFlags } };
      }
      if (!n.ether) return n;
      const nextEther = without(n.ether, "flags");
      return (Object.keys(nextEther).length ? { ...n, ether: nextEther } : without(n, "ether")) as CanvasNode;
    }),
  });
};

// Bulk flag set/clear over a whole selection in one commit — a multi-select
// action applies once, not as N individual toggles. `flag: null` clears the
// full flag vocabulary (not just one flag) for every target node.
export const setFlagForNodes = (ids: ReadonlyArray<string>, flag: EtherFlag | null): void => {
  const targets = new Set(ids);
  if (targets.size === 0) return;
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (!targets.has(n.id)) return n;
      if (flag === null) {
        if (!n.ether) return n;
        const nextEther = without(n.ether, "flags");
        return (Object.keys(nextEther).length ? { ...n, ether: nextEther } : without(n, "ether")) as CanvasNode;
      }
      const flags = n.ether?.flags ?? [];
      if (flags.includes(flag)) return n;
      return { ...n, ether: { ...(n.ether ?? {}), flags: [...flags, flag] } };
    }),
  });
};
