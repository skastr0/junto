import type {
  CanvasDoc,
  CanvasNode,
  EtherFlag,
  EtherRegionDefaults,
  EtherTimer,
  EtherView,
  EtherWatch,
  NodeSide,
} from "@shared/canvas";
import { resolveBrowserOnDelete } from "@shared/canvas";
import { mergeLocalCanvasWithWorkWrite } from "@shared/work-canvas-merge";
import { stripEmptyRegionDefaults } from "@shared/region-defaults";
import { batch } from "@legendapp/state";
import type { BindingHint } from "@shared/ipc";
import { formatNodeRef } from "@shared/node-ref";
import { DEFAULT_STATION_HOST_ID, isValidStationHostId } from "@shared/station";
import { state$ } from "./state";

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
interface PendingCanvasSave {
  readonly name: string;
  readonly doc: CanvasDoc;
}

// Every scheduled save owns an immutable name+document snapshot. Authority
// revisions are tracked per canvas and supplied as an optimistic write
// boundary; a concurrent commit therefore fails visibly instead of being
// overwritten. One pump serializes local writes so a newer local edit can use
// the revision produced by the prior local write.
let pendingSave: PendingCanvasSave | null = null;
let inFlightSave: { readonly name: string; readonly promise: Promise<void> } | null = null;
const revisionsByName = new Map<string, string>();
// Process-lifetime latch. Signal quit closes it once; there is deliberately no
// reopen API because a later mutation would invalidate the acknowledged final
// durable boundary while main is authorized to destroy the renderer.
let canvasMutationAdmissionOpen = true;
const activeCanvasAuthoringOperations = new Set<Promise<void>>();
// Names we intentionally discarded (delete). flushSave refuses to write them
// until clearAbandonedCanvas (open/create of that name).
const abandonedNames = new Set<string>();
const REVISION_CONFLICT_MARKER = "revision conflict; reload before saving";
const MAX_RECOVERY_NAME_ATTEMPTS = 32;
let recoveryNameSequence = 0;

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

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isRevisionConflict = (error: unknown): boolean =>
  messageOf(error).includes(REVISION_CONFLICT_MARKER);

const nextRecoveryName = (): string => {
  recoveryNameSequence += 1;
  // Fixed-width prefix keeps the filename safely below common NAME_MAX even
  // when the conflicted source name itself is already near that limit.
  return `recovery-${Date.now().toString(36)}-${recoveryNameSequence.toString(36)}`;
};

// Prefer rebase when authority advanced under a local save (work ops, kernel
// mirrors, external edits that share node ids): keep freeform local geometry
// and graph membership, take work stores from authority, write at its revision.
// Falls through to recovery-canvas only when rebase cannot complete.
const rebaseLocalOverDisk = async (failed: PendingCanvasSave): Promise<void> => {
  const api = window.vellum;
  if (!api) throw new Error("Electron preload bridge is not available.");

  const localSnapshot =
    pendingSave?.name === failed.name ? pendingSave.doc : failed.doc;
  const authority = await api.readCanvas(failed.name);
  const merged = roundDoc(mergeLocalCanvasWithWorkWrite(localSnapshot, authority.doc));
  const written = await api.writeCanvas(failed.name, merged, authority.revision);
  revisionsByName.set(failed.name, written.revision);

  // Drop the conflicted queue entry; re-queue only if a newer pending edit
  // arrived while we rebased (same name, different snapshot).
  if (pendingSave?.name === failed.name) {
    if (pendingSave.doc === localSnapshot) {
      pendingSave = null;
    } else {
      pendingSave = {
        name: failed.name,
        doc: roundDoc(mergeLocalCanvasWithWorkWrite(pendingSave.doc, authority.doc)),
      };
    }
  }

  if (state$.canvasName.peek() === failed.name) {
    const selectedNodeId = state$.selectedNodeId.peek();
    const selectedNodeIds = state$.selectedNodeIds.peek();
    const selectedEdgeId = state$.selectedEdgeId.peek();
    const focusNodeId = state$.focusNodeId.peek();
    const editNodeId = state$.editNodeId.peek();
    state$.doc.set(merged);
    state$.docVersion.set(state$.docVersion.peek() + 1);
    state$.docEpoch.set(state$.docEpoch.peek() + 1);
    state$.selectedNodeId.set(selectedNodeId);
    state$.selectedNodeIds.set(selectedNodeIds);
    state$.selectedEdgeId.set(selectedEdgeId);
    state$.focusNodeId.set(focusNodeId);
    state$.editNodeId.set(editNodeId);
  }

  state$.saveState.set(pendingSave?.name === failed.name ? "saving" : "saved");
  state$.error.set("");
};

