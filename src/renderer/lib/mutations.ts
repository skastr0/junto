import type { SheetGrid } from "@shared/model/sheet";
import type {
  CanvasDoc,
  CanvasEdge,
  CanvasNode,
  EtherRegionContract,
  EtherRegionDefaults,
  EtherTimer,
  EtherWatch,
  NodeSide,
  Ruling,
  TasksContract,
  TextNode,
} from "@shared/canvas";
import { stripEmptyRegionDefaults } from "@shared/region-defaults";
import { batch, observe } from "@legendapp/state";
import type { BindingHint } from "@shared/ipc";
import type { ActorRef } from "@shared/work-protocol";
import { formatNodeRef } from "@shared/node-ref";
import { isValidStationHostId } from "@shared/station";
import { ulid } from "ulid";
import type { RegionEnvironment } from "./region-environment";
import { TASKS_ENABLED } from "@shared/features";
import { boardRemovalWarnings, removalPolicy, wireRemovalWarnings } from "./deletion-impact";
import type { Color, Command, Node, NodeOf } from "@shared/model";
import { authoring } from "./authoring";
import { documentEdits, UnholdableEdit } from "@shared/model/document-edits";
import { createDocumentProjection } from "./document-projection";
import { canvasAfter } from "./model-undo";
import { inPaintOrder, type Canvas } from "@shared/model/canvas";
import { canvasFromDocument, nodeFromDocument, nodeToDocument, wireToDocument } from "@shared/model/from-document";
import { added, recolored, regionEdited, removed as nodesRemoved, renamed, retexted, sheetWritten, topZ } from "./model-edits";
import { modelStore } from "./use-model";
import {
  removeEdgesFromSelection,
  removeNodesFromSelection,
  replaceSelection,
  selectNode,
  state$,
} from "./state";
import { sheetStore } from "./sheet-store";

// Undo is commands (authoring). These two stacks are only what the document
// looked like before each remembered act, so that a step back or forward shows
// in the document at once, as the store already shows it; main's copy follows.
// They are for the open canvas alone and are dropped whenever it is replaced.
const shownBefore: CanvasDoc[] = [];
const shownAfter: CanvasDoc[] = [];

/** True when there is a main to send to: not in a test or a view with no bridge. */
const bridged = (): boolean => typeof window !== "undefined" && Boolean(window.junto);

// --- the document is the node store, in the old shape ----------------------
//
// TEMPORARY, with document-projection.ts. When the node store holds the open
// canvas, `state$.doc` is worked out from it and nothing else writes it: not a
// read from main, and not the writers below, whose edits reach the document by
// way of the store. It is written directly only where there is no store to
// work it out from: a view with no main (the demo) and the unit rigs.
let projection = createDocumentProjection();
let projectedName = "";

/** True when the node store holds this canvas, so the document is its projection. */
const storeHolds = (name: string): boolean =>
  name !== "" && modelStore.canvas$(name).status.peek() === "open";

/** The document of a canvas the store holds, as the store has it now. */
export const projectedDocument = (name: string): CanvasDoc => {
  if (projectedName !== name) {
    projection = createDocumentProjection();
    projectedName = name;
  }
  return projection(modelStore.canvasOf(name));
};

/** Show the open canvas as the store has it, and let go of what is no longer on it. */
const showProjected = (name: string): void => {
  if (!canvasMutationAdmissionOpen || state$.canvasName.peek() !== name) return;
  const doc = projectedDocument(name);
  if (doc === state$.doc.peek()) return;
  const nodeIds = new Set(doc.nodes.map((node) => node.id));
  const edgeIds = new Set(doc.edges.map((edge) => edge.id));
  batch(() => {
    state$.doc.set(doc);
    const selected = state$.selectedNodeIds.peek();
    const kept = selected.filter((id) => nodeIds.has(id));
    const one = state$.selectedNodeId.peek();
    const edge = state$.selectedEdgeId.peek();
    if (kept.length !== selected.length || (one !== "" && !nodeIds.has(one)) || (edge !== "" && !edgeIds.has(edge))) {
      replaceSelection({
        nodeId: nodeIds.has(one) ? one : kept.length === 1 ? (kept[0] ?? "") : "",
        nodeIds: kept,
        edgeId: edgeIds.has(edge) ? edge : "",
      });
    }
    if (!nodeIds.has(state$.focusNodeId.peek())) state$.focusNodeId.set("");
    if (!nodeIds.has(state$.editNodeId.peek())) state$.editNodeId.set("");
    state$.docVersion.set(state$.docVersion.peek() + 1);
    state$.docEpoch.set(state$.docEpoch.peek() + 1);
  });
};

/** Keep the document following the store for the open canvas. Returns the way to stop. */
export const followStoreDocument = (): (() => void) =>
  observe(() => {
    const name = state$.canvasName.get();
    if (!name) return;
    const open$ = modelStore.canvas$(name);
    if (open$.status.get() !== "open") return;
    open$.nodes.get();
    open$.wires.get();
    showProjected(name);
  });

const syncHistoryState = (): void => {
  const name = state$.canvasName.peek();
  state$.canUndo.set(shownBefore.length > 0 || (name !== "" && authoring.canUndo(name)));
  state$.canRedo.set(shownAfter.length > 0 || (name !== "" && authoring.canRedo(name)));
};
authoring.onChange(syncHistoryState);

const forgetShown = (): void => {
  shownBefore.length = 0;
  shownAfter.length = 0;
};

const confirmDestructive = (message: string): boolean =>
  typeof window === "undefined" || typeof window.confirm !== "function" || window.confirm(message);

// --- sending edits ---------------------------------------------------------
//
// The window changes a canvas by sending commands and saves no document. A
// writer here still says what the document should become; what goes out is
// the difference (document-edits.ts), as one act, with its way back
// remembered. The document the window holds is shown at once and is otherwise
// only what main last sent.

// Process-lifetime latch. Signal quit closes it once; there is deliberately no
// reopen API because a later mutation would invalidate the acknowledged final
// durable boundary while main is authorized to destroy the renderer.
let canvasMutationAdmissionOpen = true;
const activeCanvasAuthoringOperations = new Set<Promise<void>>();
// Names we intentionally discarded (delete). Nothing is sent for them until
// clearAbandonedCanvas (open/create of that name).
const abandonedNames = new Set<string>();

