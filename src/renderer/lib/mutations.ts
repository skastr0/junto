import type {
  CanvasDoc,
  CanvasEdge,
  CanvasNode,
  EtherFlag,
  EtherRegionContract,
  EtherRegionDefaults,
  EtherSheet,
  EtherTimer,
  EtherWatch,
  NodeSide,
  Ruling,
  TasksContract,
  TextNode,
} from "@shared/canvas";
import { resolveBrowserOnDelete } from "@shared/canvas";
import { mergeAuthorialCanvas } from "@shared/authorial-canvas-merge";
import { mergeLocalCanvasWithWorkWrite } from "@shared/work-canvas-merge";
import { stripEmptyRegionDefaults } from "@shared/region-defaults";
import { batch } from "@legendapp/state";
import type { BindingHint, CanvasReadResult } from "@shared/ipc";
import type { ActorRef } from "@shared/work-protocol";
import { formatNodeRef } from "@shared/node-ref";
import { isValidStationHostId } from "@shared/station";
import { ulid } from "ulid";
import {
  flowEdgeRemovalWarnings,
  tasksNodeDeletionWarnings,
} from "./deletion-impact";
import {
  removeEdgesFromSelection,
  removeNodesFromSelection,
  replaceSelection,
  selectNode,
  state$,
} from "./state";

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
  readonly base: CanvasDoc;
  readonly doc: CanvasDoc;
}

// Every scheduled save owns an immutable name+document snapshot. Authority
// revisions are tracked per canvas and supplied as an optimistic write
// boundary; a concurrent commit therefore fails visibly instead of being
// overwritten. One pump serializes local writes so a newer local edit can use
// the revision produced by the prior local write.
let pendingSave: PendingCanvasSave | null = null;
let inFlightSave: {
  readonly name: string;
  readonly request: PendingCanvasSave;
  readonly promise: Promise<void>;
} | null = null;
const revisionsByName = new Map<string, string>();
const authorialBasesByName = new Map<string, CanvasDoc>();
// Process-lifetime latch. Signal quit closes it once; there is deliberately no
// reopen API because a later mutation would invalidate the acknowledged final
// durable boundary while main is authorized to destroy the renderer.
let canvasMutationAdmissionOpen = true;
const activeCanvasAuthoringOperations = new Set<Promise<void>>();
// Names we intentionally discarded (delete). flushSave refuses to write them
// until clearAbandonedCanvas (open/create of that name).
const abandonedNames = new Set<string>();
// A recovery copy is durable but the original could not be re-read. Keep its
// visible draft explicitly blocked until an authoritative load reconciles it.
const blockedConflictNames = new Set<string>();
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

const describeMergeConflicts = (
  conflicts: ReadonlyArray<{
    readonly object: "node" | "edge";
    readonly id: string;
    readonly path: string;
    readonly kind: string;
  }>,
): string => conflicts
  .map((conflict) =>
    `${conflict.object} "${conflict.id}"${conflict.path ? ` ${conflict.path}` : ""} (${conflict.kind})`,
  )
  .join(", ");

const protectOverseerAuthority = (base: CanvasDoc, local: CanvasDoc): CanvasDoc => {
  const merge = mergeAuthorialCanvas(base, local, base);
  if (!merge.ok) {
    throw new Error(`local authorial merge failed: ${describeMergeConflicts(merge.conflicts)}`);
  }
  return roundDoc(merge.doc);
};

const nextRecoveryName = (): string => {
  recoveryNameSequence += 1;
  // Fixed-width prefix keeps the filename safely below common NAME_MAX even
  // when the conflicted source name itself is already near that limit.
  return `recovery-${Date.now().toString(36)}-${recoveryNameSequence.toString(36)}`;
};

// A recovery canvas is a durable draft, not a second live seat. Mint a fresh
// binding for every managed agent and drop occupancy/authority so the copy
// cannot alias the original executable identity or restore a grant.
const detachRecoveryExecutableIdentity = (doc: CanvasDoc): CanvasDoc => ({
  ...doc,
  nodes: doc.nodes.map((node) => {
    const ether = node.ether;
    if (ether?.entity?.kind !== "agent") return node;
    const terminal = ether.terminal;
    if (terminal === undefined) return node;
    const { overseer: _overseer, ...etherWithoutOverseer } = ether;
    const { sessionId: _sessionId, ...terminalWithoutSession } = terminal;
    return {
      ...node,
      ether: {
        ...etherWithoutOverseer,
        terminal: {
          ...terminalWithoutSession,
          bindingId: ulid(),
        },
      },
    };
  }),
});