// Last resort: keep the external original untouched and make the newest local
// snapshot durable under a new canvas name.
const recoverRevisionConflict = async (failed: PendingCanvasSave): Promise<void> => {
  const api = window.vellum;
  if (!api) throw new Error("Electron preload bridge is not available.");

  const snapshot = pendingSave?.name === failed.name ? pendingSave : failed;
  let created: Awaited<ReturnType<typeof api.createCanvas>> | undefined;

  for (let attempt = 0; attempt < MAX_RECOVERY_NAME_ATTEMPTS; attempt += 1) {
    const candidate = nextRecoveryName();
    try {
      created = await api.createCanvas(candidate);
      break;
    } catch (error) {
      if (!messageOf(error).includes("already exists")) throw error;
    }
  }
  if (!created) throw new Error(`could not allocate a recovery canvas for "${failed.name}"`);

  const recovered = await api.writeCanvas(created.name, snapshot.doc, created.revision);
  revisionsByName.set(created.name, recovered.revision);
  abandonedNames.delete(created.name);

  if (pendingSave?.name === failed.name) {
    pendingSave = pendingSave === snapshot
      ? null
      : { name: created.name, doc: pendingSave.doc };
  }

  if (state$.canvasName.peek() === failed.name) {
    state$.canvasName.set(created.name);
  }

  await api.listCanvases()
    .then((canvases) => state$.canvases.set(canvases))
    .catch(() => undefined);

  state$.saveState.set(pendingSave?.name === created.name ? "saving" : "saved");
  state$.error.set(
    `canvas "${failed.name}" changed concurrently; that revision was preserved and your local edit was saved as canvas "${created.name}"`,
  );
};

const handleSaveFailure = async (
  name: string,
  request: PendingCanvasSave,
  error: unknown,
): Promise<void> => {
  if (abandonedNames.has(name)) {
    state$.saveState.set("saved");
    return;
  }

  let failure = error;
  if (isRevisionConflict(error)) {
    try {
      await rebaseLocalOverDisk(request);
      return;
    } catch (rebaseError) {
      try {
        await recoverRevisionConflict(request);
        return;
      } catch (recoveryError) {
        failure = new Error(
          `${messageOf(error)}; rebase failed: ${messageOf(rebaseError)}; recovery copy failed: ${messageOf(recoveryError)}`,
        );
      }
    }
  }

  // Keep the newest local snapshot retryable. If no newer request exists,
  // restore the exact request that failed its optimistic authority boundary.
  if (pendingSave === null || pendingSave.name !== name) pendingSave = request;
  state$.saveState.set("error");
  state$.error.set(messageOf(failure));
  throw failure;
};

const runSave = async (request: PendingCanvasSave): Promise<void> => {
  const { name, doc } = request;
  const api = window.vellum;
  if (!api) throw new Error("Electron preload bridge is not available.");
  if (abandonedNames.has(name)) return;

  const run = (async () => {
    state$.saveState.set("saving");
    // Re-check immediately before IPC: prepareCanvasRemoval may have abandoned
    // this name after the request entered the pump.
    if (abandonedNames.has(name)) {
      state$.saveState.set("saved");
      return;
    }
    try {
      const result = await api.writeCanvas(name, doc, revisionsByName.get(name));
      if (abandonedNames.has(name)) {
        // Write may have recreated a just-deleted file; the removal path
        // awaits this promise then deletes, so delete still wins in authority.
        state$.saveState.set("saved");
        return;
      }
      revisionsByName.set(name, result.revision);
      if (pendingSave === null && state$.canvasName.peek() === name) {
        state$.saveState.set("saved");
      }
      state$.error.set("");
    } catch (error) {
      await handleSaveFailure(name, request, error);
    }
  })();

  inFlightSave = { name, promise: run };
  try {
    await run;
  } finally {
    if (inFlightSave?.promise === run) inFlightSave = null;
  }
};

/** Flushes every locally queued canvas snapshot before navigation or close. */
export const flushPendingCanvasSave = async (): Promise<void> => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  while (true) {
    if (inFlightSave) {
      await inFlightSave.promise;
      continue;
    }
    const request = pendingSave;
    if (request === null) return;
    pendingSave = null;
    await runSave(request);
  }
};

export const hasPendingCanvasChanges = (name: string): boolean =>
  pendingSave?.name === name || inFlightSave?.name === name;

