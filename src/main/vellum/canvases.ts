import { Context, Effect, Result, Layer, Schema } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import {
  applyMirrorLaw,
  containsWorkProjection,
  decodeCanvasDoc,
  serializeCanvas,
  type CanvasDoc,
  type CanvasNode,
} from "@shared/canvas";
import type { CanvasReadResult, CanvasSummary, CanvasWriteResult } from "@shared/ipc";
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
 * `VELLUM_PERF=1` probe rolls read cost up by this tag so the driver of a
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
  | "kernel.hydrateDoc"
  | "kernel.resyncDoc"
  | "kernel.wakeManagedSeat"
  | "nodeRef.resolve"
  | "region.rollup"
  | "term.seatPlan"
  | "untagged"
  | "work.control"
  | "work.service";

export class CanvasesService extends Context.Service<CanvasesService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly list: Effect.Effect<ReadonlyArray<CanvasSummary>, CanvasError>;
    /**
     * `tag` names the caller for the `VELLUM_PERF=1` probe only. It never
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
    // Transactional RMW against the current full-map generation.
    readonly mutate: (
      name: string,
      fn: (doc: CanvasDoc) => CanvasDoc,
    ) => Effect.Effect<void, CanvasError>;
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
      names: ReadonlyArray<string>,
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
  }>()("@vellum/CanvasesService") {}

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
  | "seed";

type CommitOutcome = {
  readonly generation: string;
  readonly changed: boolean;
};

const HEAD_SQL = `
  SELECT
    h.generation AS generation,
    g.created_at AS created_at,
    g.intent_sha256 AS intent_sha256,
    g.document_count AS document_count
  FROM canvas_head h
  JOIN canvas_generations g ON g.generation = h.generation
  WHERE h.singleton = 1
`;

const DOCUMENTS_SQL = `
  SELECT name, body, sha256, modified_at
  FROM canvas_generation_documents
  WHERE generation = ?
  ORDER BY name
`;

const decodeStoredCanvas = (
  name: CanvasName,
  body: string,
  expectedSha256: string,
  modifiedAt: string,
): StoredCanvas => {
  const revisionSha256 = canvasBodySha256Of(body);
  if (revisionSha256 !== expectedSha256) {
    throw new CanvasError({
      message: `canvas database body hash mismatch: ${canvasLabel(name)}`,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new CanvasError({
      message: `${canvasLabel(name)} in the database is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
  if (containsWorkProjection(parsed)) {
    throw new CanvasError({
      message:
        `${canvasLabel(name)} in the database contains runtime work projection data; ` +
        "authorial canvas rows must contain structure and intent only",
    });
  }
  const decoded = decodeCanvasDoc(parsed);
  if (Result.isFailure(decoded)) {
    throw new CanvasError({
      message: `${canvasLabel(name)} in the database failed validation: ${decoded.failure.message}`,
    });
  }
  return { doc: decoded.success, body, revisionSha256, modifiedAt };
};

const readStoredAuthority = (reader: StateReader): StoredAuthoritySnapshot => {
  const head = reader.get<{
    readonly generation: string;
    readonly created_at: string;
    readonly intent_sha256: string;
    readonly document_count: number;
  }>(HEAD_SQL);
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
  for (const row of reader.all<{
    readonly name: string;
    readonly body: string;
    readonly sha256: string;
    readonly modified_at: string;
  }>(DOCUMENTS_SQL, [head.generation])) {
    const name = canvasNameFrom(row.name);
    if (name !== row.name || documents.has(name)) {
      throw new CanvasError({
        message: `canvas database contains a non-canonical or duplicate name: "${row.name}"`,
      });
    }
    documents.set(
      name,
      decodeStoredCanvas(name, row.body, row.sha256, row.modified_at),
    );
  }
  if (documents.size !== Number(head.document_count)) {
    throw new CanvasError({
      message:
        `canvas generation ${head.generation} expected ${head.document_count} documents ` +
        `but loaded ${documents.size}`,
    });
  }
  const intentSha256 = intentSha256Of(documents);
  if (intentSha256 !== head.intent_sha256) {
    throw new CanvasError({
      message: `canvas generation ${head.generation} intent hash mismatch`,
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

const readCommandCenterPortfolio = (
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
 * - Command Center: local role, the authority head (generation, the intent
 *   hash the head row records, its created_at and document_count) and the
 *   placement topology the actor-seat compiler consumes. Documents are pinned
 *   by generation because generation rows are append-only — `write`/`mutate`/
 *   `create`/`remove`/`ensureSeed` all insert a NEW generation and move the
 *   head; nothing rewrites the rows of a generation the head already points
 *   at. The only DELETE against canvas_head/canvas_generations lives in the
 *   Remote configure transaction (station/repository.ts), which sets the role
 *   to "remote" in that same transaction, so the role field of this identity
 *   moves with it and the reset can never read back as an unchanged key.
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
  const head = reader.get<{
    readonly generation: string;
    readonly created_at: string;
    readonly intent_sha256: string;
    readonly document_count: number;
  }>(HEAD_SQL);
  const topology = [...readCommandCenterTopology(reader)]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hostId, installationId]) => `${hostId}${installationId}`)
    .join("");
  return [
    role === "" ? "unconfigured" : role,
    head?.generation ?? "none",
    head?.intent_sha256 ?? "none",
    head?.created_at ?? "none",
    String(head?.document_count ?? 0),
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
        // at the counter value this memo already read. `VELLUM_COMMAND_WORLD=0`
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

const insertFullGeneration = (
  writer: StateWriter,
  generation: string,
  createdAt: string,
  cause: CanvasCommitCause,
  documents: ReadonlyMap<string, StoredCanvas>,
): void => {
  const intentSha256 = intentSha256Of(documents);
  writer.run(
    `INSERT INTO canvas_generations(
      generation, created_at, cause, intent_sha256, document_count
    ) VALUES (?, ?, ?, ?, ?)`,
    [generation, createdAt, cause, intentSha256, documents.size],
  );
  for (const [name, entry] of [...documents].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    writer.run(
      `INSERT INTO canvas_generation_documents(
        generation, name, body, sha256, modified_at
      ) VALUES (?, ?, ?, ?, ?)`,
      [generation, name, entry.body, entry.revisionSha256, entry.modifiedAt],
    );
  }
  writer.run(
    `INSERT INTO canvas_head(singleton, generation)
     VALUES (1, ?)
     ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation`,
    [generation],
  );
};

/**
 * How many authorial generations keep their document bodies.
 *
 * Every content-changing commit appends a full copy of every document and
 * nothing ever removed one, so the log grew without bound at ~46KB per canvas
 * write: the operator's live database had reached 1,257 generations holding
 * 57.5MB of bodies inside a 100.7MB file. This window is what turns that
 * append-only log into a compacted one.
 *
 * 256 because outside the head the window is pure forensics. Every
 * behavioural read of a document body resolves through canvas_head —
 * readStoredAuthority here, readCanvasWorkProjection and the pad's
 * inbound-actor index in work/repository.ts, the v5-to-v6 backfill in
 * state/migrations.ts — so nothing reads an older body, and the window only
 * has to outlast a human looking backwards. Against the operator's measured
 * history (1,257 commits over three weeks, busiest day 309) that is roughly a
 * day of heavy authoring, and at the measured 46KB average it bounds the
 * compacted log near 12MB instead of an unbounded 57.5MB and climbing.
 */