const without = <T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> => {
  const { [key]: _removed, ...rest } = value;
  return rest;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// When main refuses an edit the store is ahead of the canvas: it is read
// again from main, and the document follows it.
const readAgain = (name: string): void => {
  void modelStore.reread(name);
};

const settled = (name: string): void => {
  if (authoring.busy() || state$.canvasName.peek() !== name) return;
  if (state$.saveState.peek() === "saving") state$.saveState.set("saved");
};

/**
 * The commands for an edit, or nothing when the edit asks for a node the
 * canvas cannot hold: then nothing is sent, and the window says so with the
 * line a refused command shows.
 */
const editsOrRefusal = (name: string, before: CanvasDoc, next: CanvasDoc): ReadonlyArray<Command> | undefined => {
  try {
    return documentEdits(name, before, next, topZ(modelStore.canvasOf(name)));
  } catch (error) {
    if (!(error instanceof UnholdableEdit)) throw error;
    state$.saveState.set("error");
    state$.error.set(`canvas "${name}" did not take that change: ${error.message}`);
    return undefined;
  }
};

/** Send one act for the open canvas. A refusal is shown and the canvas read again. */
const sendAct = (name: string, commands: ReadonlyArray<Command>, remember: boolean): void => {
  if (commands.length === 0) return;
  state$.saveState.set("saving");
  void authoring.act(name, commands, { remember }).then(
    () => {
      state$.error.set("");
      settled(name);
    },
    (error: unknown) => {
      if (state$.canvasName.peek() === name) {
        state$.saveState.set("error");
        state$.error.set(`canvas "${name}" did not take that change: ${messageOf(error)}`);
        // What the document showed before is no longer a step anyone can take.
        forgetShown();
        syncHistoryState();
      }
      readAgain(name);
    },
  );
};

/** Resolves once everything the window has sent has been taken or refused. */
export const flushPendingCanvasSave = async (): Promise<void> => {
  await authoring.idle();
};

/** True while an edit of this window is still on its way to main. */
export const hasPendingCanvasChanges = (_name: string): boolean => authoring.busy();

export const canvasMutationsQuiesced = (): boolean => !canvasMutationAdmissionOpen;

/**
 * Admit one renderer-originated authoring operation and retain its lifetime
 * until it settles. The completion token is published before caller code runs
 * so a re-entrant quiesce cannot miss an operation it just admitted.
 */
export const runCanvasAuthoringOperation = async <T>(
  operation: () => Promise<T>,
): Promise<T | undefined> => {
  if (!canvasMutationAdmissionOpen) return undefined;
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  activeCanvasAuthoringOperations.add(completion);
  try {
    return await operation();
  } finally {
    finish();
    activeCanvasAuthoringOperations.delete(completion);
  }
};

/** Await every operation admitted before the monotonic gate closed. */
export const drainCanvasAuthoringOperations = async (): Promise<void> => {
  while (activeCanvasAuthoringOperations.size > 0) {
    await Promise.all([...activeCanvasAuthoringOperations]);
  }
};

/**
 * Commit synchronous editor-local drafts, then monotonically close document
 * mutation admission in the same turn. A throwing draft commit leaves the
 * gate open, so main can treat it as a recoverable pre-quiesce failure.
 */
export const quiesceCanvasMutations = (commitDrafts: () => void): void => {
  if (!canvasMutationAdmissionOpen) return;
  commitDrafts();
  canvasMutationAdmissionOpen = false;
};

/** After a refusal: read the canvas again and clear the mark. */
export const retrySave = (): void => {
  if (!canvasMutationAdmissionOpen) return;
  const name = state$.canvasName.peek();
  if (!name) return;
  state$.error.set("");
  state$.saveState.set("saved");
  readAgain(name);
};

// Call before deleting a canvas: mark the name abandoned so nothing more is
// sent for it, and wait out what is already on its way.
export const prepareCanvasRemoval = async (name: string): Promise<void> => {
  abandonedNames.add(name);
  state$.saveState.set("saved");
  await authoring.idle().catch(() => undefined);
  authoring.forget(name);
  if (state$.canvasName.peek() === name) forgetShown();
  syncHistoryState();
};

// After a successful open/create of `name`, allow edits again.
export const clearAbandonedCanvas = (name: string): void => {
  abandonedNames.delete(name);
};

/** Replace the open canvas's compiled execution-reference projection. */
export const replaceActiveActorRefs = (
  actorRefs: ReadonlyArray<ActorRef>,
): void => {
  state$.actorRefs.set([...actorRefs]);
};

// Say what the document should become. It is shown at once, and the
// difference from what it was is sent as one act. `structural` bumps
// docVersion; `remember` false is for an act that is not the operator's to
// take back.
export const commitDoc = (next: CanvasDoc, structural = true, remember = structural): void => {
  if (state$.settings.station.role.peek() === "remote") {
    return;
  }
  if (!canvasMutationAdmissionOpen) return;
  const before = state$.doc.peek();
  const name = state$.canvasName.peek();
  if (bridged() && storeHolds(name)) {
    // The store holds this canvas: the edit goes to it as commands, and the
    // document shows it by following the store, in this same turn.
    if (abandonedNames.has(name)) return;
    const commands = editsOrRefusal(name, before, next);
    if (commands !== undefined) sendAct(name, commands, remember);
    return;
  }
  // No store to follow: the document is written here. It is checked first all
  // the same, with or without a main to send to: an edit the canvas cannot
  // hold is refused before anything shows it.
  const commands = editsOrRefusal(name, before, next);
  if (commands === undefined) return;
  state$.doc.set(next);
  if (structural) state$.docVersion.set(state$.docVersion.peek() + 1);
  // Position-only writes still change geometric region membership — the RTS
  // bar re-polls on docEpoch without forcing a React Flow graph rebuild.
  state$.docEpoch.set(state$.docEpoch.peek() + 1);
  if (!bridged()) {
    // Nothing to send to: the document is all there is, and so is its undo.
    if (remember) {
      shownBefore.push(before);
      shownAfter.length = 0;
      syncHistoryState();
    }
    return;
  }
  if (!name || abandonedNames.has(name)) return;
  if (commands.length === 0) return;
  if (remember) {
    shownBefore.push(before);
    shownAfter.length = 0;
    syncHistoryState();
  }
  sendAct(name, commands, remember);
};

/**
 * The document after an edit, when there is no store to work it out from: the
 * canvas with the commands applied, in the old shape, keeping the document's
 * own node and edge wherever the edit did not touch the row under it.
 */
const documentAfter = (doc: CanvasDoc, before: Canvas, after: Canvas): CanvasDoc => {
  const nodeById = new Map(doc.nodes.map((node) => [node.id, node] as const));
  const edgeById = new Map(doc.edges.map((edge) => [edge.id, edge] as const));
  return {
    nodes: inPaintOrder(after).map((row) => {
      const held = nodeById.get(row.id);
      return held !== undefined && before.nodes.get(row.id) === row ? held : nodeToDocument(row);
    }),
    edges: [...after.wires.values()].map((wire) => {
      const held = edgeById.get(wire.id);
      return held !== undefined && before.wires.get(wire.id) === wire ? held : wireToDocument(wire);
    }),
  };
};

/**
 * The open canvas as it stands, read once: what the node store holds when it
 * holds the canvas, else what the document describes. For a writer that is
 * not one step, which reads, asks the operator, and only then says its
 * commands through `commitCommands`.
 */
export const canvasAsItStands = (): Canvas => {
  const name = state$.canvasName.peek();
  return storeHolds(name) ? modelStore.canvasOf(name) : canvasFromDocument(name, state$.doc.peek());
};

/**
 * Do one act on the open canvas, said as commands. This is how a writer
 * changes the canvas: `edit` is given the canvas as it stands and answers the
 * commands (model-edits.ts makes them), which go out as one act, undone
 * together unless `remember` is false. Nothing happens on a Remote station,
 * once the window has closed admission for quitting, or for a canvas being
 * removed. A command main refuses shows the refusal line and the canvas is
 * read again.
 *
 * Where the node store holds the canvas, which is always in the app, the
 * commands go to it and the document follows. Where nothing holds it (a view
 * with no main, a unit rig that never opened a canvas) the commands are
 * applied to the document itself, so the same writer works in both and a rig
 * may assert on either.
 */
export const commitCommands = (
  edit: (canvas: Canvas) => ReadonlyArray<Command>,
  options: { readonly remember?: boolean } = {},
): void => {
  if (state$.settings.station.role.peek() === "remote") return;
  if (!canvasMutationAdmissionOpen) return;
  const name = state$.canvasName.peek();
  if (abandonedNames.has(name)) return;
  const remember = options.remember ?? true;
  const held = storeHolds(name);
  const doc = state$.doc.peek();
  let canvas: Canvas;
  let commands: ReadonlyArray<Command>;
  try {
    canvas = held ? modelStore.canvasOf(name) : canvasFromDocument(name, doc);
    commands = edit(canvas);
  } catch (error) {
    state$.saveState.set("error");
    state$.error.set(`canvas "${name}" did not take that change: ${messageOf(error)}`);
    return;
  }
  if (commands.length === 0) return;
  if (held && bridged()) {
    sendAct(name, commands, remember);
    return;
  }
  // No main, or no store: the commands are applied here.
  const after = commands.reduce((current, command) => canvasAfter(current, command), canvas);
  if (held) for (const command of commands) modelStore.show(command);
  batch(() => {
    state$.doc.set(documentAfter(doc, canvas, after));
    state$.docVersion.set(state$.docVersion.peek() + 1);
    state$.docEpoch.set(state$.docEpoch.peek() + 1);
  });
  if (remember && !bridged()) {
    shownBefore.push(doc);
    shownAfter.length = 0;
    syncHistoryState();
  }
  if (bridged() && name) sendAct(name, commands, remember);
};

export interface LoadDocOptions {
  /**
   * Same-canvas projections retain interaction state only while its referenced
   * node or edge still exists. Canvas navigation keeps the reset default.
   */
  readonly preserveValidInteraction?: boolean;
}

// Replace the document from an authoritative source (open / external reload).
// Always structural; sends nothing (it mirrors what main already holds). Undo
// is kept: it is commands, and belongs to the canvas, not to this copy of it.
export const loadDoc = (
  doc: CanvasDoc,
  _revision?: string,
  _name = state$.canvasName.peek(),
  options: LoadDocOptions = {},
): void => {
  if (!canvasMutationAdmissionOpen) return;
  // What the document showed before belongs to the document it replaces.
  forgetShown();
  const nodeIds = options.preserveValidInteraction
    ? new Set(doc.nodes.map((node) => node.id))
    : undefined;
  const edgeIds = options.preserveValidInteraction
    ? new Set(doc.edges.map((edge) => edge.id))
    : undefined;
  const previousSelectedNodeIds = state$.selectedNodeIds.peek();
  const retainedSelectedNodeIds = nodeIds
    ? previousSelectedNodeIds.filter((id) => nodeIds.has(id))
    : [];
  const selectedNodeIds =
    retainedSelectedNodeIds.length === previousSelectedNodeIds.length
      ? previousSelectedNodeIds
      : retainedSelectedNodeIds;
  const previousSelectedNodeId = state$.selectedNodeId.peek();
  const selectedNodeId = nodeIds?.has(previousSelectedNodeId)
    ? previousSelectedNodeId
    : selectedNodeIds.length === 1
      ? selectedNodeIds[0] ?? ""
      : "";
  const previousSelectedEdgeId = state$.selectedEdgeId.peek();
  const selectedEdgeId = edgeIds?.has(previousSelectedEdgeId)
    ? previousSelectedEdgeId
    : "";
  const previousFocusNodeId = state$.focusNodeId.peek();
  const focusNodeId = nodeIds?.has(previousFocusNodeId) ? previousFocusNodeId : "";
  const previousEditNodeId = state$.editNodeId.peek();
  const editNodeId = nodeIds?.has(previousEditNodeId) ? previousEditNodeId : "";
  syncHistoryState();
  state$.saveState.set("saved");
  state$.doc.set(doc);
  state$.editNodeId.set(editNodeId);
  replaceSelection({ nodeId: selectedNodeId, nodeIds: selectedNodeIds, edgeId: selectedEdgeId });
  state$.focusNodeId.set(focusNodeId);
  // `loadDoc` without the actor references read with the canvas must fail closed.
  // App installs the exact compiled refs in the same Legend batch.
  state$.actorRefs.set([]);
  state$.docVersion.set(state$.docVersion.peek() + 1);
  state$.docEpoch.set(state$.docEpoch.peek() + 1);
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
// Regions open the folder-paths modal instead of the label editor so the first
// configure step is host cwd (the main reason to create a region).
export const addNode = (
  made: CanvasNode | Node,
  options?: {
    readonly edit?: boolean;
    readonly focus?: boolean;
    /** Open region folder-paths modal (groups only; default true for groups). */
    readonly regionPaths?: boolean;
  },
): void => {
  batch(() => {
    state$.edgeFilter.set("");
    // Keep the single/multi selection pair coherent so the RTS command card
    // targets this node only (stale selectedNodeIds would open the multi card).
    selectNode(made.id);
  });
  // One Add of the node as the canvas holds it, above everything there. A
  // caller still making a document node has it read here, and a node the
  // canvas cannot hold is refused whole.
  let node: Node | undefined;
  commitCommands((canvas) => {
    node = "kind" in made ? made : nodeFromDocument(canvas.name, made, topZ(canvas));
    return added(canvas, [node]);
  });
  if (node === undefined) return;
  const isRegion = node.kind === "region";
  const shouldFocus = options?.focus !== false;
  // A region skips the label editor: its folder paths are the first step.
  const shouldEdit = options?.edit !== false && !isRegion;
  const shouldOpenPaths = isRegion && options?.regionPaths !== false;
  if (!shouldFocus && !shouldEdit && !shouldOpenPaths) return;
  window.setTimeout(() => {
    batch(() => {
      if (shouldFocus) state$.focusNodeId.set(made.id);
      if (shouldEdit) state$.editNodeId.set(made.id);
      if (shouldOpenPaths) state$.regionPathsNodeId.set(made.id);
    });
  }, 0);
};

const turnBack = (direction: "undo" | "redo"): void => {
  if (!canvasMutationAdmissionOpen) return;
  const name = state$.canvasName.peek();
  if (bridged() && storeHolds(name)) {
    // Undo is commands: the store shows the step and the document follows.
    if (abandonedNames.has(name)) return;
    state$.editNodeId.set("");
    state$.regionPathsNodeId.set("");
    state$.saveState.set("saving");
    void authoring[direction](name).then(
      () => settled(name),
      (error: unknown) => {
        if (state$.canvasName.peek() === name) {
          state$.saveState.set("error");
          state$.error.set(`canvas "${name}" could not ${direction} that: ${messageOf(error)}`);
        }
        readAgain(name);
      },
    );
    return;
  }
  const from = direction === "undo" ? shownBefore : shownAfter;
  const to = direction === "undo" ? shownAfter : shownBefore;
  const shown = from.pop();
  if (shown !== undefined) {
    to.push(state$.doc.peek());
    state$.editNodeId.set("");
    state$.regionPathsNodeId.set("");
    state$.doc.set(shown);
    state$.docVersion.set(state$.docVersion.peek() + 1);
    // Generation fence for async delete/teardown continuations (same as commitDoc).
    state$.docEpoch.set(state$.docEpoch.peek() + 1);
  }
  syncHistoryState();
  if (!bridged() || !name || abandonedNames.has(name)) return;
  state$.saveState.set("saving");
  void authoring[direction](name).then(
    (stepped) => {
      settled(name);
      // The document showed a step that the canvas did not have, or the
      // canvas took one the document could not show: main's copy settles it.
      if (stepped !== (shown !== undefined)) readAgain(name);
    },
    (error: unknown) => {
      if (state$.canvasName.peek() === name) {
        state$.saveState.set("error");
        state$.error.set(`canvas "${name}" could not ${direction} that: ${messageOf(error)}`);
        forgetShown();
        syncHistoryState();
      }
      readAgain(name);
    },
  );
};

export const undo = (): void => turnBack("undo");

export const redo = (): void => turnBack("redo");

export const deleteNode = (id: string): void => {
  startDeleteNodes([id]);
};

interface ConfirmedPageStops {
  readonly canvasName: string;
  readonly docEpoch: number;
  readonly refs: ReadonlySet<string>;
}

const deleteNodesInternal = async (
  ids: ReadonlyArray<string>,
  confirmedPageStops?: ConfirmedPageStops,
): Promise<void> => {
  if (!canvasMutationAdmissionOpen) return;
  const removed = new Set(ids);
  if (removed.size === 0) return;
  const canvasName = state$.canvasName.peek();
  const docEpoch = state$.docEpoch.peek();
  if (
    confirmedPageStops !== undefined &&
    (confirmedPageStops.canvasName !== canvasName || confirmedPageStops.docEpoch !== docEpoch)
  ) {
    state$.error.set("Canvas changed before Stop Page completed; no nodes were deleted.");
    return;
  }
  // The canvas as it stands when the operator asks: what is to go, and the
  // wires that go with it.
  const canvas = canvasAsItStands();
  const existingNodes = [...canvas.nodes.values()].filter((node) => removed.has(node.id));
  if (existingNodes.length === 0) return;
  const removedWires = [...canvas.wires.values()].filter(
    (wire) => removed.has(wire.from) || removed.has(wire.to),
  );
  const connectedEdges = removedWires.length;
  const nodeLabel = existingNodes.length === 1 ? "this node" : `${existingNodes.length} nodes`;
  const relationLabel = connectedEdges === 0 ? "" : ` Connected edges (${connectedEdges}) will also be removed.`;
  const policy = await removalPolicy(canvasName, canvas, removed, removedWires);
  // The canvas changed while the policy was read: the question would be about
  // a canvas the operator is no longer looking at.
  if (state$.canvasName.peek() !== canvasName || state$.docEpoch.peek() !== docEpoch) return;
  const impactWarnings = [
    ...boardRemovalWarnings(canvas, removed, policy),
    ...wireRemovalWarnings(canvas, removedWires, policy, removed),
  ];
  const impactCopy =
    impactWarnings.length === 0 ? "" : `\n${impactWarnings.join("\n")}`;
  if (
    confirmedPageStops === undefined &&
    !confirmDestructive(`Delete ${nodeLabel}?${impactCopy}${relationLabel}`)
  ) return;

  // A page follows what it says happens when it is removed: its session is
  // closed, or left running when the operator chose to detach.
  const pageActions: Array<{ readonly ref: string; readonly stop: boolean }> = [];
  for (const node of existingNodes) {
    if (node.kind !== "page") continue;
    try {
      pageActions.push({
        ref: formatNodeRef({ canvasName, nodeId: node.id }),
        stop: node.onRemove === "kill-session",
      });
    } catch {
      // Invalid document identity has no safe automation fallback. The node
      // still deletes; only browser detach is skipped.
    }
  }

  const pendingStops = pageActions.filter(
    (action) => action.stop && !confirmedPageStops?.refs.has(action.ref),
  );
  if (pendingStops.length > 0) {
    try {
      const { stopDockBrowser } = await import("./dock-state");
      // Import resolution is an async boundary. A signal latch that closed in
      // the meantime must prevent the destructive Stop Page call itself.
      if (!canvasMutationAdmissionOpen) return;
      const results = await Promise.all(
        pendingStops.map(async (action) => ({
          ref: action.ref,
          stopped: await stopDockBrowser(action.ref),
        })),
      );
      // A stop admitted before quiescence is drained, but its late renderer
      // continuation cannot mutate the now-final document.
      if (!canvasMutationAdmissionOpen) return;
      if (!results.every((result) => result.stopped)) {
        state$.error.set("Stop Page failed; the page node was not deleted.");
        return;
      }
      await deleteNodesInternal(ids, {
        canvasName,
        docEpoch,
        refs: new Set([
          ...(confirmedPageStops?.refs ?? []),
          ...results.map((result) => result.ref),
        ]),
      });
    } catch {
      if (canvasMutationAdmissionOpen) {
        state$.error.set("Stop Page is unavailable; the page node was not deleted.");
      }
    }
    return;
  }

  const sideEffects: Array<Promise<void>> = [];

  // Agent delete: Main-owned lease locks keys, admits chatOpen tombstones,
  // and awaits verified close BEFORE document mutation. Finish releases the
  // fence after commit or abort (TTL is the backstop).
  const agentNodes = existingNodes.filter((n): n is NodeOf<"agent"> => n.kind === "agent");
  const agentKeys = agentNodes.map((n) => n.agentKey);
  // Managed terminal authority is the exact (host, binding) pair, never the
  // agent key. Two cards may temporarily share an agent key while still owning
  // distinct seats, and duplicate references to one seat must stop it once.
  const managedTerminalBindings = new Map<
    string,
    { readonly bindingId: string; readonly hostId: string }
  >();
  for (const node of agentNodes) {
    managedTerminalBindings.set(`${node.host}\0${node.bindingId}`, { bindingId: node.bindingId, hostId: node.host });
  }
  let chatDeleteLeaseId: string | undefined;
  let terminalDeleteLeaseId: string | undefined;
  const finishDeleteLeases = async (
    outcome: "committed" | "aborted",
  ): Promise<void> => {
    const chatLease = chatDeleteLeaseId;
    const terminalLease = terminalDeleteLeaseId;
    chatDeleteLeaseId = undefined;
    terminalDeleteLeaseId = undefined;
    const finishes: Array<Promise<unknown>> = [];
    if (chatLease !== undefined) {
      finishes.push(
        import("./chat-state").then(({ finishAgentNodeDelete }) =>
          finishAgentNodeDelete(chatLease, outcome)
        ),
      );
    }
    if (terminalLease !== undefined) {
      const finish = window.junto?.terminalFinishNodeDelete;
      if (typeof finish === "function") {
        finishes.push(finish(terminalLease, outcome));
      }
    }
    await Promise.all(finishes);
  };

  if (agentKeys.length > 0) {
    if (!canvasMutationAdmissionOpen) return;
    const { beginAgentNodeDelete } = await import("./chat-state");
    const began = await beginAgentNodeDelete(agentKeys);
    if (!began.ok) {
      if (canvasMutationAdmissionOpen) {
        state$.error.set(
          "Agent delete fence failed; the agent node was not deleted.",
        );
      }
      return;
    }
    chatDeleteLeaseId = began.leaseId;
    if (!canvasMutationAdmissionOpen) {
      await finishDeleteLeases("aborted");
      return;
    }
    if (!began.closeResults.every((result) => result.ok && result.clean)) {
      await finishDeleteLeases("aborted");
      state$.error.set(
        "Agent session teardown failed or was unclean; the agent node was not deleted.",
      );
      return;
    }
  }

  const canvasGenerationMatches = (): boolean =>
    state$.canvasName.peek() === canvasName && state$.docEpoch.peek() === docEpoch;
  const abortForCanvasChange = async (): Promise<void> => {
    await finishDeleteLeases("aborted");
    if (canvasMutationAdmissionOpen) {
      state$.error.set(
        "Canvas changed before deletion completed; no nodes were deleted.",
      );
    }
  };

  // After any await (page stop / agent close), the operator may have switched
  // canvases. Re-check identity before starting another destructive operation —
  // never stop a binding captured from canvas A after canvas B became current.
  if (!canvasGenerationMatches()) {
    await abortForCanvasChange();
    return;
  }
  if (!canvasMutationAdmissionOpen) {
    await finishDeleteLeases("aborted");
    return;
  }

  // A managed agent card owns a native terminal generation in addition to the
  // ACP/chat delete fence. Main locks every exact host/binding before teardown,
  // invalidates creates that were awaiting IPC work, and returns only after the
  // owned PTY plus any Prime Agent daemon have a clean exact receipt.
  if (managedTerminalBindings.size > 0) {
    const beginTerminalDelete =
      window.junto?.terminalBeginNodeDelete;
    if (typeof beginTerminalDelete !== "function") {
      await finishDeleteLeases("aborted");
      if (canvasMutationAdmissionOpen) {
        state$.error.set(
          "Junto could not fence the managed terminal; the agent node was not deleted.",
        );
      }
      return;
    }
    let began;
    try {
      began = await beginTerminalDelete([
        ...managedTerminalBindings.values(),
      ]);
    } catch {
      await finishDeleteLeases("aborted");
      if (canvasMutationAdmissionOpen) {
        state$.error.set(
          canvasGenerationMatches()
            ? "Junto could not stop the managed terminal cleanly; the agent node was not deleted."
            : "Canvas changed before deletion completed; no nodes were deleted.",
        );
      }
      return;
    }
    if (!began.ok) {
      await finishDeleteLeases("aborted");
      if (canvasMutationAdmissionOpen) {
        state$.error.set(
          canvasGenerationMatches()
            ? "Junto could not stop the managed terminal cleanly; the agent node was not deleted."
            : "Canvas changed before deletion completed; no nodes were deleted.",
        );
      }
      return;
    }
    terminalDeleteLeaseId = began.leaseId;
    if (!canvasMutationAdmissionOpen) {
      await finishDeleteLeases("aborted");
      return;
    }
    if (!canvasGenerationMatches()) {
      await abortForCanvasChange();
      return;
    }
  }

  // The awaited terminal stops are also generation boundaries. Keep the final
  // commit fenced even when there were no managed bindings to stop.
  if (!canvasGenerationMatches()) {
    await abortForCanvasChange();
    return;
  }
  if (!canvasMutationAdmissionOpen) {
    await finishDeleteLeases("aborted");
    return;
  }

  if (pageActions.length > 0) {
    sideEffects.push(
      import("./dock-state").then(({ closeDockBrowser }) => {
        if (!canvasMutationAdmissionOpen) return;
        for (const action of pageActions) {
          if (!action.stop) closeDockBrowser(action.ref);
        }
      }),
    );
  }
  if (agentNodes.length > 0) {
    sideEffects.push(
      import("./dock-state").then(({ chatSurfaceId, closeWorkbenchSurface }) => {
        for (const node of agentNodes) {
          closeWorkbenchSurface(chatSurfaceId(node.id));
        }
      }),
    );
  }

  const doomed = new Set(existingNodes.map((node) => node.id));
  removeNodesFromSelection(doomed);
  if (doomed.size === 0) {
    await finishDeleteLeases("aborted");
    await Promise.all(sideEffects);
    return;
  }
  // The same canvas generation as when the operator was asked, checked above.
  removeEdgesFromSelection(new Set(
    [...canvasAsItStands().wires.values()]
      .filter((wire) => doomed.has(wire.from) || doomed.has(wire.to))
      .map((wire) => wire.id),
  ));
  // One Remove naming the nodes; the wires at either end go with them.
  commitCommands((now) => nodesRemoved(now, [...doomed]));
  // Release only after the document commit so reopen cannot race the card.
  await finishDeleteLeases("committed");
  await Promise.all(sideEffects);
};

const startDeleteNodes = (ids: ReadonlyArray<string>): void => {
  void runCanvasAuthoringOperation(() => deleteNodesInternal(ids)).catch((error) => {
    if (canvasMutationAdmissionOpen) state$.error.set(messageOf(error));
  });
};

/** Public deletion entrypoint; Stop Page completion state is module-private. */
export const deleteNodes = (ids: ReadonlyArray<string>): void => {
  startDeleteNodes(ids);
};

/**
 * Change what a card says. A note and a bare label hold text, and take it
 * whole. Anything else is named: its name is the first line of what was
 * typed, kept in that kind's own field.
 */
export const editText = (id: string, text: string): void => {
  commitCommands((canvas) => {
    const kind = canvas.nodes.get(id as Node["id"])?.kind;
    return kind === "note" || kind === "label" ? retexted(canvas, id, text) : renamed(canvas, id, text);
  });
};

/** Rename a seat or a terminal: its label, which is one line and, for a seat, never empty. */
export const renameTerminalNode = (id: string, firstLine: string): void => {
  if (!firstLine.trim()) return;
  commitCommands((canvas) => renamed(canvas, id, firstLine));
};

/** Page URL edit only — plain link furniture is retired. */
export const editLink = (id: string, url: string): void => {
  const next = url.trim();
  if (!next) return;
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) =>
      n.id === id &&
      n.type === "link" &&
      n.ether?.entity?.kind === "page"
        ? { ...n, url: next }
        : n,
    ),
  });
};

