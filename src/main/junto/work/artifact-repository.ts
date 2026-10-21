/**
 * Artifact storage and the local ruler for artifact commands (plan 05 on 02).
 *
 * Until the editing machine's command channel lands, this machine is the
 * editing machine: `submit` rules a command with the shared artifact domain
 * and writes its ruling, the new head and the new version in one
 * transaction, the ruling in the shared `resource_rulings`. A command already ruled (same writer, same opId) returns its
 * first ruling and writes nothing.
 *
 * Reads never see a body they do not ask for: list reads heads, show reads
 * one version row, history reads versions without bodies.
 */

import { Context, Effect, Layer, Option, Result, Schema } from "effect";
import { SqlClient, SqlError, SqlSchema } from "effect/unstable/sql";
import {
  type Artifact,
  type ArtifactActor,
  type ArtifactBody,
  type ArtifactEdit,
  type ArtifactOp,
  type ArtifactType,
  type ArtifactVersion,
  decodeArtifact,
  decodeArtifactBody,
  decodeArtifactEdit,
} from "@shared/artifact";
import {
  ARTIFACT_REBASE_WINDOW,
  type ArtifactEntry,
  type ArtifactFact,
  type ArtifactState,
  artifactDomain,
} from "@shared/artifact-domain";
import type { InstallationId } from "@shared/installation-id";
import type { NodeId } from "@shared/physics/schema";
import {
  type ResourceActor,
  type ResourceCommand,
  type ResourceRuling,
  type RulingContext,
  type CommandKey,
  ResourceActor as ResourceActorSchema,
  commandKey,
  rule,
} from "@shared/resource-command";
import type { WorkErrorBody } from "@shared/work-control";
import type { ItemId, OpId } from "@shared/work-ids";
import { StateTransactionOperation } from "../state/service";

export class ArtifactPersistenceError extends Schema.TaggedError<ArtifactPersistenceError>()(
  "ArtifactPersistenceError",
  { operation: Schema.String, message: Schema.String, cause: Schema.Unknown },
) {}

/** A head as stored, decoded. */
export type ArtifactHeadRead = { readonly artifact: Artifact; readonly body: ArtifactBody };

export type ArtifactVersionRead = {
  readonly version: ArtifactVersion;
  readonly author: ArtifactActor;
  readonly at: number;
  /** Absent on version 1, the create. */
  readonly edit?: ArtifactEdit;
};

export type ArtifactListQuery = {
  readonly nodeIds: ReadonlyArray<NodeId>;
  readonly type?: ArtifactType;
  readonly archived: boolean;
  readonly limit: number;
};

/**
 * A command's outcome as the ruler stored it. A replay returns the same
 * outcome; the facts of the first ruling are not kept here, only what they
 * made.
 */
export type ArtifactSubmitOutcome =
  | {
      readonly kind: "applied";
      readonly opId: OpId;
      readonly artifactId: ItemId;
      readonly version: ArtifactVersion;
      /** The facts this ruling applied; empty when a retry is answered from the stored ruling. */
      readonly facts: ReadonlyArray<ArtifactFact>;
    }
  | { readonly kind: "refused"; readonly opId: OpId; readonly error: WorkErrorBody; readonly root: OpId };

export class ArtifactRepository extends Context.Service<ArtifactRepository,
  {
    /** Heads on the given nodes, newest change first; `more` when the limit cut the list. */
    readonly list: (
      canvasName: string,
      query: ArtifactListQuery,
    ) => Effect.Effect<{ readonly artifacts: ReadonlyArray<Artifact>; readonly more: boolean }, ArtifactPersistenceError>;
    /** The head and its body. */
    readonly head: (canvasName: string, artifactId: ItemId) => Effect.Effect<Option.Option<ArtifactHeadRead>, ArtifactPersistenceError>;
    /** One version's body. */
    readonly body: (
      canvasName: string,
      artifactId: ItemId,
      version: ArtifactVersion,
    ) => Effect.Effect<Option.Option<ArtifactBody>, ArtifactPersistenceError>;
    /** Versions newest first, without bodies; `before` pages back. */
    readonly history: (
      canvasName: string,
      artifactId: ItemId,
      page: { readonly limit: number; readonly before?: ArtifactVersion },
    ) => Effect.Effect<{ readonly versions: ReadonlyArray<ArtifactVersionRead>; readonly more: boolean }, ArtifactPersistenceError>;
    /** This machine's installation id: the writer of commands made here. */
    readonly localWriter: () => Effect.Effect<Option.Option<InstallationId>, ArtifactPersistenceError>;
    /** Rule one command here and write what it makes. */
    readonly submit: (
      writer: InstallationId,
      command: ResourceCommand<ArtifactOp>,
      context: RulingContext,
    ) => Effect.Effect<ArtifactSubmitOutcome, ArtifactPersistenceError>;
  }>()("@junto/ArtifactRepository") {}