export const getCanvasRevision = (name: string): string | undefined =>
  revisionsByName.get(name);

export const acceptCanvasRevision = (name: string, revision: string): void => {
  revisionsByName.set(name, revision);
};

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

/**
 * Apply a successful WorkService write into the open renderer document.
 * Baselines `revisionsByName` at the work revision so a concurrent freeform
 * flush cannot treat the work write as a foreign conflict (recovery canvas).
 * Freeform geometry / edges stay local; stores + mirrored text come from
 * `workDoc`.
 */
export const applyWorkCanvasWrite = (
  name: string,
  workDoc: CanvasDoc,
  revision: string,
): void => {
  if (!canvasMutationAdmissionOpen) return;
  revisionsByName.set(name, revision);
  if (abandonedNames.has(name)) return;
  if (state$.canvasName.peek() !== name) return;

  const local = state$.doc.peek();
  const hadPending = hasPendingCanvasChanges(name);
  const merged = roundDoc(mergeLocalCanvasWithWorkWrite(local, workDoc));

  // Drop any stale pending snapshot baselined at the pre-work revision —
  // we'll re-queue a merge at the new baseline if freeform still differs.
  if (pendingSave?.name === name) pendingSave = null;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  const selectedNodeId = state$.selectedNodeId.peek();
  const selectedNodeIds = state$.selectedNodeIds.peek();
  const selectedEdgeId = state$.selectedEdgeId.peek();
  const focusNodeId = state$.focusNodeId.peek();
  const editNodeId = state$.editNodeId.peek();

  state$.doc.set(merged);
  state$.docVersion.set(state$.docVersion.peek() + 1);
  state$.docEpoch.set(state$.docEpoch.peek() + 1);
  state$.selectedNodeId.set(selectedNodeId);
  state$.selectedNodeIds.set(selectedNodeIds);
  state$.selectedEdgeId.set(selectedEdgeId);
  state$.focusNodeId.set(focusNodeId);
  state$.editNodeId.set(editNodeId);
  state$.error.set("");

  const freeformStillPending =
    hadPending || JSON.stringify(merged) !== JSON.stringify(roundDoc(workDoc));
  if (freeformStillPending) {
    pendingSave = { name, doc: merged };
    state$.saveState.set("saving");
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flushPendingCanvasSave().catch(() => undefined);
    }, 500);
  } else {
    state$.saveState.set("saved");
  }
};

export const retrySave = (): void => {
  if (!canvasMutationAdmissionOpen) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  state$.error.set("");
  void flushPendingCanvasSave().catch(() => undefined);
};

export const scheduleSave = (): void => {
  if (!canvasMutationAdmissionOpen) return;
  if (saveTimer) clearTimeout(saveTimer);
  const name = state$.canvasName.peek();
  if (!name || !window.vellum || abandonedNames.has(name)) return;
  pendingSave = { name, doc: roundDoc(state$.doc.peek()) };
  state$.saveState.set("saving");
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushPendingCanvasSave().catch(() => undefined);
  }, 500);
};

// Call before deleting a canvas: drop the debounced save, mark the name
// abandoned so no further write lands for it, stamp lastWriteAt so the
// delete's own canvasChanged notify is ignored, and wait out any in-flight
// write so remove() can run after (delete wins if write already recreated).
export const prepareCanvasRemoval = async (name: string): Promise<void> => {
  if (saveTimer && pendingSave?.name === name) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  abandonedNames.add(name);
  if (pendingSave?.name === name) pendingSave = null;
  state$.saveState.set("saved");
  if (inFlightSave?.name === name) await inFlightSave.promise.catch(() => undefined);
  if (pendingSave?.name === name) pendingSave = null;
  revisionsByName.delete(name);
};

// After a successful open/create of `name`, allow saves again.
export const clearAbandonedCanvas = (name: string): void => {
  abandonedNames.delete(name);
};

// Commit a new document. `structural` bumps docVersion so React Flow rebuilds;
// pass false for pure position writes RF already reflects (drag stop).
export const commitDoc = (next: CanvasDoc, structural = true, recordHistory = structural): void => {
  if (!canvasMutationAdmissionOpen) return;
  if (recordHistory) {
    past.push(state$.doc.peek());
    future.length = 0;
    syncHistoryState();
  }
  state$.doc.set(next);
  if (structural) state$.docVersion.set(state$.docVersion.peek() + 1);
  // Position-only writes still change geometric region membership — the RTS
  // bar re-polls on docEpoch without forcing a React Flow graph rebuild.
  state$.docEpoch.set(state$.docEpoch.peek() + 1);
  scheduleSave();
};