/** Edit the authorial browser binding without disturbing URL or sibling ether. */
export const setPageBinding = (
  id: string,
  input: { readonly profile: string; readonly host: string },
): void => {
  const profile = input.profile.trim();
  const host = input.host.trim();
  if (!profile || !isValidStationHostId(host)) return;
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((node) =>
      node.id === id &&
      node.type === "link" &&
      node.ether?.entity?.kind === "page"
        ? {
            ...node,
            ether: {
              ...node.ether,
              host,
              browser: {
                ...(node.ether.browser ?? {}),
                profile,
              },
            },
          }
        : node,
    ),
  });
};

/**
 * Change the queue home used for newly submitted tasks.
 *
 * Existing work rows keep their single authority home. Actor nodes are
 * deliberately excluded: moving one changes its InstallationId-derived
 * ActorSeatId, so relocation must be expressed as a newly authored seat after
 * the old seat's work has been resolved.
 */
export const setGitCwd = (id: string, input: string): void => {
  const cwd = input.trim();
  if (!cwd) return;
  const doc = state$.doc.peek();
  const target = doc.nodes.find((node) => node.id === id);
  if (target?.ether?.entity?.kind !== "git" || target.ether.git?.cwd === cwd) {
    return;
  }
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((node) =>
      node.id === id && node.ether?.entity?.kind === "git"
        ? {
            ...node,
            ether: {
              ...node.ether,
              git: { cwd },
            },
          }
        : node,
    ),
  });
};