const HeadRow = Schema.Struct({
  artifact_id: Schema.String,
  node_id: Schema.String,
  type: Schema.String,
  title: Schema.String,
  version: Schema.Number,
  created_by_json: Schema.String,
  updated_at: Schema.Number,
  archived: Schema.Number,
  task_ids_json: Schema.String,
});
type HeadRow = typeof HeadRow.Type;

const VersionRow = Schema.Struct({
  version: Schema.Number,
  author_json: Schema.String,
  at: Schema.Number,
  edit_json: Schema.NullOr(Schema.String),
});
type VersionRow = typeof VersionRow.Type;

const parse = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};

/** A head row as the contract's Artifact, or nothing when the row does not decode. */
export const artifactOfRow = (row: HeadRow): Artifact | undefined => {
  const decoded = decodeArtifact({
    artifactId: row.artifact_id,
    nodeId: row.node_id,
    type: row.type,
    title: row.title,
    version: row.version,
    createdBy: parse(row.created_by_json),
    updatedAt: row.updated_at,
    archived: row.archived === 1,
    taskIds: parse(row.task_ids_json),
  });
  return Result.isSuccess(decoded) ? decoded.success : undefined;
};

const decodeActor = Schema.decodeUnknownResult(ResourceActorSchema);

const versionOfRow = (row: VersionRow): ArtifactVersionRead | undefined => {
  const author = decodeActor(parse(row.author_json));
  if (Result.isFailure(author)) return undefined;
  const base = { version: row.version as ArtifactVersion, author: author.success, at: row.at };
  if (row.edit_json === null) return base;
  const edit = decodeArtifactEdit(parse(row.edit_json));
  return Result.isSuccess(edit) ? { ...base, edit: edit.success } : undefined;
};

const bodyOf = (json: string): ArtifactBody | undefined => {
  const decoded = decodeArtifactBody(parse(json));
  return Result.isSuccess(decoded) ? decoded.success : undefined;
};

/** What the ruler keeps of a ruling: enough to answer a replay. */
const StoredRuling = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("applied"), artifactId: Schema.String, version: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("refused"), error: Schema.Unknown, root: Schema.String }),
]);
const decodeStoredRuling = Schema.decodeUnknownResult(StoredRuling);

/** The artifact a command names: the target item, which the domain requires. */
const targetOf = (command: ResourceCommand<ArtifactOp>): ItemId | undefined => command.target.itemId;

/** The head a ruling made, read back from the facts it applied. */
const outcomeOf = (
  ruling: ResourceRuling<ArtifactFact>,
  after: ArtifactState,
  artifactId: ItemId,
): ArtifactSubmitOutcome => {
  if (ruling.kind === "refused") {
    return { kind: "refused", opId: ruling.opId, error: ruling.error, root: ruling.root };
  }
  const entry = after.get(artifactId);
  // An applied ruling always leaves its artifact in state: every fact names it.
  return { kind: "applied", opId: ruling.opId, artifactId, version: entry!.artifact.version, facts: ruling.facts };
};

const persistence = (operation: string) => (error: SqlError.SqlError | Schema.SchemaError | ArtifactPersistenceError) =>
  error instanceof ArtifactPersistenceError ? error : ArtifactPersistenceError.make({ operation, message: error.message, cause: error });

/** A stored row that no longer decodes: refused loudly, never read as absent and written over. */
const unreadable = (operation: string, what: string) =>
  ArtifactPersistenceError.make({ operation, message: `${what} does not decode`, cause: undefined });

const actorJson = (actor: ResourceActor): string => JSON.stringify(actor);