class AuthorialMergeConflictError extends Error {
  constructor(
    readonly authority: CanvasReadResult,
    conflicts: Parameters<typeof describeMergeConflicts>[0],
  ) {
    super(`authorial merge conflict: ${describeMergeConflicts(conflicts)}`);
  }
}

// Rebase against the exact authorial base the edit started from. Disjoint local
// and external changes merge structurally; overlapping edits fall through to a
// visible recovery canvas instead of silently choosing either side.
const rebaseLocalOverDisk = async (failed: PendingCanvasSave): Promise<void> => {
  const api = window.vellumCommand;
  if (!api) throw new Error("Electron preload bridge is not available.");

  const localRequest = pendingSave?.name === failed.name ? pendingSave : failed;
  const authority = await api.readCanvas(failed.name);
  const merge = mergeAuthorialCanvas(localRequest.base, localRequest.doc, authority.doc);
  if (!merge.ok) {
    throw new AuthorialMergeConflictError(authority, merge.conflicts);
  }
  const merged = roundDoc(merge.doc);
  const written = await api.writeCanvas(failed.name, merged, authority.revision);
  revisionsByName.set(failed.name, written.revision);
  authorialBasesByName.set(failed.name, merged);

  // Drop the conflicted queue entry; re-queue only if a newer pending edit
  // arrived while we rebased. Its delta is itself rebased over the document
  // just written, so a late edit cannot restore an external field.
  if (pendingSave?.name === failed.name) {
    if (pendingSave === localRequest) {
      pendingSave = null;
    } else {
      const lateMerge = mergeAuthorialCanvas(localRequest.doc, pendingSave.doc, merged);
      if (!lateMerge.ok) {
        throw new Error(`late authorial merge conflict: ${describeMergeConflicts(lateMerge.conflicts)}`);
      }
      pendingSave = {
        name: failed.name,
        base: merged,
        doc: roundDoc(lateMerge.doc),
      };
    }
  }

  if (state$.canvasName.peek() === failed.name) {
    const selectedNodeId = state$.selectedNodeId.peek();
    const selectedNodeIds = state$.selectedNodeIds.peek();
    const selectedEdgeId = state$.selectedEdgeId.peek();
    const focusNodeId = state$.focusNodeId.peek();
    const editNodeId = state$.editNodeId.peek();
    state$.doc.set(pendingSave?.name === failed.name ? pendingSave.doc : merged);
    state$.docVersion.set(state$.docVersion.peek() + 1);
    state$.docEpoch.set(state$.docEpoch.peek() + 1);
    replaceSelection({ nodeId: selectedNodeId, nodeIds: selectedNodeIds, edgeId: selectedEdgeId });
    state$.focusNodeId.set(focusNodeId);
    state$.editNodeId.set(editNodeId);
    state$.actorRefs.set([...authority.actorRefs]);
  }

  state$.saveState.set(pendingSave?.name === failed.name ? "saving" : "saved");
  state$.error.set("");
};