export const setNodeHost = (id: string, input: string): void => {
  const host = input.trim();
  if (!isValidStationHostId(host)) return;
  const doc = state$.doc.peek();
  const target = doc.nodes.find((node) => node.id === id);
  if (
    target?.ether?.entity?.kind !== "task" ||
    target.ether.host === host
  ) {
    return;
  }
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((node) =>
      node.id === id && node.ether?.entity?.kind === "task"
        ? {
            ...node,
            ether: {
              ...node.ether,
              host,
            },
          }
        : node,
    ),
  });
};



export const renameGroup = (id: string, label: string): void => {
  commitCommands((canvas) => (canvas.nodes.get(id as Node["id"])?.kind === "region" ? renamed(canvas, id, label) : []));
};


export const setNodeColor = (id: string, color?: string): void => {
  setNodeColorForNodes([id], color);
};

/** Bulk accent color for multi-select — one commit, not N toggles. */
export const setNodeColorForNodes = (
  ids: ReadonlyArray<string>,
  color?: string,
): void => {
  if (ids.length === 0) return;
  commitCommands((canvas) => recolored(canvas, ids, (color || undefined) as Color | undefined));
};

// Region hold toggle. Only the hold changes: the region's briefing and
// defaults are other fields of the same node and are not sent. Membership is
// never written here: it stays derived (geometry.ts).
export const setRegionHold = (id: string, hold: boolean): void => {
  commitCommands((canvas) => regionEdited(canvas, id, { hold }));
};

