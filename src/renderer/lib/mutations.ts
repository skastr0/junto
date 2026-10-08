import type { SheetGrid } from "@shared/model/sheet";
import type { NodeSide } from "@shared/canvas";
import { stripEmptyRegionDefaults } from "@shared/region-defaults";
import { batch, observe } from "@legendapp/state";
import type { ActorRef } from "@shared/work-protocol";
import { formatNodeRef } from "@shared/node-ref";
import { isValidStationHostId } from "@shared/station";
import { ulid } from "ulid";
import { TASKS_ENABLED } from "@shared/features";
import { boardRemovalWarnings, removalPolicy, wireRemovalWarnings } from "./deletion-impact";
import type { Color, Command, Node, NodeOf, RegionContract, RegionDefaults, RegionEnvironment } from "@shared/model";
import type { Ruling, TasksContract } from "@shared/work-model";
import { authoring } from "./authoring";
import type { Canvas } from "@shared/model/canvas";
import { added, cronEdited, gitEdited, pageEdited, recolored, regionEdited, removed as nodesRemoved, renamed, retexted, sheetWritten, taskBoardEdited, watcherEdited } from "./model-edits";
import { modelStore } from "./use-model";
import {
  removeEdgesFromSelection,
  removeNodesFromSelection,
  replaceSelection,
  selectNode,
  state$,
} from "./state";
import { sheetStore } from "./sheet-store";

/** True when the node store holds this canvas. Nothing is edited on one it does not. */
const storeHolds = (name: string): boolean =>
  name !== "" && modelStore.canvas$(name).status.peek() === "open";

// --- following the store ---------------------------------------------------
//
// The open canvas is what the node store holds. When it changes, by this
// window's own edit or by main's word, what the window had selected, focused
// or open for editing is let go where it is no longer on the canvas, and the
// two counters the surfaces rebuild on are stepped.
let followedNodes: unknown;
let followedWires: unknown;

const dropWhatLeft = (name: string, reset: boolean): void => {
  const canvas = modelStore.canvasOf(name);
  followedNodes = canvas.nodes;
  followedWires = canvas.wires;
  const hasNode = (id: string): boolean => !reset && canvas.nodes.has(id as Node["id"]);
  const hasWire = (id: string): boolean => !reset && canvas.wires.has(id as never);
  batch(() => {
    const selected = state$.selectedNodeIds.peek();
    const kept = selected.filter(hasNode);
    const one = state$.selectedNodeId.peek();
    const edge = state$.selectedEdgeId.peek();
    if (kept.length !== selected.length || (one !== "" && !hasNode(one)) || (edge !== "" && !hasWire(edge))) {
      replaceSelection({
        nodeId: hasNode(one) ? one : kept.length === 1 ? (kept[0] ?? "") : "",
        nodeIds: kept,
        edgeId: hasWire(edge) ? edge : "",
      });
    }
    if (!hasNode(state$.focusNodeId.peek())) state$.focusNodeId.set("");
    if (!hasNode(state$.editNodeId.peek())) state$.editNodeId.set("");
    state$.docVersion.set(state$.docVersion.peek() + 1);
    state$.docEpoch.set(state$.docEpoch.peek() + 1);
  });
};

/** Follow the store for the open canvas. Returns the way to stop. */
export const followStore = (): (() => void) =>
  observe(() => {
    const name = state$.canvasName.get();
    if (!name) return;
    const open$ = modelStore.canvas$(name);
    if (open$.status.get() !== "open") return;
    const nodes = open$.nodes.get();
    const wires = open$.wires.get();
    if (!canvasMutationAdmissionOpen || state$.canvasName.peek() !== name) return;
    if (nodes === followedNodes && wires === followedWires) return;
    dropWhatLeft(name, false);
  });

const syncHistoryState = (): void => {
  const name = state$.canvasName.peek();
  state$.canUndo.set(name !== "" && authoring.canUndo(name));
  state$.canRedo.set(name !== "" && authoring.canRedo(name));
};
authoring.onChange(syncHistoryState);

const confirmDestructive = (message: string): boolean =>
  typeof window === "undefined" || typeof window.confirm !== "function" || window.confirm(message);

