import { Context, Effect, Option, Result, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { withSqlRead } from "./state/sql-read";
import type { ServiceCheck } from "@shared/contracts";
import {
  decodeCanvasDoc,
  serializeCanvas,
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
} from "@shared/canvas";
import type {
  CanvasOverseerSetInput,
  CanvasOverseerSetResult,
  CanvasReadResult,
  CanvasSummary,
  CanvasWriteResult,
} from "@shared/ipc";
import {
  isManagedAgentNode,
  nodeSeatBinding,
  reconcileOverseerGrants,
  setBindingOverseer,
} from "@shared/overseer-authoring";
import type { WorkErrorBody } from "@shared/work-control";
import { SEED_CANVAS_NAME } from "@shared/seed";
import {
  StateEngine,
  StateTransactionOperation,
} from "./state/service";
import {
  WorkRepository,
  WorkProjectionReader,
  WorkProjectionReaderLive,
  projectWorkSnapshots,
  type CanvasWorkProjection,
} from "./work/repository";
import { makeWorkWorld, workWorldEnabled, type WorkWorld } from "./work/world";
import {
  compileActorSeatRegistry,
} from "./station/actor-seat-compiler";
import type { ActorRef } from "@shared/work-protocol";
import {
  mirrorArtifactsText,
  mirrorBoardText,
  mirrorRequestsText,
  mirrorTasksText,
  padTitleFromText,
} from "@shared/task";
import {
  removeCanvasProjectionSidecars,
  writeCanvasProjectionSidecar,
} from "./canvas-control/sidecars";
import { withinBudget } from "./observability/main-thread-budget";
import {
  CanvasEntitySync,
} from "./entities/sync";
import {
  CanvasRecords,
  CanvasRecordsLive,
} from "./canvas/records";
import {
  retireEscalatesFromRawDoc,
  retirementTouches,
} from "./canvas/retire-escalates";
import { flagsRetirementTouches, retireFlagsFromRawDoc } from "./canvas/retire-flags";
import {
  BACKFILL_CANVAS_RETIRE_ESCALATES_V1,
  BACKFILL_CANVAS_RETIRE_FLAGS_V1,
} from "./install-ops/schema";
import { InstallOpsService } from "./install-ops/service";
import {
  canvasBodySha256Of,
  intentSha256Of,
  type StoredCanvasIntentDocument,
} from "./canvas-intent-identity";

import {
  CanvasError, canvasNameFrom, canvasLabel, toCanvasError,
  type CanvasName, type StoredCanvas, type StoredAuthoritySnapshot, type ActivePortfolioSnapshot,
} from "./canvas/domain";
export { CanvasError, canvasNameFrom, type CanvasName } from "./canvas/domain";

// The protected document plane. All writes go through validate -> mirror law
// -> one full-map SQLite generation transaction. Digest and SVG projection
// outputs are owned by canvas-control/sidecars.ts and are never durability.

/** previous/next docs on the commit that fired a change listener (same tick). */
export type CanvasChangeDetail = {
  readonly previous: CanvasDoc | undefined;
  readonly next: CanvasDoc | undefined;
};

export type InstalledProjectionCanvasChange = {
  readonly name: string;
  readonly detail: CanvasChangeDetail;
};

/** One transactionally coherent semantic view of the protected document authority. */
export type CanvasAuthoritySnapshot = {
  readonly generation: string;
  readonly intentSha256: string;
  readonly documents: ReadonlyMap<string, CanvasDoc>;
};

export type CanvasAuthorityStoredDocument = StoredCanvasIntentDocument;

/**
 * One transactionally coherent authorial view with the exact stored bytes that
 * produced each semantic document and the portfolio intent identity.
 */
export type CanvasAuthorityMaterialSnapshot = CanvasAuthoritySnapshot & {
  readonly storedDocuments: ReadonlyMap<
    string,
    CanvasAuthorityStoredDocument
  >;
};

export type ActiveIntentWitness = {
  readonly generation: string;
  readonly contentSha256: string;
};

export type CanvasReadWithIntentWitness = {
  readonly read: CanvasReadResult;
  readonly intentWitness: ActiveIntentWitness;
};

/**
 * One authorial node, read WITHOUT building the canvas work projection.
 *
 * Some callers only ask structural questions of a single node, such as which
 * seat it binds to (`deliveryTargetOf`). Such a question reads no work lane,
 * so it may not pay for one: `canvases.read` materializes every sink's tasks, messages,
 * requests, artifacts, board and pad to answer them, which is the entire
 * factory for one `nodes.find`.
 *
 * `structure` is the AUTHORIAL document. `ether.tasks`, `ether.requests`,
 * `ether.messages`, `ether.artifacts`, `ether.board` and `ether.pad` are
 * absent by construction (authorial rows that carry them are rejected at
 * decode). Never read a work lane off it — take `canvases.read` for that.
 */
export type CanvasNodeStructure = {
  readonly name: string;
  readonly node: CanvasNode;
  readonly structure: CanvasDoc;
  readonly revision: string;
};

/**
 * Caller identity for one `canvases.read`. Instrumentation only: a
 * main-thread budget report names this tag so the driver of a block is
 * measured rather than inferred. Closed union so a new call site cannot land
 * untagged.
 */
export type CanvasReadTag =
  | "box.activityPolicy"
  | "browser.readCanvas"
  | "control.list"
  | "control.read"
  // Message delivery, split by call site. One tag per delivery path so the
  // driver of a retry loop is measured rather than inferred — the single
  // `ipc.termStore` tag this replaces could not tell a world scan apart from
  // a per-message re-read.
  | "delivery.attempt"
  | "delivery.batch"
  | "delivery.readStamp"
  | "delivery.requestResponse"
  | "delivery.route"
  | "delivery.scan"
  | "hosts.qualification"
  | "ipc.deliveryAccept"
  | "ipc.exportDigest"
  | "ipc.mergePortfolio"
  | "ipc.readCanvas"
  | "ipc.rendererActor"
  | "ipc.terminalManagedPrompt"
  | "ipc.work.collaboration-ask"
  | "kernel.hydrateDoc"
  | "kernel.resyncDoc"
  | "nodeRef.resolve"
  | "region.rollup"
  | "seatSessions.offboard"
  | "term.seatPlan"
  | "untagged"
  | "overseer.canvas"
  | "work.control"
  | "work.checkoutWatch"
  | "work.seatObservation"
  | "work.service";

export type CanvasPortfolioView = {
  readonly documents: ReadonlyMap<string, CanvasDoc>;
  readonly revisions: ReadonlyMap<string, string>;
};

export type CanvasPortfolioMutation<A> = {
  readonly documents: ReadonlyMap<string, CanvasDoc>;
  readonly result: A;
};

export type CanvasPortfolioEdit<A> =
  | { readonly ok: true; readonly mutation: CanvasPortfolioMutation<A> }
  | { readonly ok: false; readonly error: WorkErrorBody };

export type CanvasPortfolioCommit<A> = {
  readonly result: A;
  readonly affected: ReadonlyArray<{
    readonly name: string;
    readonly revision: string;
  }>;
};

export class CanvasesService extends Context.Service<CanvasesService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly list: Effect.Effect<ReadonlyArray<CanvasSummary>, CanvasError>;
    /**
     * `tag` names the caller in main-thread budget reports only. It never
     * reaches SQLite, the document, or any product surface.
     */
    readonly read: (
      name: string,
      tag?: CanvasReadTag,
    ) => Effect.Effect<CanvasReadResult, CanvasError>;
    readonly readWithIntentWitness: (
      name: string,
      tag?: CanvasReadTag,
    ) => Effect.Effect<CanvasReadWithIntentWitness, CanvasError>;
    /**
     * One node's authorial structure from live authority — the work projection
     * is never built. Same freshness as `read` (same authority snapshot, same
     * transaction), a fraction of the cost. `undefined` when the canvas holds
     * no such node; a missing canvas is still an error.
     */
    readonly readNodeStructure: (
      name: string,
      nodeId: string,
    ) => Effect.Effect<CanvasNodeStructure | undefined, CanvasError>;
    readonly write: (
      name: string,
      doc: CanvasDoc,
      expectedRevision?: string,
    ) => Effect.Effect<CanvasWriteResult, CanvasError>;
    // Transactional RMW against the current portfolio head.
    readonly mutate: (
      name: string,
      fn: (doc: CanvasDoc) => CanvasDoc,
    ) => Effect.Effect<void, CanvasError>;
    /**
     * One authorial portfolio transaction. The callback sees every current
     * document and revision; its returned map is reconciled, normalized, and
     * committed atomically. Ordinary `write`/`mutate` callers are unchanged.
     */
    readonly mutatePortfolio: <A>(
      fn: (current: CanvasPortfolioView) => CanvasPortfolioEdit<A>,
    ) => Effect.Effect<CanvasPortfolioCommit<A>, CanvasError | WorkErrorBody>;
    /**
     * Human-only overseer grant/revoke for one managed seat binding, applied
     * to every alias in the same generation. Never accepted from the agent
     * command plane.
     */
    readonly canvasOverseerSet: (
      input: CanvasOverseerSetInput,
    ) => Effect.Effect<CanvasOverseerSetResult, CanvasError>;
    readonly create: (name: string) => Effect.Effect<CanvasReadResult, CanvasError>;
    // Removes the canvas from the next authority generation and projections.
    // Notifies change subscribers so the kernel can drop hydrated state.
    readonly remove: (name: string) => Effect.Effect<{ name: string }, CanvasError>;
    // Creates the seed canvas when authority is empty. Called at startup.
    readonly ensureSeed: Effect.Effect<void, CanvasError>;
    // Writes an agent-facing projection (digest/svg). Returns its path.
    readonly writeSidecar: (
      name: string,
      suffix: string,
      contents: string,
    ) => Effect.Effect<string, CanvasError>;
    // Bootstraps the live map from SQLite authority once (idempotent).
    readonly start: () => void;
    /**
     * Document commits (write/mutate/create/remove). Optional detail carries
     * previous/next docs for same-tick edge-delete session teardown.
     */
    readonly subscribeChanges: (
      listener: (name: string, detail?: CanvasChangeDetail) => void,
    ) => () => void;
    /**
     * Tell renderer subscribers that Station projection membership changed.
     * Remote has no authorial write, so install would otherwise stay silent.
     */
    readonly announceInstalledProjection: (
      changes: ReadonlyArray<InstalledProjectionCanvasChange>,
    ) => void;
    /** Snapshot of live authority docs for process-bind caller resolution. */
    readonly liveDocuments: () => Effect.Effect<
      ReadonlyArray<{ readonly canvasName: string; readonly doc: CanvasDoc }>,
      CanvasError
    >;
    /**
     * Last committed canvas-authority generation as a decimal string.
     * Projection compilation records this as its source audit generation;
     * projection versions allocate their own monotonic generation.
     */
    readonly liveAuthorityGeneration: () => Effect.Effect<string, CanvasError>;
    /** Generation and semantic documents read in one SQLite snapshot. */
    readonly authoritySnapshot: () => Effect.Effect<
      CanvasAuthoritySnapshot,
      CanvasError
    >;
    /**
     * Generation, semantic documents, and exact stored bodies read from one
     * StateEngine snapshot. Security-sensitive authority derivation uses this
     * required material view rather than reconstructing bytes from documents.
     */
    readonly authorityMaterialSnapshot: () => Effect.Effect<
      CanvasAuthorityMaterialSnapshot,
      CanvasError
    >;
    /**
     * Exact active intent identity from one SQLite snapshot: authorial canvas
     * generation/hash on Command Center, projection generation/hash on Remote.
     */
    readonly activeIntentWitness: () => Effect.Effect<
      ActiveIntentWitness,
      CanvasError
    >;
    /**
     * Complete compiled actor-reference surface for the active portfolio.
     * Consumers resolve execution identity through this mapping; node IDs
     * alone never substitute for ActorSeatId.
     */
    readonly activeActorRefs: () => Effect.Effect<
      ReadonlyArray<ActorRef>,
      CanvasError
    >;
  }>()("@junto/CanvasesService") {}