export const CANVAS_GENERATION_BODY_RETENTION = 256;

/**
 * Most generations one sweep may compact.
 *
 * The cap only governs catch-up on a log that has already overshot; in steady
 * state the slack below lets at most 64 generations fall out of the window
 * between sweeps, so it is never reached. Measured at ~0.2ms per generation on
 * the operator's database, a full batch is ~26ms and the 833 generations that
 * had accumulated there clear in 7 sweeps.
 */
export const CANVAS_GENERATION_COMPACTION_BATCH = 128;

/**
 * Document rows of growth tolerated before the next sweep.
 *
 * The gate that runs on every commit is one `count(*)` (8.5us measured); the
 * mark scan behind it costs several milliseconds, so it must not run per
 * commit. Slack turns it into one sweep per 64 rows of growth, which amortizes
 * to well under the append it rides on.
 */
export const CANVAS_GENERATION_COMPACTION_SLACK = 64;

/**
 * Log compaction for the authorial generation log.
 *
 * The ledger itself (`canvas_generations`: when, why, which intent hash) is
 * never pruned — those rows are ~100 bytes each, they are what `work_facts`
 * holds a foreign key to, and deleting one costs 5.2ms because
 * `work_facts.basis_authorial_generation` has no index behind its RESTRICT.
 * What is compacted is the payload: `canvas_generation_documents` bodies
 * outside the retention window. Nothing references that table, so a sweep
 * cannot orphan anything and costs ~0.2ms per generation.
 *
 * Mark set, in the shape content/gc.ts uses (build the protected set first,
 * then sweep what it does not cover):
 *   - the head generation, which readStoredAuthority reconstructs on every
 *     read and whose document_count it verifies
 *   - every generation a work fact is founded on, which the
 *     `work_fact_authorial_basis_resolves` trigger requires to resolve to a
 *     document row
 *
 * Crash safety: one DELETE inside the caller's transaction. A partial sweep is
 * impossible — SQLite either applies the statement or does not — and the head
 * is in the mark set, so no interleaving can leave it without a body.
 */