// Replace the document from an authoritative source (open / external reload).
// Always structural; never triggers a save (it mirrors what's already committed).
export const loadDoc = (doc: CanvasDoc, revision?: string, name = state$.canvasName.peek()): void => {
  if (!canvasMutationAdmissionOpen) return;
  if (pendingSave?.name === name) pendingSave = null;
  if (saveTimer && pendingSave === null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (revision === undefined) revisionsByName.delete(name);
  else revisionsByName.set(name, revision);
  past.length = 0;
  future.length = 0;
  state$.editNodeId.set("");
  state$.selectedNodeId.set("");
  state$.selectedNodeIds.set([]);
  state$.selectedEdgeId.set("");
  state$.focusNodeId.set("");
  syncHistoryState();
  state$.saveState.set("saved");
  state$.doc.set(doc);
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
export const addNode = (node: CanvasNode, options?: { readonly edit?: boolean; readonly focus?: boolean }): void => {
  batch(() => {
    state$.searchQuery.set("");
    state$.edgeFilter.set("");
    state$.flagFilter.set("");
    state$.selectedNodeId.set(node.id);
    state$.selectedEdgeId.set("");
  });
  const doc = state$.doc.peek();
  commitDoc({ ...doc, nodes: [...doc.nodes, node] });
  if (options?.focus === false) return;
  window.setTimeout(() => {
    batch(() => {
      state$.focusNodeId.set(node.id);
      if (options?.edit !== false) state$.editNodeId.set(node.id);
    });
  }, 0);
};

export const undo = (): void => {
  if (!canvasMutationAdmissionOpen) return;
  const previous = past.pop();
  if (!previous) return;
  future.push(state$.doc.peek());
  state$.editNodeId.set("");
  state$.doc.set(previous);
  state$.docVersion.set(state$.docVersion.peek() + 1);
  // Generation fence for async delete/teardown continuations (same as commitDoc).
  state$.docEpoch.set(state$.docEpoch.peek() + 1);
  syncHistoryState();
  scheduleSave();
};

export const redo = (): void => {
  if (!canvasMutationAdmissionOpen) return;
  const next = future.pop();
  if (!next) return;
  past.push(state$.doc.peek());
  state$.editNodeId.set("");
  state$.doc.set(next);
  state$.docVersion.set(state$.docVersion.peek() + 1);
  state$.docEpoch.set(state$.docEpoch.peek() + 1);
  syncHistoryState();
  scheduleSave();
};

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
  const doc = state$.doc.peek();
  const existingNodes = doc.nodes.filter((node) => removed.has(node.id));
  if (existingNodes.length === 0) return;
  const connectedEdges = doc.edges.filter((edge) => removed.has(edge.fromNode) || removed.has(edge.toNode)).length;
  const nodeLabel = existingNodes.length === 1 ? "this node" : `${existingNodes.length} nodes`;
  const relationLabel = connectedEdges === 0 ? "" : ` Connected edges (${connectedEdges}) will also be removed.`;
  if (
    confirmedPageStops === undefined &&
    !confirmDestructive(`Delete ${nodeLabel}?${relationLabel}`)
  ) return;

  // Page nodes follow their explicit document policy. Default is kill-session
  // (Phase 5: page delete closes the owned session). Detach remains available
  // when the operator authorial field says so.
  const pageActions: Array<{ readonly ref: string; readonly stop: boolean }> = [];
  for (const node of existingNodes) {
    if (node.ether?.entity?.kind !== "page") continue;
    try {
      pageActions.push({
        ref: formatNodeRef({ canvasName, nodeId: node.id }),
        stop: resolveBrowserOnDelete(node.ether.browser) === "kill-session",
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

  // Herdr default is detach-only (never session stop). Kill-pane onDelete
  // is handled async without blocking other non-herdr deletions.
  const herdrIds = existingNodes
    .filter((n) => n.ether?.entity?.kind === "herdr")
    .map((n) => n.id);
  const sideEffects: Array<Promise<void>> = [];
  if (herdrIds.length > 0) {
    sideEffects.push(
      import("./herdr-actions").then(async ({ handleHerdrNodeDelete }) => {
        if (!canvasMutationAdmissionOpen) return;
        await Promise.all(herdrIds.map((id) => handleHerdrNodeDelete(id)));
      }),
    );
  }

  // Agent delete: Main-owned lease locks keys, admits chatOpen tombstones,
  // and awaits verified close BEFORE document mutation. Finish releases the
  // fence after commit or abort (TTL is the backstop).
  const agentNodes = existingNodes.filter(
    (n) => n.ether?.entity?.kind === "agent",
  );
  const agentKeys = agentNodes
    .map((n) => n.ether?.entity?.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  let deleteLeaseId: string | undefined;
  const finishDeleteLease = async (
    outcome: "committed" | "aborted",
  ): Promise<void> => {
    if (deleteLeaseId === undefined) return;
    const leaseId = deleteLeaseId;
    deleteLeaseId = undefined;
    const { finishAgentNodeDelete } = await import("./chat-state");
    await finishAgentNodeDelete(leaseId, outcome);
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
    deleteLeaseId = began.leaseId;
    if (!canvasMutationAdmissionOpen) {
      await finishDeleteLease("aborted");
      return;
    }
    if (!began.closeResults.every((result) => result.ok)) {
      await finishDeleteLease("aborted");
      state$.error.set(
        "Agent session teardown failed or was unclean; the agent node was not deleted.",
      );
      return;
    }
  }

  // After any await (page stop / agent close), the operator may have switched
  // canvases. Re-check identity before mutating — never write canvas A's
  // filtered document over canvas B via commitDoc → scheduleSave.
  if (
    state$.canvasName.peek() !== canvasName ||
    state$.docEpoch.peek() !== docEpoch
  ) {
    await finishDeleteLease("aborted");
    state$.error.set(
      "Canvas changed before deletion completed; no nodes were deleted.",
    );
    return;
  }
  if (!canvasMutationAdmissionOpen) {
    await finishDeleteLease("aborted");
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

  const nonHerdr = new Set(
    existingNodes.filter((n) => n.ether?.entity?.kind !== "herdr").map((n) => n.id),
  );
  if (nonHerdr.size === 0) {
    // Pure herdr delete — async path owns the doc mutation.
    if (herdrIds.some((id) => id === state$.selectedNodeId.peek())) state$.selectedNodeId.set("");
    await finishDeleteLease("aborted");
    await Promise.all(sideEffects);
    return;
  }
  // Re-read doc only if still on the same canvas epoch; filter from the
  // capture used for identity checks (same epoch ⇒ same doc generation).
  const liveDoc = state$.doc.peek();
  if (nonHerdr.has(state$.selectedNodeId.peek())) state$.selectedNodeId.set("");
  if (removed.has(state$.selectedEdgeId.peek())) state$.selectedEdgeId.set("");
  commitDoc({
    nodes: liveDoc.nodes.filter((n) => !nonHerdr.has(n.id)),
    edges: liveDoc.edges.filter((e) => !nonHerdr.has(e.fromNode) && !nonHerdr.has(e.toNode)),
  });
  // Release only after the document commit so reopen cannot race the card.
  await finishDeleteLease("committed");
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

// Promote a plain link node in place into a bound browser page work surface —
// stamps entity.kind "page" + ether.browser onto the EXISTING node.id (never
// spawns a new node; the JSON Canvas `link` type never changes). Product
// default onDelete is kill-session (Phase 5), matching makePageNode.
export const promoteLinkToPage = (id: string, profile: string): void => {
  const doc = state$.doc.peek();
  const stationHost = state$.settings.station.hostId.peek();
  const fallbackHost = isValidStationHostId(stationHost)
    ? stationHost
    : DEFAULT_STATION_HOST_ID;
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) =>
      n.id === id && n.type === "link"
        ? {
            ...n,
            ether: {
              ...(n.ether ?? {}),
              entity: { kind: "page" },
              host: n.ether?.host ?? fallbackHost,
              browser: { profile, onDelete: "detach" },
            },
          }
        : n,
    ),
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

// Region hold toggle (group nodes only). Follows the toggleFlag strip
// pattern: `hold: true` writes ether.region, anything else strips the
// `region` key entirely and degrades `ether` itself away once nothing else
// is left. Membership is never written here — it stays derived (geometry.ts).
// Merges into ether.region rather than replacing it — a region's pulse
// instruction must survive toggling hold.
export const setRegionHold = (id: string, hold: boolean): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.id !== id) return n;
      const currentRegion = n.ether?.region ?? {};
      const nextRegion = hold ? { ...currentRegion, hold: true } : without(currentRegion, "hold");
      if (Object.keys(nextRegion).length > 0) {
        return { ...n, ether: { ...(n.ether ?? {}), region: nextRegion } };
      }
      if (!n.ether) return n;
      const nextEther = without(n.ether, "region");
      return (Object.keys(nextEther).length ? { ...n, ether: nextEther } : without(n, "ether")) as CanvasNode;
    }),
  });
};

// Region spawn defaults (group nodes only). Create-time stamp source for
// herdr/page nodes placed inside the region — never live rebind.
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

// Empty fields never survive into the document: a blank orbit/glyphQuery and
// an empty states array all collapse to "field absent" rather than "field
// present but empty" — one canonical way to say "no slice here".
const stripEmptyView = (view: EtherView): EtherView | undefined => {
  const orbit = view.orbit?.trim();
  const glyphQuery = view.glyphQuery?.trim();
  const states = view.states?.filter((s) => s.trim().length > 0);
  const out: EtherView = {
    ...(orbit ? { orbit } : {}),
    ...(glyphQuery ? { glyphQuery } : {}),
    ...(states && states.length > 0 ? { states } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
};

// Writes/clears a node's ether.view (project slice lens). Follows the
// toggleFlag pattern: strip empty fields, drop the `view` key entirely once
// every field is empty, and degrade `ether` itself away when it would
// otherwise be left holding nothing.
export const setNodeView = (id: string, view: EtherView | undefined): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.id !== id) return n;
      const cleaned = view ? stripEmptyView(view) : undefined;
      if (cleaned) {
        return { ...n, ether: { ...(n.ether ?? {}), view: cleaned } };
      }
      if (!n.ether) return n;
      const nextEther = without(n.ether, "view");
      return (Object.keys(nextEther).length ? { ...n, ether: nextEther } : without(n, "ether")) as CanvasNode;
    }),
  });
};

