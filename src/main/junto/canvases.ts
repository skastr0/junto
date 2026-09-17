import { Context, Effect, Option, Result, Layer, Schema } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import {
  applyMirrorLaw,
  containsWorkProjection,
  decodeCanvasDoc,
  serializeCanvas,
  type CanvasDoc,
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
import {
  CANVAS_NAME_INPUT_PATTERN,
  CANVAS_NAME_MAX_LENGTH,
} from "@shared/canvas-name";
import { SEED_CANVAS_NAME } from "@shared/seed";
import {
  StateEngine,
  type StateReader,
  type StateWriter,
} from "./state/service";
import {
  WorkRepository,
  projectWorkSnapshots,
  readCanvasWorkProjection,
  readCanvasWorkRevision,
  type CanvasWorkProjection,
} from "./work/repository";
import { makeWorkWorld, workWorldEnabled, type WorkWorld } from "./work/world";
import { decodeStationPortfolioBody } from "./station/portfolio";
import { selectStationConfiguration } from "./station/configuration-state";
import {
  compileActorSeatRegistry,
  type ProjectedActorSeat,
} from "./station/actor-seat-compiler";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "@shared/installation-id";
import { StationHostId } from "@shared/station-api";
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
import { perfProbe, perfProbeEnabled } from "./observability/perf-probe";
import { withinBudget } from "./observability/main-thread-budget";
import {
  archiveAllCanvasEntities,
  syncCanvasEntities,
} from "./entities/sync";
import {
  deleteCanvas,
  persistCanvas,
  readDocumentRows,
  readPortfolioHead,
  reconstructCanvasDoc,
  writePortfolioHead,
} from "./canvas/records";
import {
  canvasBodySha256Of,
  intentSha256Of,
  type StoredCanvasIntentDocument,
} from "./canvas-intent-identity";

export class CanvasError extends Schema.TaggedError<CanvasError>()("CanvasError", {
  message: Schema.String,
}) {}

declare const canvasNameBrand: unique symbol;
/** A canonical canvas name minted at the SQLite document boundary. */
export type CanvasName = string & { readonly [canvasNameBrand]: "CanvasName" };

/**
 * Canonicalize the human-facing spelling used by the existing UI, then refuse
 * anything which is not one ASCII basename. This is deliberately stricter
 * than path normalization: traversal, separators, dot files, Unicode lookalikes
 * and encoded separators are data, never paths.
 */
export const canvasNameFrom = (raw: string): CanvasName => {
  const trimmed = raw.trim();
  if (!CANVAS_NAME_INPUT_PATTERN.test(trimmed)) {
    throw new CanvasError({
      message: `invalid canvas name "${raw}": use at most ${CANVAS_NAME_MAX_LENGTH} ASCII letters, numbers, hyphens, and underscores`,
    });
  }
  return trimmed.toLowerCase() as CanvasName;
};

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
 * Some callers only ask structural questions of a single node — which seat
 * does it bind to (`deliveryTargetOf`), is that seat paused (`seatPaused`,
 * which needs group geometry). Neither question reads a work lane, so neither
 * may pay for one: `canvases.read` materializes every sink's tasks, messages,
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
 * Caller identity for one `canvases.read`. Instrumentation only: the
 * `JUNTO_PERF=1` probe rolls read cost up by this tag so the driver of a
 * main-thread block is measured rather than inferred. Closed union so a new
 * call site cannot land untagged.
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
  | "kernel.wakeManagedSeat"
  | "nodeRef.resolve"
  | "region.rollup"
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
     * `tag` names the caller for the `JUNTO_PERF=1` probe only. It never
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
      tag?: CanvasReadTag,
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

const toCanvasError = (error: unknown): CanvasError =>
  error instanceof CanvasError
    ? error
    : new CanvasError({ message: error instanceof Error ? error.message : String(error) });

const canvasLabel = (name: CanvasName) => `canvas "${name}"`;

type StoredCanvas = {
  readonly doc: CanvasDoc;
  readonly body: string;
  readonly revisionSha256: string;
  readonly modifiedAt: string;
};

type StoredAuthoritySnapshot = {
  readonly hasHead: boolean;
  readonly generation: string;
  readonly createdAt: string | undefined;
  readonly intentSha256: string | undefined;
  readonly documents: ReadonlyMap<string, StoredCanvas>;
};

type ActivePortfolioSnapshot = StoredAuthoritySnapshot & {
  readonly actorRefs: ReadonlyArray<ActorRef>;
};

type StationProjectionRow = {
  readonly generation: string;
  readonly body: string;
  readonly content_sha256: string;
  readonly created_at: string;
  readonly received_at: string;
};

type CanvasCommitCause =
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

/**
 * Read the relational canvas authority: portfolio head + document rows +
 * reconstructed documents. The serialized JSON Canvas body is DERIVED here —
 * it exists in memory as the export/identity codec, never on disk. Each
 * reconstructed document must reproduce its stored revision hash, and the
 * portfolio must reproduce the stored intent hash, or the read fails closed.
 */
const readStoredAuthority = (reader: StateReader): StoredAuthoritySnapshot => {
  const head = readPortfolioHead(reader);
  if (head === undefined) {
    return {
      hasHead: false,
      generation: "0",
      createdAt: undefined,
      intentSha256: undefined,
      documents: new Map(),
    };
  }

  const documents = new Map<string, StoredCanvas>();
  for (const row of readDocumentRows(reader)) {
    const name = canvasNameFrom(row.canvas_name);
    if (name !== row.canvas_name || documents.has(name)) {
      throw new CanvasError({
        message: `canvas database contains a non-canonical or duplicate name: "${row.canvas_name}"`,
      });
    }
    let doc: CanvasDoc;
    try {
      doc = reconstructCanvasDoc(reader, row.canvas_id);
    } catch (error) {
      throw new CanvasError({
        message: `${canvasLabel(name)} failed relational reconstruction: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
    if (containsWorkProjection(doc)) {
      throw new CanvasError({
        message:
          `${canvasLabel(name)} in the database contains runtime work projection data; ` +
          "authorial canvas rows must contain structure and intent only",
      });
    }
    const body = serializeCanvas(doc);
    const revisionSha256 = canvasBodySha256Of(body);
    if (revisionSha256 !== row.revision_sha256) {
      throw new CanvasError({
        message: `canvas database revision hash mismatch: ${canvasLabel(name)}`,
      });
    }
    documents.set(name, { doc, body, revisionSha256, modifiedAt: row.modified_at });
  }
  const intentSha256 = intentSha256Of(documents);
  if (intentSha256 !== head.intent_sha256) {
    throw new CanvasError({
      message: `canvas portfolio generation ${head.generation} intent hash mismatch`,
    });
  }
  return {
    hasHead: true,
    generation: head.generation,
    createdAt: head.created_at,
    intentSha256,
    documents,
  };
};

type LocalStationRole = "" | "command-center" | "remote";

/**
 * Read the local installation role from canonical SQLite state.
 *
 * Absence is the explicit pre-configuration state. Any malformed present row
 * fails closed rather than being reinterpreted through another store.
 */
const readLocalStationRole = (reader: StateReader): LocalStationRole => {
  try {
    return selectStationConfiguration(reader)?.configuration.role ?? "";
  } catch (error) {
    throw new CanvasError({
      message:
        `canonical station configuration is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
    });
  }
};

const decodeInstallationId = Schema.decodeUnknownSync(InstallationId);
const decodeStationHostId = Schema.decodeUnknownSync(StationHostId);

const actorRefsFromSeats = (
  actorSeats: ReadonlyArray<ProjectedActorSeat>,
): ReadonlyArray<ActorRef> =>
  actorSeats.flatMap((seat) =>
    seat.refs.map((ref) => ({
      seatId: seat.seatId,
      canvasName: ref.canvasName,
      nodeId: ref.nodeId,
    }))
  );

const installTopologyBinding = (
  topology: Map<string, InstallationIdValue>,
  hostId: string,
  installationId: InstallationIdValue,
): void => {
  const established = topology.get(hostId);
  if (established !== undefined && established !== installationId) {
    throw new CanvasError({
      message:
        `active Station topology maps host ${JSON.stringify(hostId)} to ` +
        "more than one installation",
    });
  }
  topology.set(hostId, installationId);
};

/**
 * Read the complete placement topology needed by the deterministic actor-seat
 * compiler. This stays in the same StateEngine read as the canvas generation
 * so a CanvasReadResult never combines documents with a separately sampled
 * fleet map.
 */
const readCommandCenterTopology = (
  reader: StateReader,
): ReadonlyMap<string, InstallationIdValue> => {
  const topology = new Map<string, InstallationIdValue>();
  const configuration = selectStationConfiguration(reader)?.configuration;
  if (configuration?.role === "command-center") {
    const local = reader.get<{ readonly installation_id: string }>(
      `SELECT installation_id
       FROM station_installation
       WHERE singleton = 1`,
    );
    if (local === undefined) {
      throw new CanvasError({
        message:
          "Command Center configuration exists without a local installation identity",
      });
    }
    installTopologyBinding(
      topology,
      configuration.hostId,
      decodeInstallationId(local.installation_id),
    );
  }

  for (const row of reader.all<{
    readonly host_id: string;
    readonly station_installation_id: string;
  }>(
    `SELECT host_id, station_installation_id
     FROM station_fleet_targets
     WHERE retired_at IS NULL
     ORDER BY host_id`,
  )) {
    installTopologyBinding(
      topology,
      decodeStationHostId(row.host_id),
      decodeInstallationId(row.station_installation_id),
    );
  }
  return topology;
};

export const readCommandCenterPortfolio = (
  reader: StateReader,
): ActivePortfolioSnapshot => {
  const snapshot = readStoredAuthority(reader);
  const documents = new Map(
    [...snapshot.documents].map(([name, entry]) => [name, entry.doc]),
  );
  const actorSeats = compileActorSeatRegistry(
    documents,
    readCommandCenterTopology(reader),
  );
  return {
    ...snapshot,
    actorRefs: actorRefsFromSeats(actorSeats),
  };
};

const readStationProjection = (
  reader: StateReader,
): ActivePortfolioSnapshot => {
  const row = reader.get<StationProjectionRow>(
    `SELECT
       version.generation AS generation,
       version.body AS body,
       version.content_sha256 AS content_sha256,
       version.created_at AS created_at,
       version.received_at AS received_at
     FROM station_projection_head head
     JOIN station_projection_versions version
       ON version.generation = head.generation
      AND version.content_sha256 = head.content_sha256
     WHERE head.singleton = 1`,
  );
  if (row === undefined) {
    return {
      hasHead: false,
      generation: "0",
      createdAt: undefined,
      intentSha256: undefined,
      documents: new Map(),
      actorRefs: [],
    };
  }
  const contentSha256 = canvasBodySha256Of(row.body);
  if (contentSha256 !== row.content_sha256) {
    throw new CanvasError({
      message:
        `station projection generation ${row.generation} failed its content hash`,
    });
  }
  const decoded = decodeStationPortfolioBody(row.body);
  const documents = new Map<string, StoredCanvas>();
  for (const [name, doc] of decoded.documents) {
    const canonicalName = canvasNameFrom(name);
    const body = serializeCanvas(doc);
    documents.set(canonicalName, {
      doc,
      body,
      revisionSha256: canvasBodySha256Of(body),
      modifiedAt: row.received_at,
    });
  }
  return {
    hasHead: true,
    generation: row.generation,
    createdAt: row.created_at,
    intentSha256: contentSha256,
    documents,
    actorRefs: actorRefsFromSeats(decoded.actorSeats),
  };
};

const readActivePortfolio = (
  reader: StateReader,
): ActivePortfolioSnapshot =>
  readLocalStationRole(reader) === "remote"
    ? readStationProjection(reader)
    : readCommandCenterPortfolio(reader);

/**
 * Field separator for the identity string. NUL cannot appear in a hash, a
 * decimal generation, a timestamp or a canonical host/installation id, so no
 * combination of field values can collide by re-parsing across a boundary.
 */
const SEPARATOR = "\u0000";

/**
 * Cheap, complete identity of everything `readActivePortfolio` derives from.
 *
 * Two-branch, exactly like the read it guards:
 *
 * - Command Center: local role, the portfolio head (generation, intent hash,
 *   updated_at) and the placement topology the actor-seat compiler consumes.
 *   Documents are pinned by the intent hash: it is recomputed from every
 *   canvas's revision hash on each commit, so no row of any canvas can change
 *   without moving it. The only whole-plane wipe is the Remote configure
 *   transaction (station/repository.ts), which sets the role to "remote" in
 *   that same transaction, so the role field of this identity moves with it
 *   and the reset can never read back as an unchanged key.
 * - Remote: local role plus the projection head's generation, content hash and
 *   received_at. The body is pinned by its own content hash.
 *
 * Cost is four small point lookups plus the fleet-target rows, which the
 * uncached read pays anyway. A field that is absent from this string is a
 * field that may be served stale, so nothing that reaches a CanvasReadResult
 * may be left out of it.
 */
const readActivePortfolioIdentity = (reader: StateReader): string => {
  const role = readLocalStationRole(reader);
  if (role === "remote") {
    const head = reader.get<{
      readonly generation: string;
      readonly content_sha256: string;
      readonly received_at: string;
    }>(
      `SELECT version.generation AS generation,
              version.content_sha256 AS content_sha256,
              version.received_at AS received_at
       FROM station_projection_head head
       JOIN station_projection_versions version
         ON version.generation = head.generation
        AND version.content_sha256 = head.content_sha256
       WHERE head.singleton = 1`,
    );
    return head === undefined
      ? ["remote", "none"].join(SEPARATOR)
      : [
          "remote",
          head.generation,
          head.content_sha256,
          head.received_at,
        ].join(SEPARATOR);
  }
  const head = readPortfolioHead(reader);
  const topology = [...readCommandCenterTopology(reader)]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hostId, installationId]) => `${hostId}${installationId}`)
    .join("");
  return [
    role === "" ? "unconfigured" : role,
    head?.generation ?? "none",
    head?.intent_sha256 ?? "none",
    head?.updated_at ?? "none",
    topology,
  ].join(SEPARATOR);
};

