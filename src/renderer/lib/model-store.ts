import { batch, observable, type Observable } from "@legendapp/state";
import { asCanvasName, type Changed, type Command, type Node, type Opened, type Wire } from "@shared/model";
import type { Canvas } from "@shared/model/canvas";
import { canvasAfter } from "./model-undo";

// What is on each open canvas, as the window holds it: nodes and wires by id.
// Filled once by `Opened` and kept current by `Changed`, which carries only
// the rows that changed. Nothing here is a document: a component reads one
// node, or one field of one node, and hears about nothing else.

export type ModelApi = {
  modelOpen(input: { readonly canvas: string }): Promise<Opened>;
  modelCommand(command: Command): Promise<{ readonly seq: number }>;
  onModelChanged(listener: (event: Changed) => void): () => void;
};

export type ModelCanvasStatus = "closed" | "opening" | "open" | "error";

export type ModelCanvasState = {
  status: ModelCanvasStatus;
  error: string;
  /** The canvas's count of committed changes, as far as this window has seen. */
  seq: number;
  nodes: Record<string, Node>;
  wires: Record<string, Wire>;
  /**
   * Node ids in paint order, lowest first. Changes only when a node is added,
   * removed or restacked, so a list of cards does not hear a move or a rename.
   */
  nodeIds: ReadonlyArray<string>;
  /** Wire ids. Changes only when a wire is added or removed. */
  wireIds: ReadonlyArray<string>;
};

const emptyCanvas = (): ModelCanvasState => ({
  status: "closed",
  error: "",
  seq: 0,
  nodes: {},
  wires: {},
  nodeIds: [],
  wireIds: [],
});

const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Keep the previous value wherever the next one says the same thing, so a
 * field that did not change keeps its identity and its listeners stay quiet.
 */
export const keepUnchanged = <T>(previous: unknown, next: T): T => {
  if (Object.is(previous, next)) return next;
  if (typeof previous !== "object" || typeof next !== "object" || previous === null || next === null) return next;
  if (Array.isArray(previous) !== Array.isArray(next)) return next;
  if (Array.isArray(previous) && Array.isArray(next)) {
    const items = next.map((item, index) => keepUnchanged(previous[index], item));
    const same = previous.length === items.length && items.every((item, index) => item === previous[index]);
    return (same ? previous : items) as T;
  }
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = Object.keys(after);
  const merged: Record<string, unknown> = {};
  let same = Object.keys(before).length === keys.length;
  for (const key of keys) {
    merged[key] = keepUnchanged(before[key], after[key]);
    if (!(key in before) || merged[key] !== before[key]) same = false;
  }
  return (same ? previous : merged) as T;
};

const paintOrder = (nodes: Record<string, Node>): ReadonlyArray<string> =>
  Object.values(nodes)
    .sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((node) => node.id);

type Rows = {
  readonly nodes: ReadonlyArray<Node>;
  readonly wires: ReadonlyArray<Wire>;
  readonly removedNodes: ReadonlyArray<string>;
  readonly removedWires: ReadonlyArray<string>;
};

/**
 * What a command will have done once main commits it, so the window can show
 * it at once: the rows that differ between the canvas now and the canvas
 * after (model-undo.ts says what each command does). `undefined` for a command
 * about a whole canvas, which is main's to say.
 */
export const rowsAfterCommand = (state: ModelCanvasState, command: Command): Rows | undefined => {
  if (command._tag === "CreateCanvas" || command._tag === "RemoveCanvas") return undefined;
  const before = canvasOfState(command.canvas, state);
  const after = canvasAfter(before, command);
  if (after === before) return { nodes: [], wires: [], removedNodes: [], removedWires: [] };
  return {
    nodes: [...after.nodes.values()].filter((node) => before.nodes.get(node.id) !== node),
    wires: [...after.wires.values()].filter((wire) => before.wires.get(wire.id) !== wire),
    removedNodes: [...before.nodes.keys()].filter((id) => !after.nodes.has(id)),
    removedWires: [...before.wires.keys()].filter((id) => !after.wires.has(id)),
  };
};

/**
 * A canvas as shared logic reads it, from what the window holds of it. Built
 * when asked for: an edit, an undo step or a blocker walk, never per frame.
 */