// Region spawn defaults (group nodes only). Create-time stamp source for
// page nodes placed inside the region — never live rebind.
// Merges into ether.region so hold + instruction survive. Empty bags strip.
export const setRegionDefaults = (id: string, defaults: EtherRegionDefaults | undefined): void => {
  const doc = state$.doc.peek();
  const cleaned = stripEmptyRegionDefaults(defaults);
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.id !== id || n.type !== "group") return n;
      const currentRegion = n.ether?.region ?? {};
      const nextRegion = cleaned
        ? { ...currentRegion, defaults: cleaned }
        : without(currentRegion, "defaults");
      if (Object.keys(nextRegion).length > 0) {
        return { ...n, ether: { ...(n.ether ?? {}), region: nextRegion } };
      }
      if (!n.ether) return n;
      const nextEther = without(n.ether, "region");
      return (Object.keys(nextEther).length ? { ...n, ether: nextEther } : without(n, "ether")) as CanvasNode;
    }),
  });
};

// Region environment (group nodes only): where the seats inside get their
// environment at launch. Names and references only; the one value the
// document ever holds is a plain `value` source. Read live at every spawn,
// never stamped. Merges into ether.region so hold, instruction, defaults and
// contract survive; an empty environment strips.
export const setRegionEnvironment = (id: string, environment: RegionEnvironment | undefined): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.id !== id || n.type !== "group") return n;
      const currentRegion = n.ether?.region ?? {};
      const nextRegion = environment
        ? { ...currentRegion, environment }
        : without(currentRegion, "environment");
      if (Object.keys(nextRegion).length > 0) {
        return { ...n, ether: { ...(n.ether ?? {}), region: nextRegion } };
      }
      if (!n.ether) return n;
      const nextEther = without(n.ether, "region");
      return (Object.keys(nextEther).length ? { ...n, ether: nextEther } : without(n, "ether")) as CanvasNode;
    }),
  });
};