const compactCanvasGenerationBodies = (
  writer: StateWriter,
  retention: number,
  batch: number,
): number => {
  // `retention` and `batch` count GENERATIONS; the return counts document rows.
  const marked = new Set<string>();
  const head = writer.get<{ readonly generation: string }>(
    "SELECT generation FROM canvas_head WHERE singleton = 1",
  );
  if (head !== undefined) marked.add(head.generation);
  for (const row of writer.all<{ readonly generation: string }>(
    `
      SELECT DISTINCT basis_authorial_generation AS generation
      FROM work_facts
      WHERE basis_authorial_generation IS NOT NULL
    `,
  )) {
    marked.add(row.generation);
  }

  // Generation is canonical decimal TEXT, so age ordering needs the cast.
  const victims: string[] = [];
  for (const row of writer.all<{ readonly generation: string }>(
    `
      SELECT generation
      FROM canvas_generation_documents
      GROUP BY generation
      ORDER BY CAST(generation AS INTEGER) DESC
      LIMIT -1 OFFSET ?
    `,
    [retention],
  )) {
    if (marked.has(row.generation)) continue;
    victims.push(row.generation);
    if (victims.length >= batch) break;
  }
  if (victims.length === 0) return 0;

  // Rows, not generations: a full map holds one row per canvas, and the gate
  // above counts rows, so the caller's high-water mark has to be paid in the
  // same unit it was read in.
  const swept = writer.run(
    `
      DELETE FROM canvas_generation_documents
      WHERE generation IN (${victims.map(() => "?").join(", ")})
    `,
    victims,
  );
  return Number(swept.changes ?? 0);
};

/**
 * High-water gate in front of the sweep.
 *
 * The sweep's mark scan is ~3.5ms, far too much to pay on every commit, so it
 * hides behind one `count(*)` and a remembered post-sweep level: nothing runs
 * again until the log has grown SLACK commits past where the last sweep left
 * it. Process-local by design — a fresh launch starting at "never swept" just
 * means the first content-changing commit of the session pays one sweep.
 */