/**
 * The artifact domain's projection: fold applied facts into `artifact_heads`
 * and `artifact_versions`. The local ruler runs it inside its ruling's
 * transaction; a replica runs it when a received `ruling.applied` carries
 * artifact facts. The caller owns the transaction.
 */
export const projectArtifactFacts = (
  sql: SqlClient.SqlClient,
  canvas: string,
  opId: OpId,
  facts: ReadonlyArray<ArtifactFact>,
): Effect.Effect<void, SqlError.SqlError> =>
  Effect.gen(function* () {
    for (const fact of facts) {
      switch (fact.fact) {
        case "artifact.created": {
          const a = fact.artifact;
          yield* sql`
            INSERT INTO artifact_heads (canvas_name, artifact_id, node_id, type, title, version,
              created_by_json, updated_at, archived, task_ids_json)
            VALUES (${canvas}, ${a.artifactId}, ${a.nodeId}, ${a.type}, ${a.title}, ${a.version},
              ${actorJson(a.createdBy)}, ${a.updatedAt}, ${a.archived ? 1 : 0}, ${JSON.stringify(a.taskIds)})`;
          yield* sql`
            INSERT INTO artifact_versions (canvas_name, artifact_id, version, op_id, author_json, at, edit_json, body_json)
            VALUES (${canvas}, ${a.artifactId}, ${a.version}, ${opId}, ${actorJson(a.createdBy)}, ${a.updatedAt},
              NULL, ${JSON.stringify(fact.body)})`;
          break;
        }
        case "artifact.edited":
          yield* sql`
            INSERT INTO artifact_versions (canvas_name, artifact_id, version, op_id, author_json, at, edit_json, body_json)
            VALUES (${canvas}, ${fact.artifactId}, ${fact.version}, ${opId}, ${actorJson(fact.author)}, ${fact.at},
              ${JSON.stringify(fact.edit)}, ${JSON.stringify(fact.body)})`;
          yield* sql`
            UPDATE artifact_heads SET version = ${fact.version}, updated_at = ${fact.at}
            WHERE canvas_name = ${canvas} AND artifact_id = ${fact.artifactId}`;
          break;
        case "artifact.retitled":
          yield* sql`
            UPDATE artifact_heads SET title = ${fact.title}, updated_at = ${fact.at}
            WHERE canvas_name = ${canvas} AND artifact_id = ${fact.artifactId}`;
          break;
        case "artifact.archived":
          yield* sql`
            UPDATE artifact_heads SET archived = ${fact.archived ? 1 : 0}, updated_at = ${fact.at}
            WHERE canvas_name = ${canvas} AND artifact_id = ${fact.artifactId}`;
          break;
        case "artifact.tasks":
          yield* sql`
            UPDATE artifact_heads SET task_ids_json = ${JSON.stringify(fact.taskIds)}, updated_at = ${fact.at}
            WHERE canvas_name = ${canvas} AND artifact_id = ${fact.artifactId}`;
          break;
      }
    }
  });