// --- sending edits ---------------------------------------------------------
//
// The window changes a canvas by sending commands. A writer says its commands
// against the canvas the store holds; they go out as one act, shown in the
// store at once, with the way back remembered.

// Process-lifetime latch. Signal quit closes it once; there is deliberately no
// reopen API because a later mutation would invalidate the acknowledged final
// durable boundary while main is authorized to destroy the renderer.
let canvasMutationAdmissionOpen = true;
const activeCanvasAuthoringOperations = new Set<Promise<void>>();
// Names we intentionally discarded (delete). Nothing is sent for them until
// clearAbandonedCanvas (open/create of that name).
const abandonedNames = new Set<string>();

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// When main refuses an edit the store is ahead of the canvas: it is read
// again from main.
const readAgain = (name: string): void => {
  void modelStore.reread(name);
};

const settled = (name: string): void => {
  if (authoring.busy() || state$.canvasName.peek() !== name) return;
  if (state$.saveState.peek() === "saving") state$.saveState.set("saved");
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
        // The refused act is not a step anyone can take back.
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

/**
 * The open canvas as it stands, read once from the node store. For a writer
 * that is not one step, which reads, asks the operator, and only then says
 * its commands through `commitCommands`.
 */
export const canvasAsItStands = (): Canvas => modelStore.canvasOf(state$.canvasName.peek());

/**
 * Do one act on the open canvas, said as commands. This is how a writer
 * changes the canvas: `edit` is given the canvas as it stands and answers the
 * commands (model-edits.ts makes them), which go out as one act, undone
 * together unless `remember` is false. Nothing happens on a Remote station,
 * once the window has closed admission for quitting, or for a canvas being
 * removed. A command main refuses shows the refusal line and the canvas is
 * read again.
 *
 * The commands are shown in the node store at once and handed to main; where
 * there is no main (the demo, a unit rig) the store is all there is. A canvas
 * the store does not hold is not edited.
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
  if (!storeHolds(name)) return;
  let commands: ReadonlyArray<Command>;
  try {
    commands = edit(modelStore.canvasOf(name));
  } catch (error) {
    state$.saveState.set("error");
    state$.error.set(`canvas "${name}" did not take that change: ${messageOf(error)}`);
    return;
  }
  sendAct(name, commands, remember);
};

/**
 * The window has just been given a canvas to show: what was selected, focused
 * or being edited belonged to the one before it and is let go. Sends nothing.
 * Undo is kept: it is commands, and belongs to the canvas.
 */
export const showOpenedCanvas = (name = state$.canvasName.peek()): void => {
  if (!canvasMutationAdmissionOpen) return;
  syncHistoryState();
  state$.saveState.set("saved");
  // The actor references read with the canvas are installed by the caller in
  // the same batch; without them the window must fail closed.
  state$.actorRefs.set([]);
  dropWhatLeft(name, true);
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
  node: Node,
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
    selectNode(node.id);
  });
  // One Add of the node, as its factory made it.
  commitCommands((canvas) => added(canvas, [node]));
  const isRegion = node.kind === "region";
  const shouldFocus = options?.focus !== false;
  // A region skips the label editor: its folder paths are the first step.
  const shouldEdit = options?.edit !== false && !isRegion;
  const shouldOpenPaths = isRegion && options?.regionPaths !== false;
  if (!shouldFocus && !shouldEdit && !shouldOpenPaths) return;
  window.setTimeout(() => {
    batch(() => {
      if (shouldFocus) state$.focusNodeId.set(node.id);
      if (shouldEdit) state$.editNodeId.set(node.id);
      if (shouldOpenPaths) state$.regionPathsNodeId.set(node.id);
    });
  }, 0);
};