// The claim tick runs in the kernel only (kernel/service.ts runClaimTicks,
// pause-gated). The old renderer-side tick wrapper is gone — a canvas-door
// tick would bypass the pause plane.

// Watcher/timer definitions are document data (the kernel's runtime state
// derived from them is not — that lives only in kernel app memory, per the
// frozen contract). Empty optional fields never survive: blank source/key/stat
// strings collapse to "field absent".
const stripEmptyWatch = (watch: EtherWatch): EtherWatch => {
  const key = watch.key?.trim();
  const stat = watch.stat?.trim();
  return {
    kind: watch.kind,
    ...(watch.source ? { source: watch.source } : {}),
    ...(key ? { key } : {}),
    ...(stat ? { stat } : {}),
    ...(watch.op ? { op: watch.op } : {}),
    ...(watch.value !== undefined ? { value: watch.value } : {}),
  };
};

// Writes/clears a node's ether.watch (predicate definition for a watcher
// node). Strip pattern: strip empty fields, drop the
// `watch` key entirely once cleared, degrade `ether` itself away when it
// would otherwise be left holding nothing. Runtime evaluation of the
// predicate is the kernel's job (kernel-state.ts) — this only ever writes
// the definition, never a result.
export const setNodeWatch = (id: string, watch: EtherWatch | undefined): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.id !== id) return n;
      const cleaned = watch ? stripEmptyWatch(watch) : undefined;
      if (cleaned) {
        return { ...n, ether: { ...(n.ether ?? {}), watch: cleaned } };
      }
      if (!n.ether) return n;
      const nextEther = without(n.ether, "watch");
      return (Object.keys(nextEther).length ? { ...n, ether: nextEther } : without(n, "ether")) as CanvasNode;
    }),
  });
};