export const ArtifactRepositoryLive: Layer.Layer<ArtifactRepository, never, SqlClient.SqlClient> = Layer.effect(
  ArtifactRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const headRow = SqlSchema.findOneOption({
      Request: Schema.Struct({ canvas: Schema.String, id: Schema.String }),
      Result: HeadRow,
      execute: ({ canvas, id }) => sql`
        SELECT artifact_id, node_id, type, title, version, created_by_json, updated_at, archived, task_ids_json
        FROM artifact_heads WHERE canvas_name = ${canvas} AND artifact_id = ${id}`,
    });

    const bodyRow = SqlSchema.findOneOption({
      Request: Schema.Struct({ canvas: Schema.String, id: Schema.String, version: Schema.Number }),
      Result: Schema.Struct({ body_json: Schema.String }),
      execute: ({ canvas, id, version }) => sql`
        SELECT body_json FROM artifact_versions
        WHERE canvas_name = ${canvas} AND artifact_id = ${id} AND version = ${version}`,
    });

    /** The newest edits, newest first, as many as the rebase window keeps. */
    const editRows = SqlSchema.findAll({
      Request: Schema.Struct({ canvas: Schema.String, id: Schema.String }),
      Result: Schema.Struct({ version: Schema.Number, edit_json: Schema.String }),
      execute: ({ canvas, id }) => sql`
        SELECT version, edit_json FROM artifact_versions
        WHERE canvas_name = ${canvas} AND artifact_id = ${id} AND version > 1
        ORDER BY version DESC
        LIMIT ${ARTIFACT_REBASE_WINDOW}`,
    });

    const rulingRow = SqlSchema.findOneOption({
      Request: Schema.Struct({ canvas: Schema.String, writer: Schema.String, opId: Schema.String }),
      Result: Schema.Struct({ ruling_json: Schema.String }),
      execute: ({ canvas, writer, opId }) => sql`
        SELECT ruling_json FROM resource_rulings
        WHERE canvas_name = ${canvas} AND writer = ${writer} AND op_id = ${opId}`,
    });

    const readHead = (canvas: string, id: ItemId) =>
      Effect.gen(function* () {
        const row = yield* headRow({ canvas, id });
        if (Option.isNone(row)) return Option.none<ArtifactHeadRead>();
        const artifact = artifactOfRow(row.value);
        if (artifact === undefined) return yield* unreadable("head", `artifact ${id}`);
        const stored = yield* bodyRow({ canvas, id, version: artifact.version });
        const body = Option.isSome(stored) ? bodyOf(stored.value.body_json) : undefined;
        if (body === undefined) return yield* unreadable("head", `the body of artifact ${id} at version ${artifact.version}`);
        return Option.some({ artifact, body });
      });

    /**
     * The ruler's view of one artifact: head, body and the edits of the
     * rebase window, oldest first. The log stops at the first edit that does
     * not decode or does not follow on, so it never claims a version it lacks;
     * a base past its start is refused stale.
     */
    const readEntry = (canvas: string, id: ItemId) =>
      Effect.gen(function* () {
        const head = yield* readHead(canvas, id);
        if (Option.isNone(head)) return Option.none<ArtifactEntry>();
        const edits: ArtifactEdit[] = [];
        let editsFrom = head.value.artifact.version + 1;
        for (const row of yield* editRows({ canvas, id })) {
          const edit = decodeArtifactEdit(parse(row.edit_json));
          if (Result.isFailure(edit) || row.version !== editsFrom - 1) break;
          edits.unshift(edit.success);
          editsFrom = row.version;
        }
        return Option.some<ArtifactEntry>({ ...head.value, edits, editsFrom });
      });

    /** Earlier rulings a command's `after` names, so a refused root refuses it too. */
    const priorRulings = (canvas: string, writer: InstallationId, command: ResourceCommand<ArtifactOp>) =>
      Effect.gen(function* () {
        const rulings = new Map<CommandKey, ResourceRuling<ArtifactFact>>();
        for (const opId of command.after) {
          const row = yield* rulingRow({ canvas, writer, opId });
          if (Option.isNone(row)) continue;
          const stored = decodeStoredRuling(parse(row.value.ruling_json));
          if (Result.isSuccess(stored) && stored.success.kind === "refused") {
            rulings.set(commandKey(writer, opId), {
              kind: "refused",
              opId,
              error: stored.success.error as WorkErrorBody,
              root: stored.success.root as OpId,
            });
          }
        }
        return rulings;
      });

    const list = Effect.fn("artifacts.list")(function* (canvasName: string, query: ArtifactListQuery) {
      if (query.nodeIds.length === 0) return { artifacts: [], more: false };
      const rows = yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: HeadRow,
        execute: () => sql`
          SELECT artifact_id, node_id, type, title, version, created_by_json, updated_at, archived, task_ids_json
          FROM artifact_heads
          WHERE canvas_name = ${canvasName}
            AND ${sql.in("node_id", query.nodeIds)}
            AND archived = ${query.archived ? 1 : 0}
            ${query.type === undefined ? sql`` : sql`AND type = ${query.type}`}
          ORDER BY updated_at DESC, artifact_id DESC
          LIMIT ${query.limit + 1}`,
      })(undefined);
      const artifacts = rows.slice(0, query.limit).flatMap((row) => artifactOfRow(row) ?? []);
      return { artifacts, more: rows.length > query.limit };
    }, Effect.mapError(persistence("list")));

    const head = Effect.fn("artifacts.head")(function* (canvasName: string, artifactId: ItemId) {
      return yield* readHead(canvasName, artifactId);
    }, Effect.mapError(persistence("head")));

    const body = Effect.fn("artifacts.body")(function* (canvasName: string, artifactId: ItemId, version: ArtifactVersion) {
      const row = yield* bodyRow({ canvas: canvasName, id: artifactId, version });
      return Option.flatMap(row, (found) => Option.fromNullishOr(bodyOf(found.body_json)));
    }, Effect.mapError(persistence("body")));

    const history = Effect.fn("artifacts.history")(function* (
      canvasName: string,
      artifactId: ItemId,
      page: { readonly limit: number; readonly before?: ArtifactVersion },
    ) {
      const rows = yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: VersionRow,
        execute: () => sql`
          SELECT version, author_json, at, edit_json FROM artifact_versions
          WHERE canvas_name = ${canvasName} AND artifact_id = ${artifactId}
            ${page.before === undefined ? sql`` : sql`AND version < ${page.before}`}
          ORDER BY version DESC
          LIMIT ${page.limit + 1}`,
      })(undefined);
      const versions = rows.slice(0, page.limit).flatMap((row) => versionOfRow(row) ?? []);
      return { versions, more: rows.length > page.limit };
    }, Effect.mapError(persistence("history")));

    const submit = Effect.fn("artifacts.submit")(function* (
      writer: InstallationId,
      command: ResourceCommand<ArtifactOp>,
      context: RulingContext,
    ) {
      const canvas = command.canvasName;
      const prior = yield* rulingRow({ canvas, writer, opId: command.opId });
      if (Option.isSome(prior)) {
        const stored = decodeStoredRuling(parse(prior.value.ruling_json));
        if (Result.isSuccess(stored)) {
          return stored.success.kind === "applied"
            ? {
                kind: "applied" as const,
                opId: command.opId,
                artifactId: stored.success.artifactId as ItemId,
                version: stored.success.version as ArtifactVersion,
                facts: [],
              }
            : {
                kind: "refused" as const,
                opId: command.opId,
                error: stored.success.error as WorkErrorBody,
                root: stored.success.root as OpId,
              };
        }
        return yield* unreadable("submit", `the ruling of ${command.opId}`);
      }
      const artifactId = targetOf(command);
      const state = new Map<ItemId, ArtifactEntry>();
      if (artifactId !== undefined) {
        const entry = yield* readEntry(canvas, artifactId);
        if (Option.isSome(entry)) state.set(artifactId, entry.value);
      }
      const rulings = yield* priorRulings(canvas, writer, command);
      const now = Date.now();
      const domain = artifactDomain(() => now);
      const ruled = rule(domain, { state, rulings }, writer, command, context);
      const ruling = ruled.ruling;
      if (ruling.kind === "applied") {
        // The domain refuses a command with no target item, so an applied one always names it.
        if (artifactId === undefined) return yield* Effect.die("an applied artifact ruling names no artifact");
        yield* projectArtifactFacts(sql, canvas, command.opId, ruling.facts);
      }
      const outcome = outcomeOf(ruling, ruled.ruled.state, artifactId as ItemId);
      const stored =
        outcome.kind === "applied"
          ? { kind: "applied", artifactId: outcome.artifactId, version: outcome.version }
          : { kind: "refused", error: outcome.error, root: outcome.root };
      // The ruling and its facts commit together, or neither does.
      yield* sql`
        INSERT INTO resource_rulings (canvas_name, writer, op_id, kind, ruling_json)
        VALUES (${canvas}, ${writer}, ${command.opId}, ${outcome.kind}, ${JSON.stringify(stored)})`;
      return outcome;
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "artifacts.submit"), Effect.mapError(persistence("submit")));

    const installationRow = SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: Schema.Struct({ installation_id: Schema.String }),
      execute: () => sql`SELECT installation_id FROM installation WHERE singleton = 1`,
    });

    const localWriter = Effect.fn("artifacts.localWriter")(function* () {
      const row = yield* installationRow(undefined);
      return Option.map(row, (found) => found.installation_id as InstallationId);
    }, Effect.mapError(persistence("localWriter")));

    return ArtifactRepository.of({ list, head, body, history, localWriter, submit });
  }),
);
