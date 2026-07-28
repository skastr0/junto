import { createHash } from "node:crypto";
import { Context, Effect, Either, Layer, Schema } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import {
  applyMirrorLaw,
  containsWorkProjection,
  decodeCanvasDoc,
  serializeCanvas,
  type CanvasDoc,
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
  stripWorkProjection,
} from "./work/repository";
import { decodeStationPortfolioBody } from "./station/portfolio";
import { selectStationConfiguration } from "./station/configuration-state";
import {
  removeCanvasProjectionSidecars,
  writeCanvasProjectionSidecar,
} from "./canvas-control/sidecars";

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

/** One transactionally coherent view of the protected document authority. */
export type CanvasAuthoritySnapshot = {
  readonly generation: string;
  readonly documents: ReadonlyMap<string, CanvasDoc>;
};

export class CanvasesService extends Context.Tag("@vellum/CanvasesService")<
  CanvasesService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly list: Effect.Effect<ReadonlyArray<CanvasSummary>, CanvasError>;
    readonly read: (name: string) => Effect.Effect<CanvasReadResult, CanvasError>;
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
    /** Snapshot of live authority docs for process-bind caller resolution. */
    readonly liveDocuments: () => Effect.Effect<
      ReadonlyArray<{ readonly canvasName: string; readonly doc: CanvasDoc }>,
      CanvasError
    >;
    /**
     * Last committed canvas-authority generation as a decimal string.
     * Projection frames must stamp this (not wall-clock) so CC and Remote
     * share one generation identity for the live document set.
     */
    readonly liveAuthorityGeneration: () => Effect.Effect<string, CanvasError>;
    /** Generation and documents read in one SQLite snapshot. */
    readonly authoritySnapshot: () => Effect.Effect<
      CanvasAuthoritySnapshot,
      CanvasError
    >;
  }
>() {}

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
  if (Either.isLeft(decoded)) {
    throw new CanvasError({
      message: `${canvasLabel(name)} in the database failed validation: ${decoded.left.message}`,
    });
  }
  return { doc: decoded.right, body, revision, modifiedAt };
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

const readStationProjection = (
  reader: StateReader,
): StoredAuthoritySnapshot => {
  const row = reader.get<StationProjectionRow>(
    `SELECT
       generation,
       body,
       content_sha256,
       created_at,
       received_at
     FROM station_projection
     WHERE singleton = 1`,
  );
  if (row === undefined) {
    return {
      hasHead: false,
      generation: "0",
      createdAt: undefined,
      intentSha256: undefined,
      documents: new Map(),
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
  };
};

const readActivePortfolio = (
  reader: StateReader,
): StoredAuthoritySnapshot =>
  readLocalStationRole(reader) === "remote"
    ? readStationProjection(reader)
    : readStoredAuthority(reader);

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

const normalizeCanvas = (
  name: CanvasName,
  doc: CanvasDoc,
  modifiedAt: string,
  operation: string,
): StoredCanvas => {
  const decoded = decodeCanvasDoc(stripWorkProjection(doc));
  if (Either.isLeft(decoded)) {
    throw new CanvasError({
      message: `cannot ${operation} ${canvasLabel(name)}: ${decoded.left.message}`,
    });
  }
  const nextDoc = applyMirrorLaw(decoded.right);
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
    }

  });

  const ensureReady: Effect.Effect<void, CanvasError> = Effect.tryPromise({
    try: () => {
      if (bootstrapPromise === undefined) {
        bootstrapPromise = Effect.runPromise(bootstrap);
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
  ): Effect.Effect<StoredAuthoritySnapshot, CanvasError> =>
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

  const read = (name: string): Effect.Effect<CanvasReadResult, CanvasError> =>
    Effect.gen(function* () {
      const canonicalName = yield* Effect.try({
        try: () => canvasNameFrom(name),
        catch: toCanvasError,
      });
      const snapshot = yield* readActive("canvas.read");
      const entry = snapshot.documents.get(canonicalName);
      if (entry === undefined) {
        return yield* Effect.fail(
          new CanvasError({
            message: `canvas "${canonicalName}" is not in the active portfolio`,
          }),
        );
      }
      const workSnapshots = yield* work
        .snapshotsForCanvas(canonicalName)
        .pipe(Effect.mapError(toCanvasError));
      return {
        name: canonicalName,
        doc: projectWorkSnapshots(entry.doc, workSnapshots),
        revision: entry.revision,
      };
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
        return entry;
      });
      yield* Effect.sync(() =>
        notifyListeners(canonicalName, {
          previous: undefined,
          next: outcome.doc,
        }),
      );
      return {
        name: canonicalName,
        doc: outcome.doc,
        revision: outcome.revision,
      };
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
    void Effect.runPromise(ensureReady).catch((error) => {
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
      Effect.map((snapshot) => ({
        generation: snapshot.generation,
        documents: new Map(
          [...snapshot.documents].map(([name, entry]) => [name, entry.doc]),
        ),
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
          detail: `${state.info.path} · gen ${snapshot.generation}`,
        }),
      }),
    ),
    list,
    read,
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
  });
  }),
);
