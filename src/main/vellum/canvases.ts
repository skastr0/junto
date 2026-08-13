import { createHash } from "node:crypto";
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
} from "./work/repository";
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
} from "@shared/task";
import {
  removeCanvasProjectionSidecars,
  writeCanvasProjectionSidecar,
} from "./canvas-control/sidecars";
import {
  archiveAllCanvasEntities,
  syncCanvasEntities,
} from "./entities/sync";

export class CanvasError extends Schema.TaggedErrorClass<CanvasError>()("CanvasError", {
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

/** One transactionally coherent view of the protected document authority. */
export type CanvasAuthoritySnapshot = {
  readonly generation: string;
  readonly intentSha256: string;
  readonly documents: ReadonlyMap<string, CanvasDoc>;
};

export type ActiveIntentWitness = {
  readonly generation: string;
  readonly contentSha256: string;
};

export type CanvasReadWithIntentWitness = {
  readonly read: CanvasReadResult;
  readonly intentWitness: ActiveIntentWitness;
};

export class CanvasesService extends Context.Service<CanvasesService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly list: Effect.Effect<ReadonlyArray<CanvasSummary>, CanvasError>;
    readonly read: (name: string) => Effect.Effect<CanvasReadResult, CanvasError>;
    readonly readWithIntentWitness: (
      name: string,
    ) => Effect.Effect<CanvasReadWithIntentWitness, CanvasError>;
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
    /** Generation and documents read in one SQLite snapshot. */
    readonly authoritySnapshot: () => Effect.Effect<
      CanvasAuthoritySnapshot,
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
  readonly revision: string;
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

const revisionOf = (raw: string): string =>
  createHash("sha256").update(raw, "utf8").digest("hex");

const intentSha256Of = (
  documents: ReadonlyMap<string, StoredCanvas>,
): string => {
  const hash = createHash("sha256");
  for (const [name, entry] of [...documents].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    hash.update(String(Buffer.byteLength(name, "utf8")));
    hash.update("\0");
    hash.update(name, "utf8");
    hash.update("\0");
    hash.update(entry.revision, "ascii");
    hash.update("\0");
  }
  return hash.digest("hex");
};

const decodeStoredCanvas = (
  name: CanvasName,
  body: string,
  expectedSha256: string,
  modifiedAt: string,
): StoredCanvas => {
  const revision = revisionOf(body);
  if (revision !== expectedSha256) {
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
  return { doc: decoded.success, body, revision, modifiedAt };
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
  const contentSha256 = revisionOf(row.body);
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
      revision: revisionOf(body),
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
      [generation, name, entry.body, entry.revision, entry.modifiedAt],
    );
  }
  writer.run(
    `INSERT INTO canvas_head(singleton, generation)
     VALUES (1, ?)
     ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation`,
    [generation],
  );
};

const commitFullGeneration = (
  writer: StateWriter,
  previous: StoredAuthoritySnapshot,
  documents: ReadonlyMap<string, StoredCanvas>,
  cause: CanvasCommitCause,
  options: {
    readonly generation?: string;
    readonly createdAt?: string;
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
  return { generation, changed: true };
};

/**
 * Remove runtime work overlays at the protected authorial boundary.
 *
 * WorkRepository owns the overlay mechanism; Canvases owns the inverse
 * boundary because no repository-private document transform may be required
 * to make authorial persistence safe.
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
        etherIn.board === undefined
      )
    ) {
      return node;
    }

    const {
      tasks: _tasks,
      requests: _requests,
      messages: _messages,
      artifacts: _artifacts,
      board: _board,
      ...ether
    } = etherIn;
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
    revision: revisionOf(body),
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

  const notifyListeners = (
    name: CanvasName,
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
        state.read(operation, readActivePortfolio).pipe(
          Effect.mapError(toCanvasError),
        ),
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
  ): Effect.Effect<CanvasReadWithIntentWitness, CanvasError> =>
    Effect.gen(function* () {
      const canonicalName = yield* Effect.try({
        try: () => canvasNameFrom(name),
        catch: toCanvasError,
      });
      yield* ensureReady;
      return yield* state
        .read("canvas.read", (reader) => {
          const snapshot = readActivePortfolio(reader);
          const entry = snapshot.documents.get(canonicalName);
          if (entry === undefined) {
            throw new CanvasError({
              message: `canvas "${canonicalName}" is not in the active portfolio`,
            });
          }
          const projection = readCanvasWorkProjection(
            reader,
            canonicalName,
          );
          return {
            read: {
              name: canonicalName,
              doc: projectWorkSnapshots(
                entry.doc,
                projection.snapshots,
              ),
              actorRefs: snapshot.actorRefs.filter(
                (actor) => actor.canvasName === canonicalName,
              ),
              revision: entry.revision,
              workRevision: projection.workRevision,
            },
            intentWitness: intentWitnessFromSnapshot(snapshot),
          };
        })
        .pipe(Effect.mapError(toCanvasError));
    });

  const read = (
    name: string,
  ): Effect.Effect<CanvasReadResult, CanvasError> =>
    readWithIntentWitness(name).pipe(
      Effect.map(({ read }) => read),
    );

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
          (previous === undefined || previous.revision !== expectedRevision)
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
          candidate.revision === previous?.revision
            ? { ...candidate, modifiedAt: previous.modifiedAt }
            : candidate;
        const documents = new Map(current.documents);
        documents.set(canonicalName, nextEntry);
        const commit = commitFullGeneration(
          writer,
          current,
          documents,
          "write",
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
      return { revision: outcome.nextEntry.revision };
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
          candidate.revision === previous.revision
            ? { ...candidate, modifiedAt: previous.modifiedAt }
            : candidate;
        const documents = new Map(current.documents);
        documents.set(canonicalName, nextEntry);
        const commit = commitFullGeneration(
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
        commitFullGeneration(writer, current, documents, "create");
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
        commitFullGeneration(writer, current, documents, "remove");
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
      yield* Effect.sync(() =>
        notifyListeners(canonicalName, {
          previous: previous.doc,
          next: undefined,
        }),
      );
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

  const authoritySnapshot = (): Effect.Effect<
    CanvasAuthoritySnapshot,
    CanvasError
  > =>
    readAuthority("canvas.authority-snapshot").pipe(
      Effect.flatMap((snapshot) =>
        snapshot.hasHead && snapshot.intentSha256 !== undefined
          ? Effect.succeed({
              generation: snapshot.generation,
              intentSha256: snapshot.intentSha256,
              documents: new Map(
                [...snapshot.documents].map(([name, entry]) => [
                  name,
                  entry.doc,
                ]),
              ),
            })
          : Effect.fail(
              new CanvasError({
                message:
                  "cannot read canvas authority snapshot without an active authorial head",
              }),
            )
      ),
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
        notifyListeners("");
        return;
      }
      for (const name of names) notifyListeners(name);
    },
    list,
    read,
    readWithIntentWitness,
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
    activeIntentWitness,
    activeActorRefs,
  });
  }),
);