// Last resort: keep the external original active and untouched, save the
// freshest local draft under a recovery name, then reconcile the active view
// to known authority without navigating or requesting viewport movement.
const recoverRevisionConflict = async (
  failed: PendingCanvasSave,
  knownAuthority?: CanvasReadResult,
): Promise<void> => {
  const api = window.vellumCommand;
  if (!api) throw new Error("Electron preload bridge is not available.");

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

  let snapshot = pendingSave?.name === failed.name ? pendingSave : failed;
  let recoveryRevision = created.revision;
  while (true) {
    const recoveryDoc = detachRecoveryExecutableIdentity(snapshot.doc);
    const recovered = await api.writeCanvas(created.name, recoveryDoc, recoveryRevision);
    recoveryRevision = recovered.revision;
    revisionsByName.set(created.name, recovered.revision);
    authorialBasesByName.set(created.name, recoveryDoc);
    const newer = pendingSave?.name === failed.name ? pendingSave : undefined;
    if (newer === undefined || newer === snapshot) {
      if (pendingSave === snapshot) pendingSave = null;
      break;
    }
    snapshot = newer;
  }
  abandonedNames.delete(created.name);

  const authority = knownAuthority;
  if (authority !== undefined && state$.canvasName.peek() === failed.name) {
    batch(() => {
      loadDoc(authority.doc, authority.revision, authority.name, {
        preserveValidInteraction: true,
      });
      state$.actorRefs.set([...authority.actorRefs]);
    });
    blockedConflictNames.delete(failed.name);
  } else if (authority === undefined) {
    blockedConflictNames.add(failed.name);
  }

  await api.listCanvases()
    .then((canvases) => state$.canvases.set(canvases))
    .catch(() => undefined);

  state$.saveState.set(authority === undefined ? "error" : "saved");
  state$.error.set(
    authority === undefined
      ? `canvas "${failed.name}" changed concurrently; your local draft was saved as canvas "${created.name}"; reload the original before editing`
      : `canvas "${failed.name}" changed concurrently; current authority was reloaded and your local draft was saved as canvas "${created.name}"`,
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
        await recoverRevisionConflict(
          request,
          rebaseError instanceof AuthorialMergeConflictError
            ? rebaseError.authority
            : undefined,
        );
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
  const api = window.vellumCommand;
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
      authorialBasesByName.set(name, doc);
      if (pendingSave === null && state$.canvasName.peek() === name) {
        state$.saveState.set("saved");
      }
      state$.error.set("");
    } catch (error) {
      await handleSaveFailure(name, request, error);
    }
  })();

  inFlightSave = { name, request, promise: run };
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
  if (state$.canvasName.peek() === name) {
    authorialBasesByName.set(name, roundDoc(state$.doc.peek()));
  }
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
  if (abandonedNames.has(name)) return;
  if (state$.canvasName.peek() !== name) return;

  const local = state$.doc.peek();
  const previousRevision = revisionsByName.get(name);
  const base = authorialBasesByName.get(name);
  const authorialAdvanced = previousRevision !== undefined && previousRevision !== revision;
  const hadPending = hasPendingCanvasChanges(name);
  const pendingBase = pendingSave?.name === name ? pendingSave.base : undefined;
  let merged: CanvasDoc;
  if (authorialAdvanced && base !== undefined) {
    const merge = mergeAuthorialCanvas(base, local, workDoc);
    if (!merge.ok) {
      if (pendingSave?.name !== name) {
        pendingSave = { name, base, doc: roundDoc(local) };
      }
      state$.saveState.set("saving");
      state$.error.set(
        `canvas "${name}" changed concurrently; local edits were preserved (${describeMergeConflicts(merge.conflicts)})`,
      );
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        void flushPendingCanvasSave().catch(() => undefined);
      }, 500);
      return;
    }
    merged = roundDoc(merge.doc);
  } else {
    merged = roundDoc(mergeLocalCanvasWithWorkWrite(local, workDoc));
  }
  revisionsByName.set(name, revision);
  authorialBasesByName.set(name, roundDoc(workDoc));

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
  replaceSelection({ nodeId: selectedNodeId, nodeIds: selectedNodeIds, edgeId: selectedEdgeId });
  state$.focusNodeId.set(focusNodeId);
  state$.editNodeId.set(editNodeId);
  state$.error.set("");

  if (authorialAdvanced) {
    past.length = 0;
    future.length = 0;
  } else {
    for (let index = 0; index < past.length; index += 1) {
      past[index] = roundDoc(mergeLocalCanvasWithWorkWrite(past[index]!, workDoc));
    }
    for (let index = 0; index < future.length; index += 1) {
      future[index] = roundDoc(mergeLocalCanvasWithWorkWrite(future[index]!, workDoc));
    }
  }
  syncHistoryState();

  const freeformStillPending =
    hadPending || JSON.stringify(merged) !== JSON.stringify(roundDoc(workDoc));
  if (freeformStillPending) {
    pendingSave = {
      name,
      base: authorialAdvanced ? roundDoc(workDoc) : (pendingBase ?? base ?? roundDoc(workDoc)),
      doc: merged,
    };
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
  const name = state$.canvasName.peek();
  if (blockedConflictNames.has(name)) {
    state$.saveState.set("error");
    state$.error.set(`reload canvas "${name}" before editing after its recovery copy`);
    return;
  }
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
  if (!name || !window.vellumCommand || abandonedNames.has(name)) return;
  if (blockedConflictNames.has(name)) {
    state$.saveState.set("error");
    state$.error.set(`reload canvas "${name}" before editing after its recovery copy`);
    return;
  }
  const base =
    (pendingSave?.name === name ? pendingSave.base : undefined)
    ?? (inFlightSave?.name === name ? inFlightSave.request.doc : undefined)
    ?? authorialBasesByName.get(name)
    ?? roundDoc(state$.doc.peek());
  pendingSave = {
    name,
    base,
    doc: protectOverseerAuthority(base, state$.doc.peek()),
  };
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
  authorialBasesByName.delete(name);
  blockedConflictNames.delete(name);
};