const makeGenerationCompactor = (options: {
  readonly retention?: number;
  readonly batch?: number;
  readonly slack?: number;
} = {}) => {
  const retention = options.retention ?? CANVAS_GENERATION_BODY_RETENTION;
  const batch = options.batch ?? CANVAS_GENERATION_COMPACTION_BATCH;
  const slack = options.slack ?? CANVAS_GENERATION_COMPACTION_SLACK;
  let sweptAt: number | undefined;
  return {
    afterCommit: (writer: StateWriter): number => {
      const bodies = Number(
        writer.get<{ readonly count: number }>(
          "SELECT count(*) AS count FROM canvas_generation_documents",
        )?.count ?? 0,
      );
      if (sweptAt !== undefined && bodies < sweptAt + slack) return 0;
      const sweptRows = compactCanvasGenerationBodies(writer, retention, batch);
      sweptAt = bodies - sweptRows;
      return sweptRows;
    },
  };
};

/** The compaction handle a commit carries, so every cause shares one gate. */
type GenerationCompactor = ReturnType<typeof makeGenerationCompactor>;

const commitFullGeneration = (
  writer: StateWriter,
  previous: StoredAuthoritySnapshot,
  documents: ReadonlyMap<string, StoredCanvas>,
  cause: CanvasCommitCause,
  options: {
    readonly generation?: string;
    readonly createdAt?: string;
    readonly compactor?: GenerationCompactor;
  } = {},
): CommitOutcome => {
  const intentSha256 = intentSha256Of(documents);
  if (
    previous.hasHead &&
    previous.intentSha256 === intentSha256 &&
    previous.documents.size === documents.size
  ) {
    return { generation: previous.generation, changed: false };
  }
  const generation = options.generation ?? nextGenerationAfter(previous);
  insertFullGeneration(
    writer,
    generation,
    options.createdAt ?? new Date().toISOString(),
    cause,
    documents,
  );
  // Every append goes through here, so the retention window has exactly one
  // seam to defend regardless of which cause grew the log.
  options.compactor?.afterCommit(writer);
  return { generation, changed: true };
};