// Writes/clears a node's ether.timer. The v1 5-minute floor is a UI guard
// (the editor rejects the input before it ever reaches here); this mutation
// stays defensive and drops a sub-floor value rather than persist it.
const MIN_TIMER_EVERY_MINUTES = 5;

export const setNodeTimer = (id: string, timer: EtherTimer | undefined): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.id !== id) return n;
      const expression = timer?.expression?.trim().replace(/\s+/g, " ");
      const every =
        typeof timer?.everyMinutes === "number" &&
        Number.isFinite(timer.everyMinutes) &&
        timer.everyMinutes > 0
          ? Math.round(timer.everyMinutes)
          : undefined;
      if (expression || every !== undefined) {
        return {
          ...n,
          ether: {
            ...(n.ether ?? {}),
            timer: {
              ...(expression ? { expression } : {}),
              ...(every !== undefined ? { everyMinutes: every } : {}),
            },
          },
        };
      }
      if (!n.ether) return n;
      const nextEther = without(n.ether, "timer");
      return (Object.keys(nextEther).length ? { ...n, ether: nextEther } : without(n, "ether")) as CanvasNode;
    }),
  });
};

// Checklist mutator deleted — work ops live in main (WorkService).

// --- task rules and path: authorial contract + flow mutations -------------
// Work-row ops (promote, transition, board) go through Work IPC channels
// (preload) — never through commitDoc. These four are the authorial side:
// region/board rules and the task-path DAG, all operator-only writes.