/**
 * Memoize the active portfolio over that identity.
 *
 * Pure memo: a miss calls `readActivePortfolio` unchanged, so the rebuilt
 * snapshot — including its document hash validation and document_count check —
 * is byte-identical to the uncached read. A hit skips JSON.parse, schema
 * decode and sha256 of every canvas body plus the actor-seat compile, which is
 * the whole cost of a read once the Work projection is also memoized.
 *
 * One slot: the portfolio is installation-wide, so a second slot could only
 * hold a superseded generation nobody may be served.
 *
 * The returned reader must never be handed a StateWriter. Inside a transaction
 * the identity probe sees uncommitted rows, and a rolled-back transaction
 * would leave the memo holding state that never existed. Write paths keep
 * calling `readStoredAuthority`/`readActivePortfolio` directly.
 */
type IdentifiedPortfolio = {
  readonly identity: string;
  readonly snapshot: ActivePortfolioSnapshot;
};

const makeActivePortfolioReader = (): ((
  reader: StateReader,
) => IdentifiedPortfolio) => {
  let cached: IdentifiedPortfolio | undefined;
  return (reader) => {
    const identity = readActivePortfolioIdentity(reader);
    if (cached !== undefined && cached.identity === identity) return cached;
    cached = { identity, snapshot: readActivePortfolio(reader) };
    return cached;
  };
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

const makeWorkProjectionCache = (world: WorkWorld | undefined) => {
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
    projectedDoc: (
      reader: StateReader,
      name: CanvasName,
      authorialDoc: CanvasDoc,
      portfolioIdentity: string,
    ): { readonly doc: CanvasDoc; readonly workRevision: string } => {
      const workRevision = readCanvasWorkRevision(reader, name);
      const cached = entries.get(name);
      let entry: WorkProjectionCacheEntry;
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
        const projection =
          world === undefined
            ? readCanvasWorkProjection(reader, name)
            : world.projection(reader, name, workRevision);
        entry = { workRevision: projection.workRevision, projection };
      }
      if (entry.projected?.portfolioIdentity !== portfolioIdentity) {
        entry.projected = {
          portfolioIdentity,
          doc: projectWorkSnapshots(authorialDoc, entry.projection.snapshots),
        };
      }
      touch(name, entry);
      return { doc: entry.projected.doc, workRevision: entry.workRevision };
    },
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

const assertAuthorialInstallation = (
  reader: StateReader,
  operation: string,
): void => {
  if (readLocalStationRole(reader) === "remote") {
    throw new CanvasError({
      message:
        `cannot ${operation}: Remote installations consume Command Center projection and never author canvases`,
    });
  }
};

const nextGenerationAfter = (snapshot: StoredAuthoritySnapshot): string =>
  snapshot.hasHead ? (BigInt(snapshot.generation) + 1n).toString() : "1";

/**
 * Authorial commits must compile as a live Command Center portfolio. Writes
 * that would make later read/list/liveDocuments fail stay uncommitted.
 */
const assertAuthorialCandidatePortfolio = (
  reader: StateReader,
  documents: ReadonlyMap<string, StoredCanvas>,
): void => {
  const docs = new Map<string, CanvasDoc>();
  for (const [name, entry] of documents) docs.set(name, entry.doc);
  try {
    compileActorSeatRegistry(docs, readCommandCenterTopology(reader));
  } catch (error) {
    throw error instanceof CanvasError
      ? error
      : new CanvasError({
          message: `cannot commit authorial portfolio: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
  }
};

/**
 * Commit the portfolio delta: upsert changed canvases' rows, delete removed
 * canvases' rows, advance the singleton head. Only canvases whose revision
 * hash moved are touched — an unchanged canvas costs nothing.
 */
const commitPortfolio = (
  writer: StateWriter,
  previous: StoredAuthoritySnapshot,
  documents: ReadonlyMap<string, StoredCanvas>,
  _cause: CanvasCommitCause,
): CommitOutcome => {
  assertAuthorialCandidatePortfolio(writer, documents);
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
    if (!documents.has(name)) deleteCanvas(writer, name);
  }
  for (const [name, entry] of documents) {
    const prior = previous.documents.get(name);
    if (prior !== undefined && prior.revisionSha256 === entry.revisionSha256) {
      continue;
    }
    persistCanvas(writer, {
      canvasName: name,
      doc: entry.doc,
      revisionSha256: entry.revisionSha256,
      modifiedAt: entry.modifiedAt,
    });
  }
  writePortfolioHead(writer, { generation, intentSha256, at: createdAt });
  return { generation, changed: true };
};

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

const normalizeCanvas = (
  name: CanvasName,
  doc: CanvasDoc,
  modifiedAt: string,
  operation: string,
): StoredCanvas => {
  const decoded = decodeCanvasDoc(stripRuntimeWorkProjection(doc));
  if (Result.isFailure(decoded)) {
    throw new CanvasError({
      message: `cannot ${operation} ${canvasLabel(name)}: ${decoded.failure.message}`,
    });
  }
  const nextDoc = applyMirrorLaw(decoded.success);
  const body = serializeCanvas(nextDoc);
  return {
    doc: nextDoc,
    body,
    revisionSha256: canvasBodySha256Of(body),
    modifiedAt,
  };
};

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

const normalizePortfolioDocuments = (
  previous: StoredAuthoritySnapshot,
  proposed: ReadonlyMap<string, CanvasDoc>,
  modifiedAt: string,
  operation: string,
  preserveIncomingOverseer: boolean,
): Map<string, StoredCanvas> => {
  const documents = new Map<string, StoredCanvas>();
  for (const [rawName, incoming] of proposed) {
    const name = canvasNameFrom(rawName);
    const prior = previous.documents.get(name);
    const reconciled = preserveIncomingOverseer
      ? incoming
      : reconcileOverseerGrants(prior?.doc ?? { nodes: [], edges: [] }, incoming);
    const candidate = normalizeCanvas(name, reconciled, modifiedAt, operation);
    const nextEntry =
      prior !== undefined && candidate.revisionSha256 === prior.revisionSha256
        ? { ...candidate, modifiedAt: prior.modifiedAt }
        : candidate;
    documents.set(name, nextEntry);
  }
  return documents;
};

export const CanvasesLive = Layer.effect(
  CanvasesService,
  Effect.gen(function* () {
    const state = yield* StateEngine;
    const work = yield* WorkRepository;
    const runtime = yield* Effect.context<never>();
    const listeners = new Set<
      (name: string, detail?: CanvasChangeDetail) => void
    >();
    let bootstrapPromise: Promise<void> | undefined;
    // Per-installation, not module-level: a second StateEngine in the same
    // process (tests, recovery) must never see another database's memo.
    const activePortfolio = makeActivePortfolioReader();
    // The in-memory factory world, per installation for the same reason the
    // portfolio memo is: a second StateEngine in this process must never be
    // served another database's sinks.
    const world = workWorldEnabled ? makeWorkWorld() : undefined;
    if (world !== undefined) {
      yield* Effect.addFinalizer(() => Effect.sync(() => world.close()));
    }
    const workProjections = makeWorkProjectionCache(world);

  const notifyListeners = (
    name: CanvasName | string,
    detail?: CanvasChangeDetail,
  ): void => {
    for (const listener of listeners) {
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
    const stationRole = yield* state
      .read("canvas.bootstrap.station-role", readLocalStationRole)
      .pipe(Effect.mapError(toCanvasError));
    if (stationRole === "remote") return;

    const status = yield* state
      .read("canvas.bootstrap.status", (reader) => ({
        hasHead:
          reader.get<{ readonly generation: string }>(
            "SELECT generation FROM canvas_portfolio_head WHERE singleton = 1",
          ) !== undefined,
        documents: Number(
          reader.get<{ readonly count: number }>(
            "SELECT count(*) AS count FROM canvas_documents",
          )?.count ?? 0,
        ),
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

    // Heal registry gaps when active membership diverges from the head doc
    // (incomplete v5→v6 backfill, wiped rows). An exact empty source has no
    // active authorial membership, so archive active rows while preserving the
    // archived/soft-deleted identity ledger. Missing-head nonempty history was
    // refused above and never reaches reconciliation.
    yield* state
      .transaction("canvas.entity-reconcile", (writer) => {
        // Close a serialized configure race after the startup role guard.
        if (readLocalStationRole(writer) === "remote") return;
        const now = new Date().toISOString();
        const activeCanvasNames = new Set(
          writer
            .all<{ readonly canvas_name: string }>(
              `
                SELECT DISTINCT canvas_name
                FROM canvas_entities
                WHERE lifecycle = 'active'
              `,
            )
            .map((row) => row.canvas_name),
        );
        if (!status.hasHead) {
          for (const canvasName of activeCanvasNames) {
            archiveAllCanvasEntities(writer, canvasName, now);
          }
          return;
        }

        const snapshot = readStoredAuthority(writer);
        for (const canvasName of activeCanvasNames) {
          if (!snapshot.documents.has(canvasName)) {
            archiveAllCanvasEntities(writer, canvasName, now);
          }
        }
        for (const [name, entry] of snapshot.documents) {
          // syncCanvasEntities already reads the full lifecycle/kind/binding
          // view once and writes only its dirty set. An ID-only shortcut would
          // miss same-ID provenance drift and is not a safe alignment proof.
          syncCanvasEntities(writer, name, entry.doc, now);
        }
      })
      .pipe(Effect.mapError(toCanvasError));

  });

  const ensureReady: Effect.Effect<void, CanvasError> = Effect.tryPromise({
    try: () => {
      if (bootstrapPromise === undefined) {
        bootstrapPromise = Effect.runPromiseWith(runtime)(bootstrap);
      }
      return bootstrapPromise;
    },
    catch: toCanvasError,
  });

  const readAuthority = (
    operation: string,
  ): Effect.Effect<StoredAuthoritySnapshot, CanvasError> =>
    ensureReady.pipe(
      Effect.flatMap(() =>
        state.read(operation, readStoredAuthority).pipe(
          Effect.mapError(toCanvasError),
        ),
      ),
    );

  const readActive = (
    operation: string,
  ): Effect.Effect<ActivePortfolioSnapshot, CanvasError> =>
    ensureReady.pipe(
      Effect.flatMap(() =>
        state
          .read(operation, (reader) => activePortfolio(reader).snapshot)
          .pipe(Effect.mapError(toCanvasError)),
      ),
    );

  const transaction = <A>(
    operation: string,
    body: (writer: StateWriter) => A,
  ): Effect.Effect<A, CanvasError> =>
    ensureReady.pipe(
      Effect.flatMap(() =>
        state.transaction(operation, (writer) => {
          assertAuthorialInstallation(writer, operation);
          return body(writer);
        }).pipe(
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

  const readWithIntentWitness = (
    name: string,
    tag: CanvasReadTag = "untagged",
  ): Effect.Effect<CanvasReadWithIntentWitness, CanvasError> =>
    Effect.gen(function* () {
      const canonicalName = yield* Effect.try({
        try: () => canvasNameFrom(name),
        catch: toCanvasError,
      });
      yield* ensureReady;
      return yield* state
        .read("canvas.read", (reader) =>
          // The whole body is one synchronous main-thread block, so it is
          // also where the 4ms invariant is asserted. Armed in dev only;
          // disarmed it calls straight through.
          withinBudget("canvas.read", () => {
            // JUNTO_PERF=1 only. The probe brackets the synchronous body, so
            // the recorded duration is the real main-thread block. Off, this is
            // one constant boolean test per read.
            const probe = perfProbeEnabled ? perfProbe?.beginRead(tag) : undefined;
            const { identity, snapshot } = activePortfolio(reader);
            const entry = snapshot.documents.get(canonicalName);
            if (entry === undefined) {
              throw new CanvasError({
                message: `canvas "${canonicalName}" is not in the active portfolio`,
              });
            }
            const projected = workProjections.projectedDoc(
              reader,
              canonicalName,
              entry.doc,
              identity,
            );
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
              intentWitness: intentWitnessFromSnapshot(snapshot),
            };
            if (probe !== undefined) perfProbe?.endRead(probe, result.read.doc);
            return result;
          }, tag),
        )
        .pipe(Effect.mapError(toCanvasError));
    });

  const read = (
    name: string,
    tag: CanvasReadTag = "untagged",
  ): Effect.Effect<CanvasReadResult, CanvasError> =>
    readWithIntentWitness(name, tag).pipe(
      Effect.map(({ read }) => read),
    );

  const readNodeStructure = (
    name: string,
    nodeId: string,
    tag: CanvasReadTag = "untagged",
  ): Effect.Effect<CanvasNodeStructure | undefined, CanvasError> =>
    Effect.gen(function* () {
      const canonicalName = yield* Effect.try({
        try: () => canvasNameFrom(name),
        catch: toCanvasError,
      });
      yield* ensureReady;
      return yield* state
        .read("canvas.readNodeStructure", (reader) => {
          const probe = perfProbeEnabled ? perfProbe?.beginRead(tag) : undefined;
          // Same authority snapshot `read` resolves against, so a caller that
          // routes on this node sees exactly the document the last commit
          // published — never a lagging renderer projection. What is skipped
          // is only `readCanvasWorkProjection` + `projectWorkSnapshots`, which
          // add work lanes and touch no structural field.
          const { snapshot } = activePortfolio(reader);
          const entry = snapshot.documents.get(canonicalName);
          if (entry === undefined) {
            throw new CanvasError({
              message: `canvas "${canonicalName}" is not in the active portfolio`,
            });
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
          if (probe !== undefined) perfProbe?.endRead(probe, result?.node);
          return result;
        })
        .pipe(Effect.mapError(toCanvasError));
    });

  const write = (
    name: string,
    doc: CanvasDoc,
    expectedRevision?: string,
  ): Effect.Effect<CanvasWriteResult, CanvasError> =>
    Effect.gen(function* () {
      yield* ensureReady;
      const canonicalName = yield* Effect.try({
        try: () => canvasNameFrom(name),
        catch: toCanvasError,
      });
      const outcome = yield* transaction("canvas.write", (writer) => {
        const current = readStoredAuthority(writer);
        const previous = current.documents.get(canonicalName);
        if (
          expectedRevision !== undefined &&
          (previous === undefined ||
            previous.revisionSha256 !== expectedRevision)
        ) {
          throw new CanvasError({
            message: `${canvasLabel(canonicalName)} revision conflict; reload before saving`,
          });
        }
        const candidate = normalizeCanvas(
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
        const commit = commitPortfolio(writer, current, documents, "write");
        if (commit.changed || previous === undefined) {
          syncCanvasEntities(
            writer,
            canonicalName,
            nextEntry.doc,
            nextEntry.modifiedAt,
          );
        }
        return { commit, previous, nextEntry };
      });
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

  const mutate = (
    name: string,
    fn: (doc: CanvasDoc) => CanvasDoc,
  ): Effect.Effect<void, CanvasError> =>
    Effect.gen(function* () {
      yield* ensureReady;
      const canonicalName = yield* Effect.try({
        try: () => canvasNameFrom(name),
        catch: toCanvasError,
      });
      const outcome = yield* transaction("canvas.mutate", (writer) => {
        const current = readStoredAuthority(writer);
        const previous = current.documents.get(canonicalName);
        if (previous === undefined) {
          throw new CanvasError({
            message: `canvas "${canonicalName}" does not exist in SQLite authority`,
          });
        }
        const proposed = fn(previous.doc);
        const candidate = normalizeCanvas(
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
        const commit = commitPortfolio(
          writer,
          current,
          documents,
          "mutate",
        );
        if (commit.changed) {
          syncCanvasEntities(
            writer,
            canonicalName,
            nextEntry.doc,
            nextEntry.modifiedAt,
          );
        }
        return { commit, previous, nextEntry };
      });
      if (outcome.commit.changed) {
        yield* Effect.sync(() =>
          notifyListeners(canonicalName, {
            previous: outcome.previous.doc,
            next: outcome.nextEntry.doc,
          }),
        );
      }
    });

  const mutatePortfolio = <A>(
    fn: (current: CanvasPortfolioView) => CanvasPortfolioEdit<A>,
  ): Effect.Effect<CanvasPortfolioCommit<A>, CanvasError | WorkErrorBody> =>
    Effect.gen(function* () {
      yield* ensureReady;
      const outcome = yield* transaction("canvas.mutatePortfolio", (writer) => {
        const current = readStoredAuthority(writer);
        const edit = fn(storedDocumentsView(current));
        if (!edit.ok) return { kind: "rejected" as const, error: edit.error };
        const modifiedAt = new Date().toISOString();
        const nextDocuments = normalizePortfolioDocuments(
          current,
          edit.mutation.documents,
          modifiedAt,
          "mutate",
          false,
        );
        const commit = commitPortfolio(
          writer,
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
              syncCanvasEntities(writer, name, entry.doc, entry.modifiedAt);
            }
          }
          for (const name of current.documents.keys()) {
            if (!nextDocuments.has(name)) {
              archiveAllCanvasEntities(writer, name, modifiedAt);
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
      });
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

  const canvasOverseerSet = (
    input: CanvasOverseerSetInput,
  ): Effect.Effect<CanvasOverseerSetResult, CanvasError> =>
    Effect.gen(function* () {
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
      const outcome = yield* transaction("canvas.overseerSet", (writer) => {
        const current = readStoredAuthority(writer);
        const previous = current.documents.get(canonicalName);
        if (
          previous === undefined ||
          previous.revisionSha256 !== input.expectedRevision
        ) {
          throw new CanvasError({
            message: `${canvasLabel(canonicalName)} revision conflict; reload before saving`,
          });
        }
        const node = previous.doc.nodes.find(
          (candidate) => candidate.id === input.nodeId,
        );
        if (node === undefined) {
          throw new CanvasError({
            message: `node "${input.nodeId}" is not on ${canvasLabel(canonicalName)}`,
          });
        }
        if (!isManagedAgentNode(node)) {
          throw new CanvasError({
            message: `node "${input.nodeId}" is not a managed agent seat`,
          });
        }
        const seat = nodeSeatBinding(node);
        if (seat === undefined) {
          throw new CanvasError({
            message: `node "${input.nodeId}" is missing host/binding identity`,
          });
        }
        const view = storedDocumentsView(current);
        const proposed = setBindingOverseer(
          view.documents,
          seat,
          input.overseer,
        );
        const modifiedAt = new Date().toISOString();
        const nextDocuments = normalizePortfolioDocuments(
          current,
          proposed,
          modifiedAt,
          "overseer",
          true,
        );
        const commit = commitPortfolio(
          writer,
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
              syncCanvasEntities(writer, name, entry.doc, entry.modifiedAt);
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
      });
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

  const create = (name: string): Effect.Effect<CanvasReadResult, CanvasError> =>
    Effect.gen(function* () {
      yield* ensureReady;
      const canonicalName = yield* Effect.try({
        try: () => canvasNameFrom(name),
        catch: toCanvasError,
      });
      const outcome = yield* transaction("canvas.create", (writer) => {
        const current = readStoredAuthority(writer);
        if (current.documents.has(canonicalName)) {
          throw new CanvasError({
            message: `canvas "${canonicalName}" already exists`,
          });
        }
        const entry = normalizeCanvas(
          canonicalName,
          { nodes: [], edges: [] },
          new Date().toISOString(),
          "create",
        );
        const documents = new Map(current.documents);
        documents.set(canonicalName, entry);
        commitPortfolio(writer, current, documents, "create");
        syncCanvasEntities(
          writer,
          canonicalName,
          entry.doc,
          entry.modifiedAt,
        );
        return entry;
      });
      yield* Effect.sync(() =>
        notifyListeners(canonicalName, {
          previous: undefined,
          next: outcome.doc,
        }),
      );
      return yield* read(canonicalName);
    });

  const remove = (name: string): Effect.Effect<{ name: string }, CanvasError> =>
    Effect.gen(function* () {
      yield* ensureReady;
      const canonicalName = yield* Effect.try({
        try: () => canvasNameFrom(name),
        catch: toCanvasError,
      });
      const previous = yield* transaction("canvas.remove", (writer) => {
        const current = readStoredAuthority(writer);
        const entry = current.documents.get(canonicalName);
        if (entry === undefined) {
          throw new CanvasError({
            message: `canvas "${canonicalName}" does not exist`,
          });
        }
        const documents = new Map(current.documents);
        documents.delete(canonicalName);
        commitPortfolio(writer, current, documents, "remove");
        archiveAllCanvasEntities(
          writer,
          canonicalName,
          new Date().toISOString(),
        );
        return entry;
      });
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
      transaction("canvas.seed", (writer) => {
        const current = readStoredAuthority(writer);
        if (current.documents.size > 0) return undefined;
        const name = canvasNameFrom(SEED_CANVAS_NAME);
        const entry = normalizeCanvas(
          name,
          { nodes: [], edges: [] },
          new Date().toISOString(),
          "seed",
        );
        const documents = new Map(current.documents);
        documents.set(name, entry);
        const commit = commitPortfolio(
          writer,
          current,
          documents,
          "seed",
        );
        if (commit.changed) {
          syncCanvasEntities(writer, name, entry.doc, entry.modifiedAt);
        }
        return commit.changed ? { name, entry } : undefined;
      }),
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
      Effect.map(intentWitnessFromSnapshot),
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
);