/**
 * Remove runtime work overlays at the protected authorial boundary.
 *
 * WorkRepository owns the overlay mechanism; Canvases owns the inverse
 * boundary because no repository-private document transform may be required
 * to make authorial persistence safe.
 *
 * `ether.tasks.stationName` and `ether.tasks.contract` are operator-authored
 * document truth, so they survive the strip while projected rows beside them
 * do not. `items` stays present-and-empty because WorkTasks requires it.
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
      requests: _requests,
      messages: _messages,
      artifacts: _artifacts,
      board: _board,
      pad: _pad,
      ...rest
    } = etherIn;
    const contract = strippedTasks?.contract;
    const nativeTaskTitle =
      node.type === "text" &&
      etherIn.entity?.kind === "task" &&
      (strippedTasks?.items?.length ?? 0) === 0
        ? node.text.split("\n")[0]?.replace(/^#+\s*/, "").trim()
        : undefined;
    const stationName =
      strippedTasks?.stationName?.trim() ||
      (nativeTaskTitle && !/^(?:task|tasks)$/i.test(nativeTaskTitle)
        ? nativeTaskTitle
        : undefined);
    const ether = contract === undefined && stationName === undefined
      ? rest
      : {
          ...rest,
          tasks: {
            items: [],
            ...(stationName ? { stationName } : {}),
            ...(contract ? { contract } : {}),
          },
        };
    const kind = ether.entity?.kind;
    const text =
      node.type !== "text"
        ? undefined
        : kind === "task"
          ? mirrorTasksText([])
          : kind === "requests"
            ? mirrorRequestsText([])
            : kind === "artifacts"
              ? mirrorArtifactsText([])
              : kind === "board"
                ? mirrorBoardText([])
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
    // One retention gate for the whole installation: every canvas commit
    // appends to the same generation log, so one high-water mark governs it.
    const generationCompactor = makeGenerationCompactor();

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
    const status = yield* state
      .read("canvas.bootstrap.status", (reader) => ({
        hasHead:
          reader.get<{ readonly generation: string }>(
            "SELECT generation FROM canvas_head WHERE singleton = 1",
          ) !== undefined,
        generations: Number(
          reader.get<{ readonly count: number }>(
            "SELECT count(*) AS count FROM canvas_generations",
          )?.count ?? 0,
        ),
      }))
      .pipe(Effect.mapError(toCanvasError));

    if (!status.hasHead) {
      if (status.generations > 0) {
        return yield* Effect.fail(
          new CanvasError({
            message:
              "canvas database head is missing while generation rows exist; recovery required",
          }),
        );
      }
      // Clean cutover: an empty database is a fresh installation. Derivative
      // projection outputs are deliberately never consulted or imported.
      return;
    }

    // Heal registry gaps when active membership diverges from the head doc
    // (incomplete v5→v6 backfill, wiped rows). Skip when already aligned so
    // every launch does not rewrite entity rows. Remote has no authorial
    // registry duty — projection is membership.
    yield* state
      .transaction("canvas.entity-reconcile", (writer) => {
        if (readLocalStationRole(writer) === "remote") return;
        const now = new Date().toISOString();
        const snapshot = readStoredAuthority(writer);
        for (const [name, entry] of snapshot.documents) {
          const activeIds = new Set(
            writer
              .all<{ readonly entity_id: string }>(
                `
                  SELECT entity_id
                  FROM canvas_entities
                  WHERE canvas_name = ?
                    AND lifecycle = 'active'
                `,
                [name],
              )
              .map((row) => row.entity_id),
          );
          const nodeIds = entry.doc.nodes.map((node) => node.id);
          const aligned =
            activeIds.size === nodeIds.length &&
            nodeIds.every((id) => activeIds.has(id));
          if (aligned) continue;
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
            // VELLUM_PERF=1 only. The probe brackets the synchronous body, so
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
        const modifiedAt = new Date().toISOString();
        const candidate = normalizeCanvas(
          canonicalName,
          doc,
          modifiedAt,
          "write",
        );
        const nextEntry =
          candidate.revisionSha256 === previous?.revisionSha256
            ? { ...candidate, modifiedAt: previous.modifiedAt }
            : candidate;
        const documents = new Map(current.documents);
        documents.set(canonicalName, nextEntry);
        const commit = commitFullGeneration(
          writer,
          current,
          documents,
          "write",
          { compactor: generationCompactor },
        );
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
          proposed,
          new Date().toISOString(),
          "mutate",
        );
        const nextEntry =
          candidate.revisionSha256 === previous.revisionSha256
            ? { ...candidate, modifiedAt: previous.modifiedAt }
            : candidate;
        const documents = new Map(current.documents);
        documents.set(canonicalName, nextEntry);
        const commit = commitFullGeneration(
          writer,
          current,
          documents,
          "mutate",
          { compactor: generationCompactor },
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

  const create = (name: string): Effect.Effect<CanvasReadResult, CanvasError> =>
    Effect.gen(function* () {
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
        commitFullGeneration(writer, current, documents, "create", {
          compactor: generationCompactor,
        });
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
        commitFullGeneration(writer, current, documents, "remove", {
          compactor: generationCompactor,
        });
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

  const ensureSeed: Effect.Effect<void, CanvasError> = transaction(
    "canvas.seed",
    (writer) => {
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
      const commit = commitFullGeneration(
        writer,
        current,
        documents,
        "seed",
        { compactor: generationCompactor },
      );
      if (commit.changed) {
        syncCanvasEntities(writer, name, entry.doc, entry.modifiedAt);
      }
      return commit.changed ? { name, entry } : undefined;
    },
  ).pipe(
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
    announceInstalledProjection: (names) => {
      if (names.length === 0) {
        // Empty name is the bulk invalidation signal for projection installs.
        notifyListeners("" as CanvasName);
        return;
      }
      for (const name of names) {
        try {
          notifyListeners(canvasNameFrom(name));
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