type StationProjectionRow = {
  readonly generation: string;
  readonly body: string;
  readonly content_sha256: string;
  readonly created_at: string;
  readonly received_at: string;
};

type CanvasCommitCause =
  | "migrate"
  | "write"
  | "mutate"
  | "create"
  | "remove"
  | "seed"
  | "overseer";

type CommitOutcome = {
  readonly generation: string;
  readonly changed: boolean;
};

type IdentifiedPortfolio = {
  readonly identity: string;
  readonly snapshot: ActivePortfolioSnapshot;
};

/** Prepare under the read lease; publish only after it exits successfully. */
const makeActivePortfolioReader = (records: CanvasRecords["Service"]) => {
  let cached: IdentifiedPortfolio | undefined;
  return Effect.fn("Canvases.prepareActivePortfolio")(function* (cacheable: boolean) {
    const identity = yield* records.readActivePortfolioIdentity();
    const value = cacheable && cached?.identity === identity
      ? cached : { identity, snapshot: yield* records.readActivePortfolio() };
    return { ...value, publish: () => { if (cacheable) cached = value; } };
  });
};

/**
 * How many canvases keep a hot Work projection.
 *
 * Sized to hold a full-portfolio sweep — `box/activity-policy.ts` reads every
 * canvas on reconcile — so a sweep does not evict the canvas the operator is
 * actually looking at. It costs little to hold: a memo entry's payload is the
 * same lane objects `projectWorkSnapshots` hangs on the projected document,
 * which the kernel's hydrated `docs` map already retains for every canvas. The
 * bound is here for the long tail (a large portfolio, an idle canvas), and
 * evicting only costs that canvas's next read a rebuild.
 */
const WORK_PROJECTION_CACHE_CANVASES = 16;

/**
 * Memoize one canvas's Work projection over `work_canvas_revisions`.
 *
 * Correctness rests entirely on that counter being a complete witness of every
 * durable row a snapshot projects from. It is, structurally: schema 20 puts an
 * AFTER INSERT/UPDATE/DELETE trigger on every table `readCanvasWorkProjection`
 * reads, so the witness is local to the row rather than inferred from a call
 * path. See WORK_PROJECTION_REVISION_TRIGGERS_SQL for the enumeration and for
 * the two event-free artifact writers that disproved the earlier inference.
 *
 * Two values are memoized because they have different lifetimes: `snapshots`
 * changes only when Work changes, while the projected document also changes
 * when the authorial document does. They share their payload by reference —
 * `projectWorkSnapshots` assigns `snapshot.tasks` and friends straight onto
 * the node — so holding both costs one.
 */
type WorkProjectionCacheEntry = {
  readonly workRevision: string;
  readonly projection: CanvasWorkProjection;
  projected?: {
    readonly portfolioIdentity: string;
    readonly doc: CanvasDoc;
  };
};