// After a successful open/create of `name`, allow saves again.
export const clearAbandonedCanvas = (name: string): void => {
  abandonedNames.delete(name);
};

/** Replace the open canvas's compiled execution-reference projection. */
export const replaceActiveActorRefs = (
  actorRefs: ReadonlyArray<ActorRef>,
): void => {
  state$.actorRefs.set([...actorRefs]);
};

// Commit a new document. `structural` bumps docVersion so React Flow rebuilds;
// pass false for pure position writes RF already reflects (drag stop).
export const commitDoc = (next: CanvasDoc, structural = true, recordHistory = structural): void => {
  if (state$.settings.station.role.peek() === "remote") {
    return;
  }
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

export interface LoadDocOptions {
  /**
   * Same-canvas projections retain interaction state only while its referenced
   * node or edge still exists. Canvas navigation keeps the reset default.
   */
  readonly preserveValidInteraction?: boolean;
}

// Replace the document from an authoritative source (open / external reload).
// Always structural; never triggers a save (it mirrors what's already committed).
export const loadDoc = (
  doc: CanvasDoc,
  revision?: string,
  name = state$.canvasName.peek(),
  options: LoadDocOptions = {},
): void => {
  if (!canvasMutationAdmissionOpen) return;
  if (pendingSave?.name === name) pendingSave = null;
  if (saveTimer && pendingSave === null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (revision === undefined) revisionsByName.delete(name);
  else revisionsByName.set(name, revision);
  if (revision === undefined) authorialBasesByName.delete(name);
  else authorialBasesByName.set(name, roundDoc(doc));
  blockedConflictNames.delete(name);
  past.length = 0;
  future.length = 0;
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
  // `loadDoc` without a corresponding CanvasReadResult must fail closed.
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
  node: CanvasNode,
  options?: {
    readonly edit?: boolean;
    readonly focus?: boolean;
    /** Open region folder-paths modal (groups only; default true for groups). */
    readonly regionPaths?: boolean;
  },
): void => {
  batch(() => {
    state$.edgeFilter.set("");
    state$.flagFilter.set("");
    // Keep the single/multi selection pair coherent so RTS flag keys target
    // this node only (stale selectedNodeIds would open multi bulk-flags).
    selectNode(node.id);
  });
  const doc = state$.doc.peek();
  commitDoc({ ...doc, nodes: [...doc.nodes, node] });
  const shouldFocus = options?.focus !== false;
  // Groups skip label-edit: paths modal is the first configure step.
  const shouldEdit = options?.edit !== false && node.type !== "group";
  const shouldOpenPaths =
    node.type === "group" && options?.regionPaths !== false;
  if (!shouldFocus && !shouldEdit && !shouldOpenPaths) return;
  window.setTimeout(() => {
    batch(() => {
      if (shouldFocus) state$.focusNodeId.set(node.id);
      if (shouldEdit) state$.editNodeId.set(node.id);
      if (shouldOpenPaths) state$.regionPathsNodeId.set(node.id);
    });
  }, 0);
};

export const undo = (): void => {
  if (!canvasMutationAdmissionOpen) return;
  const previous = past.pop();
  if (!previous) return;
  future.push(state$.doc.peek());
  state$.editNodeId.set("");
  state$.regionPathsNodeId.set("");
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
  state$.regionPathsNodeId.set("");
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
  const removedEdges = doc.edges.filter(
    (edge) => removed.has(edge.fromNode) || removed.has(edge.toNode),
  );
  const nodeLabel = existingNodes.length === 1 ? "this node" : `${existingNodes.length} nodes`;
  const relationLabel = connectedEdges === 0 ? "" : ` Connected edges (${connectedEdges}) will also be removed.`;
  const impactWarnings = [
    ...tasksNodeDeletionWarnings(doc, removed),
    ...flowEdgeRemovalWarnings(doc, removedEdges, removed),
  ];
  const impactCopy =
    impactWarnings.length === 0 ? "" : `\n${impactWarnings.join("\n")}`;
  if (
    confirmedPageStops === undefined &&
    !confirmDestructive(`Delete ${nodeLabel}?${impactCopy}${relationLabel}`)
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

  const sideEffects: Array<Promise<void>> = [];

  // Agent delete: Main-owned lease locks keys, admits chatOpen tombstones,
  // and awaits verified close BEFORE document mutation. Finish releases the
  // fence after commit or abort (TTL is the backstop).
  const agentNodes = existingNodes.filter(
    (n) => n.ether?.entity?.kind === "agent",
  );
  const agentKeys = agentNodes
    .map((n) => n.ether?.entity?.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  // Managed terminal authority is the exact (host, binding) pair, never the
  // agent key. Two cards may temporarily share an agent key while still owning
  // distinct seats, and duplicate references to one seat must stop it once.
  const managedTerminalBindings = new Map<
    string,
    { readonly bindingId: string; readonly hostId: string }
  >();
  for (const node of agentNodes) {
    const bindingId = node.ether?.terminal?.bindingId?.trim();
    if (!bindingId) continue;
    const authoredHost =
      typeof node.ether?.host === "string" ? node.ether.host.trim() : "";
    const hostId = authoredHost || "local";
    managedTerminalBindings.set(`${hostId}\0${bindingId}`, { bindingId, hostId });
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
      const finish = window.vellumCommand?.terminalFinishNodeDelete;
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
      window.vellumCommand?.terminalBeginNodeDelete;
    if (typeof beginTerminalDelete !== "function") {
      await finishDeleteLeases("aborted");
      if (canvasMutationAdmissionOpen) {
        state$.error.set(
          "Vellum Command could not fence the managed terminal; the agent node was not deleted.",
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
            ? "Vellum Command could not stop the managed terminal cleanly; the agent node was not deleted."
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
            ? "Vellum Command could not stop the managed terminal cleanly; the agent node was not deleted."
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
  // Re-read doc only if still on the same canvas epoch; filter from the
  // capture used for identity checks (same epoch ⇒ same doc generation).
  const liveDoc = state$.doc.peek();
  removeEdgesFromSelection(new Set(
    liveDoc.edges
      .filter((edge) => doomed.has(edge.fromNode) || doomed.has(edge.toNode))
      .map((edge) => edge.id),
  ));
  commitDoc({
    nodes: liveDoc.nodes.filter((n) => !doomed.has(n.id)),
    edges: liveDoc.edges.filter((e) => !doomed.has(e.fromNode) && !doomed.has(e.toNode)),
  });
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

export const editText = (id: string, text: string): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => (n.id === id && n.type === "text" ? { ...n, text } : n)),
  });
};

/** Persist a Tasks node rename as its projection-safe authored name. */
export const renameTasksNode = (id: string, firstLine: string): void => {
  const next = firstLine.trim();
  if (!next) return;
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((node) => {
      if (
        node.id !== id ||
        node.type !== "text" ||
        node.ether?.entity?.kind !== "task"
      ) return node;
      const rest = node.text.split("\n").slice(1).join("\n");
      return {
        ...node,
        text: rest ? `${next}\n${rest}` : next,
        ether: {
          ...node.ether,
          tasks: {
            items: node.ether.tasks?.items ?? [],
            ...(node.ether.tasks ?? {}),
            name: next,
          },
        },
      };
    }),
  });
};

/**
 * Authorial display label on ether.terminal. Kept in lockstep with the first
 * line of node.text when the operator renames a terminal/agent card.
 * Does not touch entity.name (identity key — never rewritten by label edits).
 */
export const setTerminalLabel = (id: string, label: string): void => {
  const next = label.trim();
  if (!next) return;
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.id !== id || n.type !== "text" || !n.ether?.terminal) return n;
      return {
        ...n,
        ether: {
          ...n.ether,
          terminal: {
            ...n.ether.terminal,
            label: next,
          },
        },
      };
    }),
  });
};

