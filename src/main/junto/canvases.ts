import { Context, Effect, Layer } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import type { CanvasOverseerSetInput, CanvasOverseerSetResult, CanvasReadResult, CanvasSummary, CanvasWriteResult } from "@shared/ipc";
import type { WorkErrorBody } from "@shared/work-control";
import type { ActorRef } from "@shared/work-protocol";
import type { StoredCanvasIntentDocument } from "./canvas-intent-identity";
import { WorkProjectionReaderLive } from "./work/repository";
import { ModelLive } from "./model/layer";
import { makeModelCanvases } from "./model/canvases";
import { CanvasError } from "./canvas/domain";
export { CanvasError, canvasNameFrom, type CanvasName } from "./canvas/domain";

// Temporary method facade over per-kind storage; callers migrate to ModelService.

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
  readonly intentWitness: ActiveIntentWitness & { readonly canvasName: string; readonly seq: number };
};

/**
 * One authorial node, read WITHOUT building the canvas work projection.
 *
 * Some callers only ask structural questions of a single node, such as which
 * seat it binds to (`deliveryTargetOf`). Such a question reads no work lane,
 * so it may not pay for one: `canvases.read` materializes every sink's tasks,
 * requests, artifacts, board and pad to answer them, which is the entire
 * factory for one `nodes.find`.
 *
 * `structure` is the AUTHORIAL document. `ether.tasks`, `ether.requests`,
 * `ether.artifacts`, `ether.board` and `ether.pad` are
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
  | "ipc.canvasDigest"
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

export const CanvasesLive = Layer.effect(CanvasesService, makeModelCanvases).pipe(
  Layer.provideMerge(ModelLive),
  Layer.provide(WorkProjectionReaderLive),
);