const makeWorkProjectionCache = (reader: WorkProjectionReader["Service"], world: WorkWorld | undefined) => {
  const entries = new Map<string, WorkProjectionCacheEntry>();

  const touch = (name: string, entry: WorkProjectionCacheEntry): void => {
    // Re-insert so Map iteration order is least-recent first.
    entries.delete(name);
    entries.set(name, entry);
    while (entries.size > WORK_PROJECTION_CACHE_CANVASES) {
      const oldest = entries.keys().next();
      if (oldest.done === true) break;
      entries.delete(oldest.value);
    }
  };

  return {
    /**
     * The projected document for one canvas, built at most once per
     * (authority identity, work revision) pair.
     */
    projectedDoc: Effect.fn("Canvases.prepareProjectedDoc")(function* (
      name: CanvasName,
      authorialDoc: CanvasDoc,
      portfolioIdentity: string,
      cacheable: boolean,
      tag: CanvasReadTag,
    ) {
      const workRevision = yield* reader.revision(name);
      const cached = cacheable ? entries.get(name) : undefined;
      let entry: WorkProjectionCacheEntry;
      let publishWorld: (() => void) | undefined;
      if (cached !== undefined && cached.workRevision === workRevision) {
        entry = cached;
      } else {
        // The rebuilt projection carries its own reading of the counter, from
        // this same reader; that is the value the snapshots belong to, so it
        // is the one the memo keys on.
        //
        // With the in-memory world this is where a full SQLite rebuild used
        // to be unavoidable: the memo is whole-canvas, so ANY work fact drops
        // it and every sink was re-read. The world holds the same snapshots
        // resident and re-reads only the sinks the mutation seam announced,
        // at the counter value this memo already read. `JUNTO_WORLD=0`
        // takes the branch below and restores the pre-world read exactly.
        const prepared = cacheable && world !== undefined ? yield* world.prepare(name, workRevision) : undefined;
        const projection = prepared?.projection ?? (yield* reader.canvasProjection(name));
        publishWorld = prepared?.publish;
        entry = { workRevision: projection.workRevision, projection };
      }
      if (entry.projected?.portfolioIdentity !== portfolioIdentity) {
        // Never mutate a shared entry while the enclosing read can still fail.
        entry = { ...entry, projected: {
          portfolioIdentity, doc: withinBudget("canvas.read", () => projectWorkSnapshots(authorialDoc, entry.projection.snapshots), tag),
        } };
      }
      return { doc: entry.projected!.doc, workRevision: entry.workRevision, publish: () => {
        if (!cacheable) return;
        publishWorld?.();
        touch(name, entry);
      } };
    }),
    /** Stop pinning a canvas's world once the canvas is gone. */
    evict: (name: string): void => {
      entries.delete(name);
      world?.evict(name);
    },
  };
};

const intentWitnessFromSnapshot = (
  snapshot: ActivePortfolioSnapshot,
): ActiveIntentWitness => {
  if (!snapshot.hasHead || snapshot.intentSha256 === undefined) {
    throw new CanvasError({
      message: "installation has no active intent",
    });
  }
  return {
    generation: snapshot.generation,
    contentSha256: snapshot.intentSha256,
  };
};

const assertAuthorialInstallation = Effect.fn("Canvases.assertAuthorialInstallation")(function* (
  records: CanvasRecords["Service"],
  operation: string,
) {
  if ((yield* records.readLocalStationRole()) === "remote") {
    return yield* Effect.fail(new CanvasError({
      message:
        `cannot ${operation}: Remote installations consume Command Center projection and never author canvases`,
    }));
  }
});

const nextGenerationAfter = (snapshot: StoredAuthoritySnapshot): string =>
  snapshot.hasHead ? (BigInt(snapshot.generation) + 1n).toString() : "1";

/**
 * Authorial commits must compile as a live Command Center portfolio. Writes
 * that would make later read/list/liveDocuments fail stay uncommitted.
 */