/**
 * Replace an agent node's harness seat (new bindingId + launch) in one commit.
 * Caller kills the previous process and may reopen the surface.
 */
export const applyManagedAgentReseat = (next: TextNode): void => {
  if (next.ether?.entity?.kind !== "agent") return;
  const doc = state$.doc.peek();
  if (!doc.nodes.some((n) => n.id === next.id)) return;
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => (n.id === next.id ? next : n)),
  });
};

/**
 * First-line rename for terminal/agent cards: updates node.text first line and
 * ether.terminal.label in one commit so display never reverts to a stale spawn label.
 */
export const renameTerminalNode = (id: string, firstLine: string): void => {
  const next = firstLine.trim();
  if (!next) return;
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.id !== id || n.type !== "text") return n;
      const rest = n.text.split("\n").slice(1).join("\n");
      const text = rest ? `${next}\n${rest}` : next;
      if (!n.ether?.terminal) return { ...n, text };
      return {
        ...n,
        text,
        ether: {
          ...n.ether,
          terminal: {
            ...n.ether.terminal,
            label: next,
          },
        },
      };
    }),
  });
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


export const setNodeColor = (id: string, color?: string): void => {
  setNodeColorForNodes([id], color);
};

/** Bulk accent color for multi-select — one commit, not N toggles. */
export const setNodeColorForNodes = (
  ids: ReadonlyArray<string>,
  color?: string,
): void => {
  const targets = new Set(ids);
  if (targets.size === 0) return;
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (!targets.has(n.id)) return n;
      return (color ? { ...n, color } : without(n, "color")) as CanvasNode;
    }),
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
// `mode: "clear"` removes one flag from every target (multi toggle-off).
export const setFlagForNodes = (
  ids: ReadonlyArray<string>,
  flag: EtherFlag | null,
  mode: "set" | "clear" = "set",
): void => {
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
      if (mode === "clear") {
        if (!flags.includes(flag)) return n;
        const nextFlags = flags.filter((f) => f !== flag);
        if (nextFlags.length) {
          return { ...n, ether: { ...(n.ether ?? {}), flags: nextFlags } };
        }
        if (!n.ether) return n;
        const nextEther = without(n.ether, "flags");
        return (Object.keys(nextEther).length ? { ...n, ether: nextEther } : without(n, "ether")) as CanvasNode;
      }
      if (flags.includes(flag)) return n;
      return { ...n, ether: { ...(n.ether ?? {}), flags: [...flags, flag] } };
    }),
  });
};

