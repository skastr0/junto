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
 *
 * Facts name each version's body by content ref (`artifactBodyRef`). The
 * ruler puts those canonical bytes in the content store under the artifact's
 * ownership and keeps them on the version row too. A replica folds a version
 * whose bytes are still on their way with its ref only: the body is pending
 * (null) until the content store holds it, and the domain refuses an edit on
 * a pending head.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
import { type ContentRef, decodeContentRef } from "@shared/content";
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
  emptyRuled,
  overlay,
  type PendingEntry,
  rule,
} from "@shared/resource-command";
import { canonicalJson } from "@shared/work-canonical-json";
import type { WorkErrorBody } from "@shared/work-control";
import type { ItemId, OpId } from "@shared/work-ids";
import { ContentService } from "../content/service";
import { StateTransactionOperation } from "../state/service";
import type { RulingRecord } from "./resource-rulings";
import { RulingRecorder, type RulingRecordFailed } from "./ruling-recorder";

export class ArtifactPersistenceError extends Schema.TaggedError<ArtifactPersistenceError>()(
  "ArtifactPersistenceError",
  { operation: Schema.String, message: Schema.String, cause: Schema.Unknown },
) {}

/** One version's body as read: null while its bytes are pending, with the ref that names them. */
export type ArtifactBodyRead = { readonly body: ArtifactBody | null; readonly bodyRef: ContentRef };

/** A head as stored, decoded. `body` is null while its bytes are pending. */
export type ArtifactHeadRead = {
  readonly artifact: Artifact;
  readonly body: ArtifactBody | null;
  readonly bodyRef: ContentRef;
};