const turnBack = (direction: "undo" | "redo"): void => {
  if (!canvasMutationAdmissionOpen) return;
  const name = state$.canvasName.peek();
  if (!storeHolds(name) || abandonedNames.has(name)) return;
  // Undo is commands: the store shows the step at once.
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

/** Change a page's URL, keeping its browser binding. */
export const editLink = (id: string, url: string): void => {
  const next = url.trim();
  if (!next) return;
  commitCommands((canvas) => pageEdited(canvas, id, { url: next }));
};

/** Change a page's browser binding, keeping its URL and removal choice. */
export const setPageBinding = (
  id: string,
  input: { readonly profile: string; readonly host: string },
): void => {
  const profile = input.profile.trim();
  const host = input.host.trim();
  if (!profile || !isValidStationHostId(host)) return;
  commitCommands((canvas) => pageEdited(canvas, id, { profile, host }));
};

/** Change the repository a git card reads. */
export const setGitCwd = (id: string, input: string): void => {
  const cwd = input.trim();
  if (!cwd) return;
  commitCommands((canvas) => gitEdited(canvas, id, { cwd }));
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

/** Region spawn defaults, used when a page is created, never a live rebind. */
export const setRegionDefaults = (id: string, defaults: RegionDefaults | undefined): void => {
  const cleaned = stripEmptyRegionDefaults(defaults);
  commitCommands((canvas) => regionEdited(canvas, id, { defaults: cleaned ?? null }));
};

/** Names and references seats inside the region read at launch. */
export const setRegionEnvironment = (id: string, environment: RegionEnvironment | undefined): void => {
  commitCommands((canvas) => regionEdited(canvas, id, { environment: environment ?? null }));
};

// The claim tick runs in the kernel only (kernel/service.ts runClaimTicks,
// pause-gated). The old renderer-side tick wrapper is gone — a canvas-door
// tick would bypass the pause plane.

/** Change a gauge's threshold fields, keeping its host and label. */
export const setNodeWatch = (
  id: string,
  watch: Pick<NodeOf<"watcher">, "key" | "stat" | "op" | "value"> | undefined,
): void => {
  commitCommands((canvas) => watcherEdited(canvas, id, {
    key: watch?.key?.trim() || null,
    stat: watch?.stat?.trim() || null,
    op: watch?.op ?? null,
    value: watch?.value ?? null,
  }));
};

/** Change a cron's schedule, or clear it, keeping its host and label. */
export const setNodeTimer = (id: string, timer: Pick<NodeOf<"cron">, "expression"> | undefined): void => {
  const expression = timer?.expression?.trim().replace(/\s+/g, " ");
  commitCommands((canvas) => cronEdited(canvas, id, { expression: expression || null }));
};

// Checklist mutator deleted — work ops live in main (WorkService).

// --- task rules and path: authorial contract + flow mutations -------------
// Work-row ops (promote, transition, board) go through Work IPC channels
// (preload), never as a canvas edit. These four are the authorial side:
// region/board rules and the task-path DAG, all operator-only writes.

/** Collapse an empty claims/rulings bag to `undefined` so the doc stays sparse. */
const stripEmptyRegionContract = (
  contract: RegionContract | undefined,
): RegionContract | undefined => {
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

/** Change the rules and rulings of a region. */
export const setRegionContract = (id: string, contract: RegionContract | undefined): void => {
  if (!TASKS_ENABLED) return;
  const cleaned = stripEmptyRegionContract(contract);
  commitCommands((canvas) => regionEdited(canvas, id, { contract: cleaned ?? null }));
};

/** Change a task board's authorial settings; tasks themselves are separate rows. */
export const setBoardSettings = (id: string, contract: TasksContract | undefined): void => {
  const cleaned = contract && Object.keys(contract).length > 0 ? contract : undefined;
  commitCommands((canvas) => taskBoardEdited(canvas, id, { contract: cleaned ?? null }));
};

/** Pin an answer as a ruling, preserving the region's rules and previous rulings. */
export const pinRuling = (regionId: string, text: string, sourceRequestId?: string): void => {
  const trimmed = text.trim();
  if (!trimmed || !TASKS_ENABLED) return;
  commitCommands((canvas) => {
    const region = canvas.nodes.get(regionId as Node["id"]);
    if (region?.kind !== "region") return [];
    const ruling: Ruling = {
      id: ulid(),
      text: trimmed,
      pinnedAt: new Date().toISOString(),
      ...(sourceRequestId ? { sourceRequestId } : {}),
    };
    return regionEdited(canvas, regionId, {
      contract: { ...region.contract, rulings: [...(region.contract?.rulings ?? []), ruling] },
    });
  });
};