// Region hold toggle (group nodes only). Follows the toggleFlag strip
// pattern: `hold: true` writes ether.region, anything else strips the
// `region` key entirely and degrades `ether` itself away once nothing else
// is left. Membership is never written here — it stays derived (geometry.ts).
// Merges into ether.region rather than replacing it — region briefing
// (`instruction`) and defaults must survive toggling hold.
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

/**
 * Operator-authored region rules: statements the work must satisfy
 * (stacked outer -> inner across the region stack) and pinned rulings
 * (escalation precedents). Group nodes only —
 * seats have no authorial write path to this contract.
 */
const remintSheetCard = (): void => {
  state$.docVersion.set(state$.docVersion.peek() + 1);
  state$.docEpoch.set(state$.docEpoch.peek() + 1);
};

const applyNodeSheet = (
  id: string,
  sheet: EtherSheet,
  options: { readonly structural: boolean; readonly recordHistory: boolean },
): void => {
  const doc = state$.doc.peek();
  const current = doc.nodes.find((n) => n.id === id);
  if (current?.ether?.sheet === sheet) {
    // Typing already wrote this object without reminting React Flow. A later
    // structural flush still has to bump docVersion so the card face catches up.
    if (options.structural) remintSheetCard();
    return;
  }
  commitDoc(
    {
      ...doc,
      nodes: doc.nodes.map((n) => {
        if (n.id !== id) return n;
        return { ...n, ether: { ...(n.ether ?? {}), sheet } };
      }),
    },
    options.structural,
    options.recordHistory,
  );
};

/**
 * Write a sheet's grid onto its node. The sheet is authored content, so this is
 * an ordinary canvas commit — no work-plane round trip, and the agent path
 * (sheet.read) has no counterpart that lands here.
 *
 * Keystroke bursts share one undo step and do not remint React Flow (the
 * overlay holds a local draft). Row/column edits and closing the editor
 * remint once so the card face matches. Quitting still flushes through
 * `registerCanvasDraftCommit`.
 */
export const setNodeSheet = (id: string, sheet: EtherSheet): void => {
  applyNodeSheet(id, sheet, { structural: true, recordHistory: true });
};

const sheetTypingBurst = new Map<string, ReturnType<typeof setTimeout>>();
const SHEET_TYPING_BURST_MS = 400;

export const setNodeSheetTyping = (id: string, sheet: EtherSheet): void => {
  const recordHistory = !sheetTypingBurst.has(id);
  const previous = sheetTypingBurst.get(id);
  if (previous !== undefined) clearTimeout(previous);
  sheetTypingBurst.set(
    id,
    setTimeout(() => {
      sheetTypingBurst.delete(id);
    }, SHEET_TYPING_BURST_MS),
  );
  applyNodeSheet(id, sheet, { structural: false, recordHistory });
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
  if (!trimmed) return;
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