/** Collapse an empty claims/rulings bag to `undefined` so the doc stays sparse. */
const stripEmptyRegionContract = (
  contract: EtherRegionContract | undefined,
): EtherRegionContract | undefined => {
  if (!contract) return undefined;
  const rules = contract.rules && contract.rules.length > 0 ? contract.rules : undefined;
  const rulings = contract.rulings && contract.rulings.length > 0 ? contract.rulings : undefined;
  if (!rules && !rulings) return undefined;
  return { ...(rules ? { rules } : {}), ...(rulings ? { rulings } : {}) };
};

/** The grid last written, including after an editor releases its store hold. */
const lastSheetWritten = new Map<string, SheetGrid>();

const applyNodeSheet = (id: string, sheet: SheetGrid, remember: boolean): void => {
  commitCommands((canvas) => {
    const key = `${canvas.name}/${id}`;
    const now = sheetStore.gridOf(canvas.name, id);
    if (now === sheet || (now === undefined && lastSheetWritten.get(key) === sheet)) return [];
    const commands = sheetWritten(canvas, id, sheet, now);
    if (commands.length > 0) lastSheetWritten.set(key, sheet);
    return commands;
  }, { remember });
};

/** Write the separately held grid; typing bursts share the first write's undo. */
export const setNodeSheet = (id: string, sheet: SheetGrid): void => {
  applyNodeSheet(id, sheet, true);
};

const sheetTypingBurst = new Map<string, ReturnType<typeof setTimeout>>();
const SHEET_TYPING_BURST_MS = 400;

export const setNodeSheetTyping = (id: string, sheet: SheetGrid): void => {
  const recordHistory = !sheetTypingBurst.has(id);
  const previous = sheetTypingBurst.get(id);
  if (previous !== undefined) clearTimeout(previous);
  sheetTypingBurst.set(
    id,
    setTimeout(() => {
      sheetTypingBurst.delete(id);
    }, SHEET_TYPING_BURST_MS),
  );
  applyNodeSheet(id, sheet, recordHistory);
};

/** Drop a coalesced typing burst so the next write starts a new undo frame. */
export const flushNodeSheetTyping = (id: string): void => {
  const previous = sheetTypingBurst.get(id);
  if (previous === undefined) return;
  clearTimeout(previous);
  sheetTypingBurst.delete(id);
};

export const setRegionContract = (
  id: string,
  contract: EtherRegionContract | undefined,
): void => {
  // Region rules ride the Tasks gate; a tasks-off build never writes them.
  if (!TASKS_ENABLED) return;
  const doc = state$.doc.peek();
  const cleaned = stripEmptyRegionContract(contract);
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.id !== id || n.type !== "group") return n;
      const currentRegion = n.ether?.region ?? {};
      const nextRegion = cleaned
        ? { ...currentRegion, contract: cleaned }
        : without(currentRegion, "contract");
      if (Object.keys(nextRegion).length > 0) {
        return { ...n, ether: { ...(n.ether ?? {}), region: nextRegion } };
      }
      if (!n.ether) return n;
      const nextEther = without(n.ether, "region");
      return (Object.keys(nextEther).length ? { ...n, ether: nextEther } : without(n, "ether")) as CanvasNode;
    }),
  });
};

/**
 * Operator-authored board settings (instructions, board rules,
 * incoming/outgoing admission + check config). Tasks nodes only
 * (`ether.entity.kind === "task"`); the contract lives beside the runtime
 * `items` projection in `ether.tasks` and this mutation never
 * touches that projection — an authorial write carrying non-empty work rows
 * is rejected at the write boundary (canvases.ts containsWorkProjection).
 */
export const setBoardSettings = (
  id: string,
  contract: TasksContract | undefined,
): void => {
  const doc = state$.doc.peek();
  const cleaned = contract && Object.keys(contract).length > 0 ? contract : undefined;
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.id !== id || n.ether?.entity?.kind !== "task") return n;
      const ether = n.ether ?? {};
      const currentTasks = ether.tasks ?? { items: [] };
      const nextTasks = cleaned
        ? { ...currentTasks, contract: cleaned }
        : without(currentTasks, "contract");
      return { ...n, ether: { ...ether, tasks: nextTasks } };
    }),
  });
};

/**
 * Pin an escalation/request resolution as a standing ruling on a region's
 * contract (spec §6). Mints `id` + `pinnedAt` here, the same posture as
 * addNode/addEdge minting their own ids — callers supply only the resolved
 * text and its optional source. Group nodes only; blank text is a no-op.
 */
export const pinRuling = (
  regionId: string,
  text: string,
  sourceRequestId?: string,
): void => {
  const trimmed = text.trim();
  if (!trimmed || !TASKS_ENABLED) return;
  const doc = state$.doc.peek();
  const region = doc.nodes.find((n) => n.id === regionId);
  if (!region || region.type !== "group") return;
  const ruling: Ruling = {
    id: ulid(),
    text: trimmed,
    pinnedAt: new Date().toISOString(),
    ...(sourceRequestId ? { sourceRequestId } : {}),
  };
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.id !== regionId) return n;
      const ether = n.ether ?? {};
      const currentRegion = ether.region ?? {};
      const currentContract = currentRegion.contract ?? {};
      const nextContract: EtherRegionContract = {
        ...currentContract,
        rulings: [...(currentContract.rulings ?? []), ruling],
      };
      return { ...n, ether: { ...ether, region: { ...currentRegion, contract: nextContract } } };
    }),
  });
};