export const canvasOfState = (name: string, state: Pick<ModelCanvasState, "seq" | "nodes" | "wires">): Canvas => ({
  name: asCanvasName(name),
  seq: state.seq,
  nodes: new Map(Object.values(state.nodes).map((node) => [node.id, node])),
  wires: new Map(Object.values(state.wires).map((wire) => [wire.id, wire])),
});

export const createModelStore = (getApi: () => ModelApi | undefined) => {
  const canvases$ = observable<Record<string, ModelCanvasState>>({});
  const users = new Map<string, number>();
  /** Events that arrived while a canvas was being read, applied after it. */
  const held = new Map<string, Changed[]>();
  const opening = new Map<string, Promise<void>>();
  let unsubscribe: (() => void) | undefined;

  const canvas$ = (canvas: string): Observable<ModelCanvasState> => {
    if (canvases$[canvas].peek() === undefined) canvases$[canvas].set(emptyCanvas());
    return canvases$[canvas] as Observable<ModelCanvasState>;
  };

  const applyRows = (canvas: string, rows: Rows): void => {
    const target$ = canvas$(canvas);
    batch(() => {
      let membership = false;
      let wireMembership = false;
      for (const id of rows.removedNodes) {
        if (target$.nodes[id].peek() === undefined) continue;
        target$.nodes[id].delete();
        membership = true;
      }
      for (const id of rows.removedWires) {
        if (target$.wires[id].peek() === undefined) continue;
        target$.wires[id].delete();
        wireMembership = true;
      }
      for (const node of rows.nodes) {
        const previous = target$.nodes[node.id].peek();
        if (previous === undefined || previous.z !== node.z) membership = true;
        const next = keepUnchanged(previous, node);
        if (next !== previous) target$.nodes[node.id].set(next);
      }
      for (const wire of rows.wires) {
        const previous = target$.wires[wire.id].peek();
        if (previous === undefined) wireMembership = true;
        const next = keepUnchanged(previous, wire);
        if (next !== previous) target$.wires[wire.id].set(next);
      }
      if (membership) {
        const order = paintOrder(target$.nodes.peek());
        if (!sameList(order, target$.nodeIds.peek())) target$.nodeIds.set(order);
      }
      if (wireMembership) target$.wireIds.set(Object.keys(target$.wires.peek()));
    });
  };

  const applyOpened = (opened: Opened): void => {
    const target$ = canvas$(opened.canvas);
    const previous = target$.peek();
    const nodes: Record<string, Node> = {};
    for (const node of opened.nodes) nodes[node.id] = keepUnchanged(previous.nodes[node.id], node);
    const wires: Record<string, Wire> = {};
    for (const wire of opened.wires) wires[wire.id] = keepUnchanged(previous.wires[wire.id], wire);
    const nodeIds = paintOrder(nodes);
    const wireIds = Object.keys(wires);
    batch(() => {
      for (const id of Object.keys(previous.nodes)) if (!(id in nodes)) target$.nodes[id].delete();
      for (const id of Object.keys(previous.wires)) if (!(id in wires)) target$.wires[id].delete();
      for (const [id, node] of Object.entries(nodes)) if (node !== previous.nodes[id]) target$.nodes[id].set(node);
      for (const [id, wire] of Object.entries(wires)) if (wire !== previous.wires[id]) target$.wires[id].set(wire);
      if (!sameList(nodeIds, previous.nodeIds)) target$.nodeIds.set(nodeIds);
      if (!sameList(wireIds, previous.wireIds)) target$.wireIds.set(wireIds);
      target$.seq.set(opened.seq);
      target$.error.set("");
      target$.status.set("open");
    });
  };

  const read = (canvas: string): Promise<void> => {
    const flight = opening.get(canvas);
    if (flight !== undefined) return flight;
    const target$ = canvas$(canvas);
    // A canvas already on screen stays on screen while it is read again.
    if (target$.status.peek() !== "open") target$.status.set("opening");
    held.set(canvas, []);
    // Done before anything is applied: a held change may itself start a read.
    const settle = (): void => {
      held.delete(canvas);
      opening.delete(canvas);
    };
    const next = (async () => {
      // Let the caller record this read before it can finish.
      await Promise.resolve();
      try {
        const api = getApi();
        if (api === undefined) throw new Error("Junto is not available.");
        const opened = await api.modelOpen({ canvas });
        const waiting = held.get(canvas) ?? [];
        settle();
        if ((users.get(canvas) ?? 0) === 0) return;
        applyOpened(opened);
        for (const event of waiting) applyChanged(event);
      } catch (error) {
        settle();
        if ((users.get(canvas) ?? 0) === 0) return;
        target$.error.set(error instanceof Error ? error.message : String(error));
        target$.status.set("error");
      }
    })();
    opening.set(canvas, next);
    return next;
  };

  const applyChanged = (event: Changed): void => {
    if ((users.get(event.canvas) ?? 0) === 0) return;
    const waiting = held.get(event.canvas);
    if (waiting !== undefined) {
      waiting.push(event);
      return;
    }
    const target$ = canvas$(event.canvas);
    const seq = target$.seq.peek();
    if (event.seq <= seq) return;
    if (event.seq !== seq + 1) {
      // A change was missed. The rows held here may be stale: read it afresh.
      void read(event.canvas);
      return;
    }
    batch(() => {
      applyRows(event.canvas, event);
      target$.seq.set(event.seq);
    });
  };

  const close = (canvas: string): void => {
    held.delete(canvas);
    opening.delete(canvas);
    canvases$[canvas].delete();
  };

  const store = {
    /** The observable for one canvas. Read a field of it to hear only that field. */
    canvas$,
    node$: (canvas: string, id: string): Observable<Node | undefined> =>
      canvas$(canvas).nodes[id] as Observable<Node | undefined>,
    wire$: (canvas: string, id: string): Observable<Wire | undefined> =>
      canvas$(canvas).wires[id] as Observable<Wire | undefined>,

    /** Keep a canvas open. The first holder reads it; the last one out closes it. */
    open: (canvas: string): (() => void) => {
      users.set(canvas, (users.get(canvas) ?? 0) + 1);
      if (unsubscribe === undefined) unsubscribe = getApi()?.onModelChanged(applyChanged);
      if (users.get(canvas) === 1) void read(canvas);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (users.get(canvas) ?? 1) - 1;
        if (left > 0) {
          users.set(canvas, left);
          return;
        }
        users.delete(canvas);
        close(canvas);
        if (users.size === 0) {
          unsubscribe?.();
          unsubscribe = undefined;
        }
      };
    },

    /** The canvas as it stands now, for working out an edit or its way back. Not tracked. */
    canvasOf: (canvas: string): Canvas => canvasOfState(canvas, canvas$(canvas).peek()),

    /** Resolves when the canvas has been read, or the read has failed. */
    ready: (canvas: string): Promise<void> => opening.get(canvas) ?? Promise.resolve(),

    /**
     * Show at once what a command will have done, where the window can know
     * it. Returns whether anything was shown; main's event settles it either
     * way.
     */
    show: (command: Command): boolean => {
      const canvas = command.canvas;
      if ((users.get(canvas) ?? 0) === 0 || canvas$(canvas).status.peek() !== "open") return false;
      const rows = rowsAfterCommand(canvas$(canvas).peek(), command);
      if (rows === undefined) return false;
      applyRows(canvas, rows);
      return true;
    },

    /**
     * Hand a command to main. A command main refuses is undone, when it was
     * shown, by reading the canvas again, and the refusal goes to the caller.
     */
    deliver: async (command: Command, shown: boolean): Promise<void> => {
      const api = getApi();
      if (api === undefined) throw new Error("Junto is not available.");
      try {
        await api.modelCommand(command);
      } catch (error) {
        if (shown && (users.get(command.canvas) ?? 0) > 0) void read(command.canvas);
        throw error;
      }
    },

    /** Show a command and hand it to main, in one call. */
    send: async (command: Command): Promise<void> => {
      if (getApi() === undefined) throw new Error("Junto is not available.");
      await store.deliver(command, store.show(command));
    },

    applyChanged,

    /**
     * Hold a canvas from rows the caller already has, without asking main: a
     * test, or a view of a canvas that main does not serve.
     */
    adopt: (opened: Opened): (() => void) => {
      const canvas = opened.canvas;
      users.set(canvas, (users.get(canvas) ?? 0) + 1);
      applyOpened(opened);
      return () => {
        const left = (users.get(canvas) ?? 1) - 1;
        if (left > 0) users.set(canvas, left);
        else {
          users.delete(canvas);
          close(canvas);
        }
      };
    },
  };
  return store;
};

export type ModelStore = ReturnType<typeof createModelStore>;