/** Operator-assigned claim-routing role (not physics FactoryRole). */
export const setNodeWorkRole = (id: string, workRole: string | undefined): void => {
  const doc = state$.doc.peek();
  const cleaned = workRole?.trim() || undefined;
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.id !== id) return n;
      if (cleaned) {
        return { ...n, ether: { ...(n.ether ?? {}), workRole: cleaned } };
      }
      if (!n.ether) return n;
      const nextEther = without(n.ether, "workRole");
      return (Object.keys(nextEther).length ? { ...n, ether: nextEther } : without(n, "ether")) as CanvasNode;
    }),
  });
};

// The claim tick runs in the kernel only (kernel/service.ts runClaimTicks,
// pause-gated). The old renderer-side tick wrapper is gone — a canvas-door
// tick would bypass the pause plane.

// Watcher/timer definitions are document data (the kernel's runtime state
// derived from them is not — that lives only in kernel-state.ts / app
// memory, per the frozen contract). Empty optional fields never survive:
// blank project/orbit/state/source/key/stat strings and an empty glyphIds
// array all collapse to "field absent", same discipline as stripEmptyView.
const stripEmptyWatch = (watch: EtherWatch): EtherWatch => {
  const project = watch.project?.trim();
  const orbit = watch.orbit?.trim();
  const glyphIds = watch.glyphIds?.filter((g) => g.trim().length > 0);
  const state = watch.state?.trim();
  const key = watch.key?.trim();
  const stat = watch.stat?.trim();
  return {
    kind: watch.kind,
    ...(project ? { project } : {}),
    ...(orbit ? { orbit } : {}),
    ...(glyphIds && glyphIds.length > 0 ? { glyphIds } : {}),
    ...(state ? { state } : {}),
    ...(watch.source ? { source: watch.source } : {}),
    ...(key ? { key } : {}),
    ...(stat ? { stat } : {}),
    ...(watch.op ? { op: watch.op } : {}),
    ...(watch.value !== undefined ? { value: watch.value } : {}),
    ...(watch.flagOnUnsatisfied ? { flagOnUnsatisfied: true } : {}),
  };
};

// Writes/clears a node's ether.watch (predicate definition for a watcher
// node). Follows the toggleFlag strip pattern: strip empty fields, drop the
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
      if (timer && Number.isFinite(timer.everyMinutes) && timer.everyMinutes >= MIN_TIMER_EVERY_MINUTES) {
        return { ...n, ether: { ...(n.ether ?? {}), timer: { everyMinutes: Math.round(timer.everyMinutes) } } };
      }
      if (!n.ether) return n;
      const nextEther = without(n.ether, "timer");
      return (Object.keys(nextEther).length ? { ...n, ether: nextEther } : without(n, "ether")) as CanvasNode;
    }),
  });
};

// Checklist mutator deleted — work ops live in main (WorkService).