export type ArtifactVersionRead = {
  readonly version: ArtifactVersion;
  readonly author: ArtifactActor;
  readonly at: number;
  /**
   * Absent on version 1, the create. `unrecorded` when the version arrived
   * without its edit (too large to ride inline): its body is whole, and no
   * later edit rebases across it.
   */
  readonly edit?: ArtifactEdit | "unrecorded";
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
    /** One version's body and its ref; the body is null while its bytes are pending. */
    readonly body: (
      canvasName: string,
      artifactId: ItemId,
      version: ArtifactVersion,
    ) => Effect.Effect<Option.Option<ArtifactBodyRead>, ArtifactPersistenceError>;
    /** Versions newest first, without bodies; `before` pages back. */
    readonly history: (
      canvasName: string,
      artifactId: ItemId,
      page: { readonly limit: number; readonly before?: ArtifactVersion },
    ) => Effect.Effect<{ readonly versions: ReadonlyArray<ArtifactVersionRead>; readonly more: boolean }, ArtifactPersistenceError>;
    /** This machine's installation id: the writer of commands made here. */
    readonly localWriter: () => Effect.Effect<Option.Option<InstallationId>, ArtifactPersistenceError>;
    /**
     * This machine's own unruled artifact commands over the ruled state it
     * holds, in queue order (read-your-writes, 02). A command whose artifact's
     * head body is not held here waits: its base is behind an edit not pulled.
     * Reach is judged as the ruler judges it, so a command out of its actor's
     * reach changes nothing another seat reads.
     */
    readonly overlay: (
      canvasName: string,
      writer: InstallationId,
      queued: ReadonlyArray<ResourceCommand<ArtifactOp>>,
      context: RulingContext,
    ) => Effect.Effect<ReadonlyArray<PendingEntry>, ArtifactPersistenceError>;
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

const BodyRow = Schema.Struct({ body_ref_json: Schema.String, inline_body_json: Schema.NullOr(Schema.String) });
type BodyRow = typeof BodyRow.Type;

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
  if (row.edit_json === UNRECORDED_EDIT_JSON) return { ...base, edit: "unrecorded" };
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

const persistence = (operation: string) => (error: SqlError.SqlError | Schema.SchemaError | RulingRecordFailed | ArtifactPersistenceError) =>
  error instanceof ArtifactPersistenceError ? error : ArtifactPersistenceError.make({ operation, message: error.message, cause: error });

/** A stored row that no longer decodes: refused loudly, never read as absent and written over. */
const unreadable = (operation: string, what: string) =>
  ArtifactPersistenceError.make({ operation, message: `${what} does not decode`, cause: undefined });

const actorJson = (actor: ResourceActor): string => JSON.stringify(actor);

/**
 * A body's content ref: sha256 over its canonical JSON (05, with the
 * artifact domain). The same bytes are what a version row stores.
 */
export const artifactBodyRef = (body: ArtifactBody): ContentRef => {
  const bytes = Buffer.from(canonicalJson(body), "utf8");
  return {
    sha256: createHash("sha256").update(bytes).digest("hex") as ContentRef["sha256"],
    byteLength: bytes.byteLength as ContentRef["byteLength"],
    mediaType: "application/json" as ContentRef["mediaType"],
  };
};

/**
 * Stands in a version row for an edit that did not travel with its fact. It
 * never decodes as an edit, so the ruler's log stops there: a rebase barrier.
 */
const UNRECORDED_EDIT_JSON = '{"unrecorded":true}';


/**
 * The artifact domain's projection: fold applied facts into `artifact_heads`
 * and `artifact_versions`. The local ruler runs it inside its ruling's
 * transaction; a replica runs it when a received `ruling.applied` carries
 * artifact facts. The caller owns the transaction and folds each ruling
 * once: the ruling's `resource_rulings` row, written in the same transaction,
 * is the dedupe, so a ruling folded twice fails on its key. `bodyOf` gives the body a
 * fact names by ref when the fact does not carry it inline: the ruler's own
 * bodies, or a replica's fetched ones. Without one the version is written
 * pending, its ref only.
 */
export const projectArtifactFacts = (
  sql: SqlClient.SqlClient,
  canvas: string,
  opId: OpId,
  facts: ReadonlyArray<ArtifactFact>,
  bodyOf: (ref: ContentRef) => ArtifactBody | undefined,
): Effect.Effect<void, SqlError.SqlError> =>
  Effect.gen(function* () {
    const bodyJson = (ref: ContentRef, inline: ArtifactBody | undefined): string | null => {
      const body = inline ?? bodyOf(ref);
      return body === undefined ? null : canonicalJson(body);
    };
    for (const fact of facts) {
      switch (fact.fact) {
        case "artifact.created": {
          const a = fact.artifact;
          const body = bodyJson(fact.bodyRef, fact.body);
          yield* sql`
            INSERT INTO artifact_heads (canvas_name, artifact_id, node_id, type, title, version,
              created_by_json, updated_at, archived, task_ids_json)
            VALUES (${canvas}, ${a.artifactId}, ${a.nodeId}, ${a.type}, ${a.title}, ${a.version},
              ${actorJson(a.createdBy)}, ${a.updatedAt}, ${a.archived ? 1 : 0}, ${JSON.stringify(a.taskIds)})`;
          yield* sql`
            INSERT INTO artifact_versions (canvas_name, artifact_id, version, op_id, author_json, at, edit_json,
              body_ref_json, inline_body_json)
            VALUES (${canvas}, ${a.artifactId}, ${a.version}, ${opId}, ${actorJson(a.createdBy)}, ${a.updatedAt},
              NULL, ${JSON.stringify(fact.bodyRef)}, ${body})`;
          break;
        }
        case "artifact.edited": {
          const body = bodyJson(fact.bodyRef, undefined);
          const edit = fact.edit === undefined ? UNRECORDED_EDIT_JSON : JSON.stringify(fact.edit);
          yield* sql`
            INSERT INTO artifact_versions (canvas_name, artifact_id, version, op_id, author_json, at, edit_json,
              body_ref_json, inline_body_json)
            VALUES (${canvas}, ${fact.artifactId}, ${fact.version}, ${opId}, ${actorJson(fact.author)}, ${fact.at},
              ${edit}, ${JSON.stringify(fact.bodyRef)}, ${body})`;
          yield* sql`
            UPDATE artifact_heads SET version = ${fact.version}, updated_at = ${fact.at}
            WHERE canvas_name = ${canvas} AND artifact_id = ${fact.artifactId}`;
          break;
        }
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

export const ArtifactRepositoryLive: Layer.Layer<ArtifactRepository, never, SqlClient.SqlClient | ContentService | RulingRecorder> = Layer.effect(
  ArtifactRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const content = yield* ContentService;
    const recorder = yield* RulingRecorder;

    const headRow = SqlSchema.findOneOption({
      Request: Schema.Struct({ canvas: Schema.String, id: Schema.String }),
      Result: HeadRow,
      execute: ({ canvas, id }) => sql`
        SELECT artifact_id, node_id, type, title, version, created_by_json, updated_at, archived, task_ids_json
        FROM artifact_heads WHERE canvas_name = ${canvas} AND artifact_id = ${id}`,
    });

    const bodyRow = SqlSchema.findOneOption({
      Request: Schema.Struct({ canvas: Schema.String, id: Schema.String, version: Schema.Number }),
      Result: BodyRow,
      execute: ({ canvas, id, version }) => sql`
        SELECT body_ref_json, inline_body_json FROM artifact_versions
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

    /**
     * A version's body: from its row, else from the content store by its ref,
     * else pending (null) while the bytes are on their way.
     */
    const resolveBody = (operation: string, row: BodyRow, what: string) =>
      Effect.gen(function* () {
        const ref = decodeContentRef(parse(row.body_ref_json));
        if (Result.isFailure(ref)) return yield* unreadable(operation, `the body ref of ${what}`);
        if (row.inline_body_json !== null) {
          const body = bodyOf(row.inline_body_json);
          if (body === undefined) return yield* unreadable(operation, `the body of ${what}`);
          return { body, bodyRef: ref.success };
        }
        const opened = yield* content.openForRead(ref.success).pipe(
          Effect.mapError((cause) => ArtifactPersistenceError.make({ operation, message: cause.message, cause })),
        );
        if (opened.state !== "verified") return { body: null, bodyRef: ref.success };
        const text = yield* Effect.tryPromise({
          try: () => readFile(opened.path, "utf8"),
          catch: (cause) => ArtifactPersistenceError.make({ operation, message: `the stored body of ${what} did not read`, cause }),
        });
        const body = bodyOf(text);
        if (body === undefined) return yield* unreadable(operation, `the stored body of ${what}`);
        return { body, bodyRef: ref.success };
      });

    const readHead = (canvas: string, id: ItemId) =>
      Effect.gen(function* () {
        const row = yield* headRow({ canvas, id });
        if (Option.isNone(row)) return Option.none<ArtifactHeadRead>();
        const artifact = artifactOfRow(row.value);
        if (artifact === undefined) return yield* unreadable("head", `artifact ${id}`);
        const what = `artifact ${id} at version ${artifact.version}`;
        const stored = yield* bodyRow({ canvas, id, version: artifact.version });
        if (Option.isNone(stored)) return yield* unreadable("head", `the version row of ${what}`);
        const { body, bodyRef } = yield* resolveBody("head", stored.value, what);
        return Option.some<ArtifactHeadRead>({ artifact, body, bodyRef });
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
      const artifacts: Artifact[] = [];
      for (const row of rows.slice(0, query.limit)) {
        const artifact = artifactOfRow(row);
        if (artifact === undefined) return yield* unreadable("list", `artifact ${row.artifact_id}`);
        artifacts.push(artifact);
      }
      return { artifacts, more: rows.length > query.limit };
    }, Effect.mapError(persistence("list")));

    const head = Effect.fn("artifacts.head")(function* (canvasName: string, artifactId: ItemId) {
      return yield* readHead(canvasName, artifactId);
    }, Effect.mapError(persistence("head")));

    const body = Effect.fn("artifacts.body")(function* (canvasName: string, artifactId: ItemId, version: ArtifactVersion) {
      const row = yield* bodyRow({ canvas: canvasName, id: artifactId, version });
      if (Option.isNone(row)) return Option.none<ArtifactBodyRead>();
      return Option.some<ArtifactBodyRead>(yield* resolveBody("body", row.value, `artifact ${artifactId} at version ${version}`));
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
      const versions: ArtifactVersionRead[] = [];
      for (const row of rows.slice(0, page.limit)) {
        const read = versionOfRow(row);
        if (read === undefined) return yield* unreadable("history", `version ${row.version} of artifact ${artifactId}`);
        versions.push(read);
      }
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
      // Every body the ruler names, so the projection writes the bytes behind each ref.
      const bodies = new Map<string, ArtifactBody>();
      const domain = artifactDomain({
        now: () => now,
        bodyRef: (body) => {
          const ref = artifactBodyRef(body);
          bodies.set(ref.sha256, body);
          return ref;
        },
      });
      const ruled = rule(domain, { state, rulings }, writer, command, context);
      const ruling = ruled.ruling;
      if (ruling.kind === "applied") {
        // The domain refuses a command with no target item, so an applied one always names it.
        if (artifactId === undefined) return yield* Effect.die("an applied artifact ruling names no artifact");
        // This machine ruled the edit, so it keeps it even where the fact left
        // it out. One edit command makes one edited fact, for its own target.
        const kept = ruling.facts.map((fact) =>
          fact.fact === "artifact.edited" && fact.edit === undefined && command.op.op === "edit" && fact.artifactId === artifactId
            ? { ...fact, edit: command.op.edit }
            : fact,
        );
        yield* projectArtifactFacts(sql, canvas, command.opId, kept, (ref) => bodies.get(ref.sha256));
        // The bytes behind each new version's ref go to the content store,
        // owned by that version, in the same write.
        const nodeId = ruled.ruled.state.get(artifactId)!.artifact.nodeId;
        for (const fact of kept) {
          if (fact.fact !== "artifact.created" && fact.fact !== "artifact.edited") continue;
          const body = bodies.get(fact.bodyRef.sha256);
          if (body === undefined) return yield* Effect.die("the ruler named a body it did not keep");
          const version = fact.fact === "artifact.created" ? fact.artifact.version : fact.version;
          yield* content
            .put({
              source: canonicalJson(body),
              mediaType: fact.bodyRef.mediaType,
              expected: { sha256: fact.bodyRef.sha256, byteLength: fact.bodyRef.byteLength },
              owner: { kind: "artifact", canvasName: canvas, nodeId, recordId: `${artifactId}@${version}` },
            })
            .pipe(Effect.mapError((cause) => ArtifactPersistenceError.make({ operation: "submit", message: cause.message, cause })));
        }
      }
      const outcome = outcomeOf(ruling, ruled.ruled.state, artifactId as ItemId);
      const record: RulingRecord =
        outcome.kind === "applied"
          ? { kind: "applied", artifactId: outcome.artifactId, version: outcome.version }
          : { kind: "refused", error: outcome.error, root: outcome.root };
      // The ruling and its facts commit together, or neither does. Its row
      // carries the domain's facts, each bounded inline, never the kept edits.
      yield* recorder.record({
        canvasName: canvas,
        writer,
        command,
        kind: "artifact",
        record,
        // Artifact facts are plain JSON data; a replica decodes them with ArtifactFact.
        ruling: ruling as ResourceRuling<typeof Schema.Json.Type>,
        at: new Date(now).toISOString(),
      });
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

    const overlayOf = Effect.fn("artifacts.overlay")(function* (
      canvasName: string,
      writer: InstallationId,
      queued: ReadonlyArray<ResourceCommand<ArtifactOp>>,
      context: RulingContext,
    ) {
      const entries = new Map<ItemId, ArtifactEntry>();
      for (const id of new Set(queued.flatMap(({ target }) => (target.itemId === undefined ? [] : [target.itemId])))) {
        const entry = yield* readEntry(canvasName, id);
        if (Option.isSome(entry)) entries.set(id, entry.value);
      }
      const domain = artifactDomain({ now: Date.now, bodyRef: artifactBodyRef });
      return overlay(domain, emptyRuled<ArtifactState, ArtifactFact>(entries), writer, queued, {
        ...context,
        // The same verdict a head read gives: a body resolveBody cannot load yet is null.
        baseComplete: (target) => target.itemId === undefined || entries.get(target.itemId)?.body !== null,
      }).pending;
    }, Effect.mapError(persistence("overlay")));

    return ArtifactRepository.of({ list, head, body, history, localWriter, submit, overlay: overlayOf });
  }),
);