const assertAuthorialCandidatePortfolio = Effect.fn("Canvases.assertAuthorialCandidatePortfolio")(function* (
  records: CanvasRecords["Service"],
  documents: ReadonlyMap<string, StoredCanvas>,
) {
  const docs = new Map<string, CanvasDoc>();
  for (const [name, entry] of documents) docs.set(name, entry.doc);
  const topology = yield* records.readCommandCenterTopology();
  yield* Effect.try({
    try: () => compileActorSeatRegistry(docs, topology),
    catch: (error) => error instanceof CanvasError
      ? error
      : new CanvasError({
          message: `cannot commit authorial portfolio: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
  });
});

/**
 * Commit the portfolio delta: upsert changed canvases' rows, delete removed
 * canvases' rows, advance the singleton head. Only canvases whose revision
 * hash moved are touched — an unchanged canvas costs nothing.
 */
const commitPortfolio = Effect.fn("Canvases.commitPortfolio")(function* (
  records: CanvasRecords["Service"],
  previous: StoredAuthoritySnapshot,
  documents: ReadonlyMap<string, StoredCanvas>,
  _cause: CanvasCommitCause,
): Effect.fn.Return<CommitOutcome, CanvasError> {
  yield* assertAuthorialCandidatePortfolio(records, documents);
  const intentSha256 = intentSha256Of(documents);
  if (
    previous.hasHead &&
    previous.intentSha256 === intentSha256 &&
    previous.documents.size === documents.size
  ) {
    return { generation: previous.generation, changed: false };
  }
  const generation = nextGenerationAfter(previous);
  const createdAt = new Date().toISOString();
  for (const name of previous.documents.keys()) {
    if (!documents.has(name)) yield* records.deleteCanvas(name);
  }
  for (const [name, entry] of documents) {
    const prior = previous.documents.get(name);
    if (prior !== undefined && prior.revisionSha256 === entry.revisionSha256) {
      continue;
    }
    yield* records.persistCanvas({
      canvasName: name,
      doc: entry.doc,
      revisionSha256: entry.revisionSha256,
      modifiedAt: entry.modifiedAt,
    });
  }
  yield* records.writePortfolioHead({ generation, intentSha256, at: createdAt });
  return { generation, changed: true };
});

export type RetireGrammarReport = {
  readonly canvases: number;
  /** Stored `escalates` edges dropped (`canvas/retire-escalates.ts`). */
  readonly escalatesEdgesRemoved: number;
  /** Masks that lost the retired `request.escalate` port. */
  readonly masksNarrowed: number;
  /** Nodes that lost `ether.flags` (`canvas/retire-flags.ts`). */
  readonly flagNodesStripped: number;
  /** Watchers that lost `flagOnUnsatisfied`. */
  readonly flagWatchesStripped: number;
  /** `flags` edges and pad/sheet `announces` edges dropped. */
  readonly flagEdgesRemoved: number;
};

/** Every retired grammar plan, applied in order to one raw stored document. */
const planGrammarRetirement = (raw: { readonly nodes: ReadonlyArray<CanvasNode>; readonly edges: ReadonlyArray<CanvasEdge> }) => {
  const escalates = retireEscalatesFromRawDoc(raw);
  const flags = retireFlagsFromRawDoc(escalates.doc);
  return {
    doc: flags.doc,
    escalates,
    flags,
    touches: retirementTouches(escalates) || flagsRetirementTouches(flags),
  };
};

/**
 * Canvas-document migration for retired grammar, as one authority commit:
 * drop stored `escalates` edges and the retired `request.escalate` port
 * (`canvas/retire-escalates.ts`), and retire operator flags, the `flags` verb,
 * `flagOnUnsatisfied` and pad/sheet `announces` (`canvas/retire-flags.ts`).
 * The plans compose on each document so one carrying both still decodes.
 *
 * It must run before anything reads authority: the grammar no longer holds
 * these shapes, so a stored one would decode away and the document would
 * fail its own revision hash. Each touched document is therefore proven from
 * its raw rows first (they must reproduce the stored revision hash, and the
 * portfolio the stored intent hash), and the plan must decode to exactly the
 * bytes it planned. Untouched documents take the ordinary verified read. The
 * commit bumps the generation like any authorial write. Idempotent: a clean
 * portfolio is a read-only no-op.
 */
export const retireStoredGrammar = Effect.fn("Canvases.retireStoredGrammar")(function* (records: CanvasRecords["Service"]): Effect.fn.Return<RetireGrammarReport, CanvasError> {
  const empty: RetireGrammarReport = {
    canvases: 0,
    escalatesEdgesRemoved: 0,
    masksNarrowed: 0,
    flagNodesStripped: 0,
    flagWatchesStripped: 0,
    flagEdgesRemoved: 0,
  };
  if ((yield* records.readLocalStationRole()) === "remote") return empty;
  const head = yield* records.readPortfolioHead();
  if (head === undefined) return empty;

  const previous = new Map<string, StoredCanvas>();
  const next = new Map<string, StoredCanvas>();
  let canvases = 0;
  let escalatesEdgesRemoved = 0;
  let masksNarrowed = 0;
  let flagNodesStripped = 0;
  let flagWatchesStripped = 0;
  let flagEdgesRemoved = 0;
  const now = new Date().toISOString();
  for (const row of yield* records.readDocumentRows()) {
    const name = yield* Effect.try({ try: () => canvasNameFrom(row.canvas_name), catch: toCanvasError });
    const raw = yield* records.readRawCanvasDoc(row.canvas_id);
    const plan = planGrammarRetirement(raw);
    if (!plan.touches) {
      const doc = yield* records.reconstructCanvasDoc(row.canvas_id);
      const body = serializeCanvas(doc);
      const revisionSha256 = canvasBodySha256Of(body);
      if (revisionSha256 !== row.revision_sha256) {
        return yield* Effect.fail(new CanvasError({
          message: `canvas database revision hash mismatch: ${canvasLabel(name)}`,
        }));
      }
      const entry = { doc, body, revisionSha256, modifiedAt: row.modified_at };
      previous.set(name, entry);
      next.set(name, entry);
      continue;
    }
    const storedBody = serializeCanvas(raw as CanvasDoc);
    if (canvasBodySha256Of(storedBody) !== row.revision_sha256) {
      return yield* Effect.fail(new CanvasError({
        message:
          `cannot retire grammar: ${canvasLabel(name)} rows do not reproduce its stored revision hash`,
      }));
    }
    const planned = serializeCanvas(plan.doc as CanvasDoc);
    const decoded = decodeCanvasDoc(plan.doc);
    if (Result.isFailure(decoded)) {
      return yield* Effect.fail(new CanvasError({
        message: `cannot retire grammar: ${canvasLabel(name)} does not decode after retirement: ${decoded.failure.message}`,
      }));
    }
    const body = serializeCanvas(decoded.success);
    if (body !== planned) {
      return yield* Effect.fail(new CanvasError({
        message: `cannot retire grammar: ${canvasLabel(name)} would change beyond the retired shapes`,
      }));
    }
    previous.set(name, {
      doc: raw as CanvasDoc,
      body: storedBody,
      revisionSha256: row.revision_sha256,
      modifiedAt: row.modified_at,
    });
    next.set(name, {
      doc: decoded.success,
      body,
      revisionSha256: canvasBodySha256Of(body),
      modifiedAt: now,
    });
    canvases += 1;
    escalatesEdgesRemoved += plan.escalates.removedEdgeIds.length;
    masksNarrowed += plan.escalates.narrowedEdgeIds.length;
    flagNodesStripped += plan.flags.strippedNodeIds.length;
    flagWatchesStripped += plan.flags.strippedWatchIds.length;
    flagEdgesRemoved += plan.flags.removedEdgeIds.length;
  }
  if (canvases === 0) return empty;
  if (intentSha256Of(previous) !== head.intent_sha256) {
    return yield* Effect.fail(new CanvasError({
      message: `canvas portfolio generation ${head.generation} intent hash mismatch`,
    }));
  }
  yield* commitPortfolio(
    records,
    {
      hasHead: true,
      generation: head.generation,
      createdAt: head.created_at,
      intentSha256: head.intent_sha256,
      documents: previous,
    },
    next,
    "migrate",
  );
  return {
    canvases,
    escalatesEdgesRemoved,
    masksNarrowed,
    flagNodesStripped,
    flagWatchesStripped,
    flagEdgesRemoved,
  };
});

/**
 * Run the grammar retirement once per install. The install-ops markers are
 * bookkeeping only: without them (unavailable ledger, fresh seed) the walk
 * still runs, and it is a read-only no-op on a clean portfolio. A backfill
 * never gates boot, so a failure is logged and the walk retried on the next
 * boot; the authority read that follows then reports the unmigrated document.
 */
const GRAMMAR_RETIREMENT_MARKERS = [
  BACKFILL_CANVAS_RETIRE_ESCALATES_V1,
  BACKFILL_CANVAS_RETIRE_FLAGS_V1,
] as const;

const retireStoredGrammarOnce = Effect.fn("Canvases.retireStoredGrammarOnce")(function* (
  sql: SqlClient.SqlClient, records: CanvasRecords["Service"],
) {
    const ownsTransaction = Option.isNone(yield* Effect.serviceOption(sql.transactionService));
    const installOps = yield* Effect.serviceOption(InstallOpsService);
    // A caller may roll its transaction back. Do not mark its migration
    // complete in the independent install-local ledger before that commit.
    const ops = ownsTransaction && Option.isSome(installOps) ? installOps.value : undefined;
    if (ops !== undefined) {
      let complete = true;
      for (const id of GRAMMAR_RETIREMENT_MARKERS) {
        const marker = yield* ops.getBackfill(id).pipe(Effect.orElseSucceed(() => undefined));
        if (marker?.status !== "complete") complete = false;
      }
      if (complete) return;
      for (const id of GRAMMAR_RETIREMENT_MARKERS) {
        yield* Effect.ignore(ops.ensurePending(id));
      }
    }
    const report = yield* sql.withTransaction(retireStoredGrammar(records)).pipe(
      Effect.provideService(StateTransactionOperation, "canvas.retire-grammar"),
    );
    if (report.canvases > 0) {
      console.info(
        `[canvases] retired grammar across ${report.canvases} canvas(es): ` +
          `${report.escalatesEdgesRemoved} escalates edge(s), ${report.masksNarrowed} mask(s) narrowed, ` +
          `${report.flagNodesStripped} flagged node(s), ${report.flagWatchesStripped} watcher flag(s), ` +
          `${report.flagEdgesRemoved} flag edge(s)`,
      );
    }
    if (ops !== undefined) {
      yield* Effect.ignore(
        ops.markComplete(BACKFILL_CANVAS_RETIRE_ESCALATES_V1, report.escalatesEdgesRemoved),
      );
      yield* Effect.ignore(
        ops.markComplete(
          BACKFILL_CANVAS_RETIRE_FLAGS_V1,
          report.flagNodesStripped + report.flagWatchesStripped + report.flagEdgesRemoved,
        ),
      );
    }
  },
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error("[canvases] grammar retirement deferred to next boot:", error);
      }),
    ),
  );

/**
 * Remove runtime work overlays at the protected authorial boundary.
 *
 * WorkRepository owns the overlay mechanism; Canvases owns the inverse
 * boundary because no repository-private document transform may be required
 * to make authorial persistence safe.
 *
 * `ether.tasks.name` and `ether.tasks.contract` are operator-authored document
 * truth, so they survive the strip while projected rows beside them do not.
 * `items` stays present-and-empty because WorkTasks requires it.
 */
const stripRuntimeWorkProjection = (doc: CanvasDoc): CanvasDoc => ({
  ...doc,
  nodes: doc.nodes.map((node) => {
    const etherIn = node.ether;
    if (
      etherIn === undefined ||
      (
        etherIn.tasks === undefined &&
        etherIn.requests === undefined &&
        etherIn.messages === undefined &&
        etherIn.artifacts === undefined &&
        etherIn.board === undefined &&
        etherIn.pad === undefined
      )
    ) {
      return node;
    }

    const {
      tasks: strippedTasks,
      requests: strippedRequests,
      messages: _messages,
      artifacts: _artifacts,
      board: _board,
      pad: _pad,
      ...rest
    } = etherIn;
    const name = strippedTasks?.name;
    const contract = strippedTasks?.contract;
    // ether.requests.name is operator-authored document truth, like the tasks
    // name: it survives the strip with a present-and-empty items shell.
    const requestsName = strippedRequests?.name;
    const ether =
      contract === undefined &&
      name === undefined &&
      requestsName === undefined
        ? rest
        : {
            ...rest,
            ...(name !== undefined || contract !== undefined
              ? {
                  tasks: {
                    items: [],
                    ...(name ? { name } : {}),
                    ...(contract ? { contract } : {}),
                  },
                }
              : {}),
            ...(requestsName !== undefined
              ? { requests: { items: [], name: requestsName } }
              : {}),
          };
    const kind = ether.entity?.kind;
    const text =
      node.type !== "text"
        ? undefined
        : kind === "task"
          ? mirrorTasksText([])
          : kind === "requests"
            ? mirrorRequestsText([], requestsName)
            : kind === "artifacts"
              ? mirrorArtifactsText([])
              : kind === "board"
                ? mirrorBoardText(node.text ?? "", [])
                : kind === "pad"
                  ? padTitleFromText(node.text ?? "")
                  : node.text;

    if (Object.keys(ether).length === 0) {
      const { ether: _removed, ...withoutEther } = node;
      return {
        ...withoutEther,
        ...(node.type === "text" && text !== undefined ? { text } : {}),
      } as CanvasNode;
    }
    return {
      ...node,
      ...(node.type === "text" && text !== undefined ? { text } : {}),
      ether,
    } as CanvasNode;
  }),
});

const normalizeCanvas = Effect.fn("Canvases.normalizeCanvas")(function* (
  name: CanvasName,
  doc: CanvasDoc,
  modifiedAt: string,
  operation: string,
): Effect.fn.Return<StoredCanvas, CanvasError> {
  const decoded = decodeCanvasDoc(stripRuntimeWorkProjection(doc));
  if (Result.isFailure(decoded)) {
    return yield* Effect.fail(new CanvasError({
      message: `cannot ${operation} ${canvasLabel(name)}: ${decoded.failure.message}`,
    }));
  }
  const nextDoc = decoded.success;
  const body = serializeCanvas(nextDoc);
  return {
    doc: nextDoc,
    body,
    revisionSha256: canvasBodySha256Of(body),
    modifiedAt,
  };
});

const storedDocumentsView = (
  snapshot: StoredAuthoritySnapshot,
): CanvasPortfolioView => {
  const documents = new Map<string, CanvasDoc>();
  const revisions = new Map<string, string>();
  for (const [name, entry] of snapshot.documents) {
    documents.set(name, entry.doc);
    revisions.set(name, entry.revisionSha256);
  }
  return { documents, revisions };
};

const normalizePortfolioDocuments = Effect.fn("Canvases.normalizePortfolioDocuments")(function* (
  previous: StoredAuthoritySnapshot,
  proposed: ReadonlyMap<string, CanvasDoc>,
  modifiedAt: string,
  operation: string,
  preserveIncomingOverseer: boolean,
): Effect.fn.Return<Map<string, StoredCanvas>, CanvasError> {
  const documents = new Map<string, StoredCanvas>();
  for (const [rawName, incoming] of proposed) {
    const name = yield* Effect.try({ try: () => canvasNameFrom(rawName), catch: toCanvasError });
    const prior = previous.documents.get(name);
    const reconciled = preserveIncomingOverseer
      ? incoming
      : reconcileOverseerGrants(prior?.doc ?? { nodes: [], edges: [] }, incoming);
    const candidate = yield* normalizeCanvas(name, reconciled, modifiedAt, operation);
    const nextEntry =
      prior !== undefined && candidate.revisionSha256 === prior.revisionSha256
        ? { ...candidate, modifiedAt: prior.modifiedAt }
        : candidate;
    documents.set(name, nextEntry);
  }
  return documents;
});

export const CanvasesLive = Layer.effect(
  CanvasesService,
  Effect.gen(function* () {
    const state = yield* StateEngine;
    const sql = yield* SqlClient.SqlClient;
    const records = yield* CanvasRecords;
    const entities = yield* CanvasEntitySync;
    const work = yield* WorkRepository;
    const workReader = yield* WorkProjectionReader;
    const runtime = yield* Effect.context<never>();
    const listeners = new Set<
      (name: string, detail?: CanvasChangeDetail) => void
    >();
    // Per-installation, not module-level: a second StateEngine in the same
    // process (tests, recovery) must never see another database's memo.
    const activePortfolio = makeActivePortfolioReader(records);
    // The in-memory factory world, per installation for the same reason the
    // portfolio memo is: a second StateEngine in this process must never be
    // served another database's sinks.
    const world = workWorldEnabled ? makeWorkWorld(workReader) : undefined;
    if (world !== undefined) {
      yield* Effect.addFinalizer(() => Effect.sync(() => world.close()));
    }
    const workProjections = makeWorkProjectionCache(workReader, world);

  const notifyListeners = (
    name: CanvasName | string,
    detail?: CanvasChangeDetail,
  ): void => {
    // A waiter can synchronously unsubscribe and subscribe again. Its new
    // listener belongs to the next change, never this dispatch.
    for (const listener of [...listeners]) {
      try {
        listener(name, detail);
      } catch (error) {
        // The document operation is already committed. A subscriber cannot
        // retroactively turn it into a failed write/delete and invite retry.
        console.error(`[canvases] change listener failed for ${name}:`, error);
      }
    }
  };

  const bootstrap = Effect.gen(function* () {
    // A Remote's active portfolio is its replace-only Station projection. Gate
    // all authorial bootstrap work from canonical role state before even
    // inspecting stale source rows. runCanvasRelationalBackfill repeats this
    // check for direct callers and role races.
    const stationRole = yield* records.readLocalStationRole();
    if (stationRole === "remote") return;

    const status = yield* withSqlRead(sql, Effect.gen(function* () {
      return {
        hasHead: (yield* records.readPortfolioHead()) !== undefined,
        documents: (yield* records.readDocumentRows()).length,
      };
    }))
      .pipe(Effect.mapError(toCanvasError));

    if (!status.hasHead && status.documents > 0) {
      return yield* Effect.fail(
        new CanvasError({
          message:
            "canvas portfolio head is missing while canvas rows exist; recovery required",
        }),
      );
    }

    // Canvas-document migration: retired grammar (escalates, operator flags)
    // leaves stored documents before the first authority read (see
    // retireStoredGrammar). Marker-gated in install-ops; a failure is logged
    // and retried next boot.
    yield* retireStoredGrammarOnce(sql, records);

    // Heal registry gaps when active membership diverges from the head doc
    // (incomplete v5→v6 backfill, wiped rows). An exact empty source has no
    // active authorial membership, so archive active rows while preserving the
    // archived/soft-deleted identity ledger. Missing-head nonempty history was
    // refused above and never reaches reconciliation.
    yield* sql.withTransaction(Effect.gen(function* () {
        // Close a serialized configure race after the startup role guard.
        if ((yield* records.readLocalStationRole()) === "remote") return;
        const now = new Date().toISOString();
        const activeCanvasNames = yield* entities.activeCanvasNames();
        if (!status.hasHead) {
          for (const canvasName of activeCanvasNames) {
            yield* entities.archiveAllCanvasEntities(canvasName, now);
          }
          return;
        }

        const snapshot = yield* records.readStoredAuthority();
        for (const canvasName of activeCanvasNames) {
          if (!snapshot.documents.has(canvasName)) {
            yield* entities.archiveAllCanvasEntities(canvasName, now);
          }
        }
        for (const [name, entry] of snapshot.documents) {
          // syncCanvasEntities already reads the full lifecycle/kind/binding
          // view once and writes only its dirty set. An ID-only shortcut would
          // miss same-ID provenance drift and is not a safe alignment proof.
          yield* entities.syncCanvasEntities(name, entry.doc, now);
        }
      }))
      .pipe(
        Effect.provideService(StateTransactionOperation, "canvas.entity-reconcile"),
        Effect.mapError(toCanvasError),
      );

  });

  let ready = false;
  const cachedBootstrap = yield* Effect.cached(bootstrap.pipe(
    Effect.tap(() => Effect.sync(() => { ready = true; })),
  ));
  const ensureReady = Effect.gen(function* () {
    if (ready) return;
    // An initial read inside a caller-owned write must not publish readiness
    // from rows that can still roll back, or await a bootstrap holding for
    // this same connection in another fiber.
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
      return yield* bootstrap;
    }
    return yield* cachedBootstrap;
  });

  const readAuthority = (
    operation: string,
  ): Effect.Effect<StoredAuthoritySnapshot, CanvasError> =>
    ensureReady.pipe(
      Effect.flatMap(() =>
        withSqlRead(sql, records.readStoredAuthority()).pipe(
          Effect.withSpan(operation),
          Effect.mapError(toCanvasError),
        ),
      ),
    );

  const readActive = Effect.fn("Canvases.readActive")(function* (
    operation: string,
  ) {
    yield* ensureReady;
    const cacheable = Option.isNone(yield* Effect.serviceOption(sql.transactionService));
    const prepared = yield* withSqlRead(sql, activePortfolio(cacheable)).pipe(Effect.withSpan(operation));
    prepared.publish();
    return prepared.snapshot;
  }, Effect.mapError(toCanvasError));

  const transaction = <A, E, R>(
    operation: string,
    body: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, CanvasError, R> =>
    ensureReady.pipe(
      Effect.flatMap(() =>
        sql.withTransaction(Effect.gen(function* () {
          yield* assertAuthorialInstallation(records, operation);
          return yield* body;
        })).pipe(
          Effect.provideService(StateTransactionOperation, operation),
          Effect.mapError(toCanvasError),
        ),
      ),
    );

  const list: Effect.Effect<ReadonlyArray<CanvasSummary>, CanvasError> =
    readActive("canvas.list").pipe(
      Effect.map((snapshot) =>
        [...snapshot.documents.entries()]
          .map(([name, entry]) => ({
            name,
            modifiedAt: entry.modifiedAt,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ),
    );

  const readWithIntentWitness = Effect.fn("Canvases.readWithIntentWitness")(function* (
    name: string,
    tag: CanvasReadTag = "untagged",
  ) {
      const canonicalName = yield* Effect.try({
        try: () => canvasNameFrom(name),
        catch: toCanvasError,
      });
      yield* ensureReady;
      const cacheable = Option.isNone(yield* Effect.serviceOption(sql.transactionService));
      const prepared = yield* withSqlRead(sql, Effect.gen(function* () {
            const portfolio = yield* activePortfolio(cacheable);
            const { identity, snapshot } = portfolio;
            const entry = snapshot.documents.get(canonicalName);
            if (entry === undefined) {
              return yield* Effect.fail(new CanvasError({
                message: `canvas "${canonicalName}" is not in the active portfolio`,
              }));
            }
            const projected = yield* workProjections.projectedDoc(
              canonicalName,
              entry.doc,
              identity,
              cacheable,
              tag,
            );
            const intentWitness = yield* Effect.try({ try: () => intentWitnessFromSnapshot(snapshot), catch: toCanvasError });
            const result = {
              read: {
                name: canonicalName,
                doc: projected.doc,
                actorRefs: snapshot.actorRefs.filter(
                  (actor) => actor.canvasName === canonicalName,
                ),
                revision: entry.revisionSha256,
                workRevision: projected.workRevision,
              },
              intentWitness,
            };
            return { result, publish: () => { portfolio.publish(); projected.publish(); } };
      }));
      prepared.publish();
      return prepared.result;
    }, Effect.mapError(toCanvasError));

  const read = (
    name: string,
    tag: CanvasReadTag = "untagged",
  ): Effect.Effect<CanvasReadResult, CanvasError> =>
    readWithIntentWitness(name, tag).pipe(
      Effect.map(({ read }) => read),
    );

  const readNodeStructure = Effect.fn("Canvases.readNodeStructure")(function* (
    name: string,
    nodeId: string,
  ): Effect.fn.Return<CanvasNodeStructure | undefined, CanvasError> {
      const canonicalName = yield* Effect.try({
        try: () => canvasNameFrom(name),
        catch: toCanvasError,
      });
      const snapshot = yield* readActive("canvas.readNodeStructure");
          // Same authority snapshot `read` resolves against, so a caller that
          // routes on this node sees exactly the document the last commit
          // published — never a lagging renderer projection. What is skipped
          // is only `readCanvasWorkProjection` + `projectWorkSnapshots`, which
          // add work lanes and touch no structural field.
          const entry = snapshot.documents.get(canonicalName);
          if (entry === undefined) {
            return yield* Effect.fail(new CanvasError({
              message: `canvas "${canonicalName}" is not in the active portfolio`,
            }));
          }
          const node = entry.doc.nodes.find(
            (candidate) => candidate.id === nodeId,
          );
          const result: CanvasNodeStructure | undefined =
            node === undefined
              ? undefined
              : {
                  name: canonicalName,
                  node,
                  structure: entry.doc,
                  revision: entry.revisionSha256,
                };
          return result;
    });

  const write = Effect.fn("Canvases.write")(function* (
    name: string,
    doc: CanvasDoc,
    expectedRevision?: string,
  ): Effect.fn.Return<CanvasWriteResult, CanvasError> {
      yield* ensureReady;
      const canonicalName = yield* Effect.try({
        try: () => canvasNameFrom(name),
        catch: toCanvasError,
      });
      const outcome = yield* transaction("canvas.write", Effect.gen(function* () {
        const current = yield* records.readStoredAuthority();
        const previous = current.documents.get(canonicalName);
        if (
          expectedRevision !== undefined &&
          (previous === undefined ||
            previous.revisionSha256 !== expectedRevision)
        ) {
          return yield* Effect.fail(new CanvasError({
            message: `${canvasLabel(canonicalName)} revision conflict; reload before saving`,
          }));
        }
        const candidate = yield* normalizeCanvas(
          canonicalName,
          reconcileOverseerGrants(previous?.doc ?? { nodes: [], edges: [] }, doc),
          new Date().toISOString(),
          "write",
        );
        const nextEntry =
          candidate.revisionSha256 === previous?.revisionSha256
            ? { ...candidate, modifiedAt: previous.modifiedAt }
            : candidate;
        const documents = new Map(current.documents);
        documents.set(canonicalName, nextEntry);
        const commit = yield* commitPortfolio(records, current, documents, "write");
        if (commit.changed || previous === undefined) {
          yield* entities.syncCanvasEntities(
            canonicalName,
            nextEntry.doc,
            nextEntry.modifiedAt,
          );
        }
        return { commit, previous, nextEntry };
      }));
      if (outcome.commit.changed) {
        yield* Effect.sync(() =>
          notifyListeners(canonicalName, {
            previous: outcome.previous?.doc,
            next: outcome.nextEntry.doc,
          }),
        );
      }
      return { revision: outcome.nextEntry.revisionSha256 };
    });

  const mutate = Effect.fn("Canvases.mutate")(function* (
    name: string,
    fn: (doc: CanvasDoc) => CanvasDoc,
  ): Effect.fn.Return<void, CanvasError> {
      yield* ensureReady;
      const canonicalName = yield* Effect.try({
        try: () => canvasNameFrom(name),
        catch: toCanvasError,
      });
      const outcome = yield* transaction("canvas.mutate", Effect.gen(function* () {
        const current = yield* records.readStoredAuthority();
        const previous = current.documents.get(canonicalName);
        if (previous === undefined) {
          return yield* Effect.fail(new CanvasError({
            message: `canvas "${canonicalName}" does not exist in SQLite authority`,
          }));
        }
        const proposed = yield* Effect.try({ try: () => fn(previous.doc), catch: toCanvasError });
        const candidate = yield* normalizeCanvas(
          canonicalName,
          reconcileOverseerGrants(previous.doc, proposed),
          new Date().toISOString(),
          "mutate",
        );
        const nextEntry =
          candidate.revisionSha256 === previous.revisionSha256
            ? { ...candidate, modifiedAt: previous.modifiedAt }
            : candidate;
        const documents = new Map(current.documents);
        documents.set(canonicalName, nextEntry);
        const commit = yield* commitPortfolio(
          records,
          current,
          documents,
          "mutate",
        );
        if (commit.changed) {
          yield* entities.syncCanvasEntities(
            canonicalName,
            nextEntry.doc,
            nextEntry.modifiedAt,
          );
        }
        return { commit, previous, nextEntry };
      }));
      if (outcome.commit.changed) {
        yield* Effect.sync(() =>
          notifyListeners(canonicalName, {
            previous: outcome.previous.doc,
            next: outcome.nextEntry.doc,
          }),
        );
      }
    });

  const mutatePortfolio = Effect.fn("Canvases.mutatePortfolio")(function* <A>(
    fn: (current: CanvasPortfolioView) => CanvasPortfolioEdit<A>,
  ): Effect.fn.Return<CanvasPortfolioCommit<A>, CanvasError | WorkErrorBody> {
      yield* ensureReady;
      const outcome = yield* transaction("canvas.mutatePortfolio", Effect.gen(function* () {
        const current = yield* records.readStoredAuthority();
        const edit = yield* Effect.try({ try: () => fn(storedDocumentsView(current)), catch: toCanvasError });
        if (!edit.ok) return { kind: "rejected" as const, error: edit.error };
        const modifiedAt = new Date().toISOString();
        const nextDocuments = yield* normalizePortfolioDocuments(
          current,
          edit.mutation.documents,
          modifiedAt,
          "mutate",
          false,
        );
        const commit = yield* commitPortfolio(
          records,
          current,
          nextDocuments,
          "mutate",
        );
        if (commit.changed) {
          for (const [name, entry] of nextDocuments) {
            const prior = current.documents.get(name);
            if (
              prior === undefined ||
              prior.revisionSha256 !== entry.revisionSha256
            ) {
              yield* entities.syncCanvasEntities(name, entry.doc, entry.modifiedAt);
            }
          }
          for (const name of current.documents.keys()) {
            if (!nextDocuments.has(name)) {
              yield* entities.archiveAllCanvasEntities(name, modifiedAt);
            }
          }
        }
        const affected: Array<{ name: string; revision: string }> = [];
        const notifications: Array<{
          readonly name: CanvasName;
          readonly previous: CanvasDoc | undefined;
          readonly next: CanvasDoc | undefined;
        }> = [];
        for (const [name, entry] of nextDocuments) {
          const prior = current.documents.get(name);
          if (
            prior === undefined ||
            prior.revisionSha256 !== entry.revisionSha256
          ) {
            affected.push({ name, revision: entry.revisionSha256 });
            notifications.push({
              name: name as CanvasName,
              previous: prior?.doc,
              next: entry.doc,
            });
          }
        }
        for (const name of current.documents.keys()) {
          if (!nextDocuments.has(name)) {
            const prior = current.documents.get(name);
            notifications.push({
              name: name as CanvasName,
              previous: prior?.doc,
              next: undefined,
            });
          }
        }
        return {
          kind: "committed" as const,
          result: edit.mutation.result,
          affected,
          notifications,
        };
      }));
      if (outcome.kind === "rejected") {
        return yield* Effect.fail(outcome.error);
      }
      for (const notice of outcome.notifications) {
        yield* Effect.sync(() =>
          notifyListeners(notice.name, {
            previous: notice.previous,
            next: notice.next,
          }),
        );
      }
      return { result: outcome.result, affected: outcome.affected };
    });

  const canvasOverseerSet = Effect.fn("Canvases.canvasOverseerSet")(function* (
    input: CanvasOverseerSetInput,
  ): Effect.fn.Return<CanvasOverseerSetResult, CanvasError> {
      yield* ensureReady;
      if (typeof input.overseer !== "boolean") {
        return yield* Effect.fail(
          new CanvasError({ message: "overseer must be a boolean" }),
        );
      }
      const canonicalName = yield* Effect.try({
        try: () => canvasNameFrom(input.canvasName),
        catch: toCanvasError,
      });
      const outcome = yield* transaction("canvas.overseerSet", Effect.gen(function* () {
        const current = yield* records.readStoredAuthority();
        const previous = current.documents.get(canonicalName);
        if (
          previous === undefined ||
          previous.revisionSha256 !== input.expectedRevision
        ) {
          return yield* Effect.fail(new CanvasError({
            message: `${canvasLabel(canonicalName)} revision conflict; reload before saving`,
          }));
        }
        const node = previous.doc.nodes.find(
          (candidate) => candidate.id === input.nodeId,
        );
        if (node === undefined) {
          return yield* Effect.fail(new CanvasError({
            message: `node "${input.nodeId}" is not on ${canvasLabel(canonicalName)}`,
          }));
        }
        if (!isManagedAgentNode(node)) {
          return yield* Effect.fail(new CanvasError({
            message: `node "${input.nodeId}" is not a managed agent seat`,
          }));
        }
        const seat = nodeSeatBinding(node);
        if (seat === undefined) {
          return yield* Effect.fail(new CanvasError({
            message: `node "${input.nodeId}" is missing host/binding identity`,
          }));
        }
        const view = storedDocumentsView(current);
        const proposed = setBindingOverseer(
          view.documents,
          seat,
          input.overseer,
        );
        const modifiedAt = new Date().toISOString();
        const nextDocuments = yield* normalizePortfolioDocuments(
          current,
          proposed,
          modifiedAt,
          "overseer",
          true,
        );
        const commit = yield* commitPortfolio(
          records,
          current,
          nextDocuments,
          "overseer",
        );
        const affected: Array<{ name: string; revision: string }> = [];
        const notifications: Array<{
          readonly name: CanvasName;
          readonly previous: CanvasDoc | undefined;
          readonly next: CanvasDoc;
        }> = [];
        for (const [name, entry] of nextDocuments) {
          const prior = current.documents.get(name);
          if (
            prior === undefined ||
            prior.revisionSha256 !== entry.revisionSha256
          ) {
            if (commit.changed) {
              yield* entities.syncCanvasEntities(name, entry.doc, entry.modifiedAt);
            }
            affected.push({ name, revision: entry.revisionSha256 });
            notifications.push({
              name: name as CanvasName,
              previous: prior?.doc,
              next: entry.doc,
            });
          }
        }
        if (affected.length === 0) {
          affected.push({
            name: canonicalName,
            revision: previous.revisionSha256,
          });
        }
        return {
          binding: seat,
          overseer: input.overseer,
          affected,
          notifications,
        };
      }));
      for (const notice of outcome.notifications) {
        yield* Effect.sync(() =>
          notifyListeners(notice.name, {
            previous: notice.previous,
            next: notice.next,
          }),
        );
      }
      return {
        binding: outcome.binding,
        overseer: outcome.overseer,
        affected: outcome.affected,
      };
    });

  const create = Effect.fn("Canvases.create")(function* (name: string): Effect.fn.Return<CanvasReadResult, CanvasError> {
      yield* ensureReady;
      const canonicalName = yield* Effect.try({
        try: () => canvasNameFrom(name),
        catch: toCanvasError,
      });
      const outcome = yield* transaction("canvas.create", Effect.gen(function* () {
        const current = yield* records.readStoredAuthority();
        if (current.documents.has(canonicalName)) {
          return yield* Effect.fail(new CanvasError({
            message: `canvas "${canonicalName}" already exists`,
          }));
        }
        const entry = yield* normalizeCanvas(
          canonicalName,
          { nodes: [], edges: [] },
          new Date().toISOString(),
          "create",
        );
        const documents = new Map(current.documents);
        documents.set(canonicalName, entry);
        yield* commitPortfolio(records, current, documents, "create");
        yield* entities.syncCanvasEntities(
          canonicalName,
          entry.doc,
          entry.modifiedAt,
        );
        return entry;
      }));
      yield* Effect.sync(() =>
        notifyListeners(canonicalName, {
          previous: undefined,
          next: outcome.doc,
        }),
      );
      return yield* read(canonicalName);
    });

  const remove = Effect.fn("Canvases.remove")(function* (name: string): Effect.fn.Return<{ name: string }, CanvasError> {
      yield* ensureReady;
      const canonicalName = yield* Effect.try({
        try: () => canvasNameFrom(name),
        catch: toCanvasError,
      });
      const previous = yield* transaction("canvas.remove", Effect.gen(function* () {
        const current = yield* records.readStoredAuthority();
        const entry = current.documents.get(canonicalName);
        if (entry === undefined) {
          return yield* Effect.fail(new CanvasError({
            message: `canvas "${canonicalName}" does not exist`,
          }));
        }
        const documents = new Map(current.documents);
        documents.delete(canonicalName);
        yield* commitPortfolio(records, current, documents, "remove");
        yield* entities.archiveAllCanvasEntities(
          canonicalName,
          new Date().toISOString(),
        );
        return entry;
      }));
      yield* Effect.tryPromise({
        try: () =>
          removeCanvasProjectionSidecars(canonicalName).catch(() => undefined),
        catch: toCanvasError,
      });
      yield* Effect.sync(() => {
        workProjections.evict(canonicalName);
        notifyListeners(canonicalName, {
          previous: previous.doc,
          next: undefined,
        });
      });
      return { name: canonicalName };
    });

  const ensureSeed: Effect.Effect<void, CanvasError> = ensureReady.pipe(
    Effect.flatMap(() =>
      transaction("canvas.seed", Effect.gen(function* () {
        const current = yield* records.readStoredAuthority();
        if (current.documents.size > 0) return undefined;
        const name = canvasNameFrom(SEED_CANVAS_NAME);
        const entry = yield* normalizeCanvas(
          name,
          { nodes: [], edges: [] },
          new Date().toISOString(),
          "seed",
        );
        const documents = new Map(current.documents);
        documents.set(name, entry);
        const commit = yield* commitPortfolio(
          records,
          current,
          documents,
          "seed",
        );
        if (commit.changed) {
          yield* entities.syncCanvasEntities(name, entry.doc, entry.modifiedAt);
        }
        return commit.changed ? { name, entry } : undefined;
      })),
    ),
    Effect.tap((created) =>
      created === undefined
        ? Effect.void
        : Effect.sync(() =>
            notifyListeners(created.name, {
              previous: undefined,
              next: created.entry.doc,
            }),
          ),
    ),
    Effect.asVoid,
  );

  const writeSidecar = (
    name: string,
    suffix: string,
    contents: string,
  ): Effect.Effect<string, CanvasError> =>
    Effect.tryPromise({
      try: () => writeCanvasProjectionSidecar(name, suffix, contents),
      catch: toCanvasError,
    });

  const start = (): void => {
    void Effect.runPromiseWith(runtime)(ensureReady).catch((error) => {
      console.error("[canvases] SQLite authority bootstrap failed:", error);
    });
  };

  const subscribeChanges = (
    listener: (name: string, detail?: CanvasChangeDetail) => void,
  ) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  // Work rows are runtime state. Renderer and kernel consume one canvas
  // projection invalidation stream, so committed work changes join that
  // stream without ever becoming authorial intent.
  work.subscribeChanges((canvasName) => {
    try {
      notifyListeners(canvasNameFrom(canvasName));
    } catch {
      // Repository constraints own canonical canvas names. If a corrupt row is
      // ever observed, its mutation already failed before this callback.
    }
  });

  const readAuthorityMaterialSnapshot = (
    operation: string,
    missingHeadMessage: string,
  ): Effect.Effect<CanvasAuthorityMaterialSnapshot, CanvasError> =>
    readAuthority(operation).pipe(
      Effect.flatMap((snapshot) => {
        if (!snapshot.hasHead || snapshot.intentSha256 === undefined) {
          return Effect.fail(
            new CanvasError({ message: missingHeadMessage }),
          );
        }
        const documents = new Map<string, CanvasDoc>();
        const storedDocuments = new Map<
          string,
          CanvasAuthorityStoredDocument
        >();
        for (const [name, entry] of snapshot.documents) {
          documents.set(name, entry.doc);
          storedDocuments.set(name, {
            document: entry.doc,
            rawBody: entry.body,
            revisionSha256: entry.revisionSha256,
          });
        }
        return Effect.succeed({
          generation: snapshot.generation,
          intentSha256: snapshot.intentSha256,
          documents,
          storedDocuments,
        });
      }),
    );

  const authorityMaterialSnapshot = (): Effect.Effect<
    CanvasAuthorityMaterialSnapshot,
    CanvasError
  > =>
    readAuthorityMaterialSnapshot(
      "canvas.authority-material-snapshot",
      "cannot read canvas authority material without an active authorial head",
    );

  const authoritySnapshot = (): Effect.Effect<
    CanvasAuthoritySnapshot,
    CanvasError
  > =>
    readAuthorityMaterialSnapshot(
      "canvas.authority-snapshot",
      "cannot read canvas authority snapshot without an active authorial head",
    ).pipe(
      Effect.map(({ generation, intentSha256, documents }) => ({
        generation,
        intentSha256,
        documents: new Map(documents),
      })),
    );

  const activeIntentWitness = (): Effect.Effect<
    ActiveIntentWitness,
    CanvasError
  > =>
    readActive("canvas.active-intent-witness").pipe(
      Effect.flatMap((snapshot) => Effect.try({
        try: () => intentWitnessFromSnapshot(snapshot), catch: toCanvasError,
      })),
    );

  const liveDocuments = (): Effect.Effect<
    ReadonlyArray<{ readonly canvasName: string; readonly doc: CanvasDoc }>,
    CanvasError
  > =>
    readActive("canvas.live-documents").pipe(
      Effect.map((snapshot) =>
        [...snapshot.documents]
          .map(([canvasName, entry]) => ({
            canvasName,
            doc: entry.doc,
          }))
          .sort((a, b) => a.canvasName.localeCompare(b.canvasName)),
      ),
    );

  const liveAuthorityGeneration = (): Effect.Effect<string, CanvasError> =>
    authoritySnapshot().pipe(Effect.map((snapshot) => snapshot.generation));

  const activeActorRefs = (): Effect.Effect<
    ReadonlyArray<ActorRef>,
    CanvasError
  > =>
    readActive("canvas.active-actor-refs").pipe(
      Effect.map((snapshot) => snapshot.actorRefs),
    );

  return CanvasesService.of({
    doctor: ensureReady.pipe(
      Effect.flatMap(() => readAuthority("canvas.doctor")),
      Effect.match({
        onFailure: (error) => ({
          id: "canvases",
          label: "Canvas Documents",
          status: "error" as const,
          detail: error.message,
        }),
        onSuccess: (snapshot) => ({
          id: "canvases",
          label: "Canvas Documents",
          status: "ok" as const,
          detail: `${state.info.path} - gen ${snapshot.generation}`,
        }),
      }),
    ),
    announceInstalledProjection: (changes) => {
      for (const change of changes) {
        try {
          notifyListeners(canvasNameFrom(change.name), change.detail);
        } catch {
          // Installed projection names are system-owned; skip corrupt rows.
        }
      }
    },
    list,
    read,
    readWithIntentWitness,
    readNodeStructure,
    write,
    mutate,
    mutatePortfolio,
    canvasOverseerSet,
    create,
    remove,
    ensureSeed,
    writeSidecar,
    start,
    subscribeChanges,
    liveDocuments,
    liveAuthorityGeneration,
    authoritySnapshot,
    authorityMaterialSnapshot,
    activeIntentWitness,
    activeActorRefs,
  });
  }),
).pipe(Layer.provide(Layer.mergeAll(CanvasRecordsLive, CanvasEntitySync.layer, WorkProjectionReaderLive)));
