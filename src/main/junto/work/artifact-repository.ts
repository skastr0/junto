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
import { bodyLinksOf } from "@shared/artifact-links";
import { InstallOpsService } from "../install-ops/service";
import { runArtifactLinksBackfill } from "./artifact-links-backfill";
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
  emptyArtifactState,
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
  type RefusedRuling,
  precheck,
  rule,
} from "@shared/resource-command";
import { canonicalJson } from "@shared/work-canonical-json";
import type { WorkErrorBody } from "@shared/work-control";
import { type ArtifactLabel, ArtifactLabelColour, type ArtifactLabelColours } from "@shared/artifact-labels";
import type { ItemId, OpId } from "@shared/work-ids";
import { ContentService } from "../content/service";
import { StateTransactionOperation } from "../state/service";
import type { RulingRecord } from "./resource-rulings";
import { RulingRecorder, type RulingRecordFailed } from "./ruling-recorder";
import { unjournaledWorkMutationEffect } from "./mutation-seam";

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
  /** Every label must match, each by equality or by sitting under it (as `artifactLabelsMatch`). */
  readonly labels?: ReadonlyArray<ArtifactLabel>;
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

/**
 * A command on the Artifacts node itself (`labelColour`, 03 Colours) as the
 * ruler stored it: it names no artifact and makes no version.
 */
export type ArtifactNodeSubmitOutcome =
  | {
      readonly kind: "applied";
      readonly opId: OpId;
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
    /**
     * Rule one command on the Artifacts node itself (its target names no
     * item: `labelColour`) and write what it makes. The ruler sends every
     * command with no `itemId` here.
     */
    readonly submitNode: (
      writer: InstallationId,
      command: ResourceCommand<ArtifactOp>,
      context: RulingContext,
    ) => Effect.Effect<ArtifactNodeSubmitOutcome, ArtifactPersistenceError>;
    /** The label colours set in each Artifacts node asked for; a node with none maps to an empty record. */
    readonly labelColours: (
      canvasName: string,
      nodeIds: ReadonlyArray<NodeId>,
    ) => Effect.Effect<ReadonlyMap<NodeId, ArtifactLabelColours>, ArtifactPersistenceError>;
    /**
     * The writer's check of a command it is about to queue for the editing
     * machine, over the ruled artifacts held here, its own unruled `queued`
     * commands and its `refused` rulings held here (`precheck`): the refusal
     * when it is definite, else none. Reads only: no ruling, no row, no notice.
     */
    readonly precheck: (
      writer: InstallationId,
      queued: ReadonlyArray<ResourceCommand<ArtifactOp>>,
      command: ResourceCommand<ArtifactOp>,
      refused: ReadonlyMap<CommandKey, RefusedRuling>,
      context: RulingContext,
    ) => Effect.Effect<Option.Option<Extract<ArtifactSubmitOutcome, { readonly kind: "refused" }>>, ArtifactPersistenceError>;
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

/** A head row as the contract's Artifact, or nothing when the row does not decode. Labels live beside the head row. */
export const artifactOfRow = (row: HeadRow, labels: ReadonlyArray<string> = []): Artifact | undefined => {
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
    labels,
  });
  return Result.isSuccess(decoded) ? decoded.success : undefined;
};

/** The labels of each artifact asked for, in the canonical order the rows hold. */
const labelRows = (
  sql: SqlClient.SqlClient,
  canvasName: string,
  artifactIds: ReadonlyArray<string>,
): Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>, SqlError.SqlError> =>
  Effect.gen(function* () {
    const held = new Map<string, string[]>();
    if (artifactIds.length === 0) return held;
    const rows = yield* sql.unsafe<{ readonly artifact_id: string; readonly label: string }>(
      `SELECT artifact_id, label FROM artifact_labels
       WHERE canvas_name = ? AND artifact_id IN (${artifactIds.map(() => "?").join(", ")})
       ORDER BY artifact_id, label`,
      [canvasName, ...artifactIds],
    );
    for (const row of rows) {
      const list = held.get(row.artifact_id);
      if (list === undefined) held.set(row.artifact_id, [row.label]);
      else list.push(row.label);
    }
    return held;
  });

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

/** What the ruler keeps of a ruling on the node itself: the node it applied to. */
const StoredNodeRuling = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("applied"), nodeId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("refused"), error: Schema.Unknown, root: Schema.String }),
]);
const decodeStoredNodeRuling = Schema.decodeUnknownResult(StoredNodeRuling);
const decodeLabelColour = Schema.decodeUnknownResult(ArtifactLabelColour);

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
    /**
     * The links a head body holds, rewritten in the ruling's own transaction
     * (0.11, 02): a version's rows replace the artifact's, so a link taken out
     * of a body leaves with it. A body this machine does not hold (a replica
     * whose bytes are still on their way) leaves the rows as they are; the
     * rebuild from bodies projects them once the bytes are here.
     */
    const projectLinks = (artifactId: string, version: number, body: ArtifactBody | undefined): Effect.Effect<void, SqlError.SqlError> =>
      Effect.gen(function* () {
        if (body === undefined) return;
        // The ruling's own journal record lands later in this same transaction
        // (the recorder records after the facts it applied, and its nested
        // transaction does not carry the seam's journal flag back out), so the
        // rows are declared, not explained. See "artifact.links.projection".
        yield* unjournaledWorkMutationEffect(
          "artifact.links.projection",
          Effect.gen(function* () {
            yield* sql`DELETE FROM work_artifact_links WHERE canvas_name = ${canvas} AND source_artifact_id = ${artifactId}`;
            for (const link of bodyLinksOf(body)) {
              yield* sql`
                INSERT INTO work_artifact_links (canvas_name, source_artifact_id, target_node_id, target_artifact_id, line, source_version)
                VALUES (${canvas}, ${artifactId}, ${link.target.nodeId}, ${link.target.artifactId}, ${link.line}, ${version})`;
            }
          }),
        );
      });
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
          yield* projectLinks(a.artifactId, a.version, fact.body ?? bodyOf(fact.bodyRef));
          // A create carries its labels; a fact applied twice writes the same rows.
          for (const label of a.labels) {
            yield* sql`
              INSERT OR IGNORE INTO artifact_labels (canvas_name, artifact_id, label)
              VALUES (${canvas}, ${a.artifactId}, ${label})`;
          }
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
          yield* projectLinks(fact.artifactId, fact.version, bodyOf(fact.bodyRef));
          break;
        }
        case "artifact.labelled":
          // The whole set: the rows are replaced, so applying the fact twice
          // leaves the same table, and no version or body moves.
          yield* sql`DELETE FROM artifact_labels WHERE canvas_name = ${canvas} AND artifact_id = ${fact.artifactId}`;
          for (const label of fact.labels) {
            yield* sql`
              INSERT INTO artifact_labels (canvas_name, artifact_id, label)
              VALUES (${canvas}, ${fact.artifactId}, ${label})`;
          }
          yield* sql`
            UPDATE artifact_heads SET updated_at = ${fact.at}
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
        case "artifact.label.coloured":
          // The node's (node, label) row is the colour, or there is none: a
          // fact applied twice leaves the same row, and no head moves.
          if (fact.colour === null) {
            yield* sql`
              DELETE FROM artifact_label_colours
              WHERE canvas_name = ${canvas} AND node_id = ${fact.nodeId} AND label = ${fact.label}`;
          } else {
            yield* sql`
              INSERT INTO artifact_label_colours (canvas_name, node_id, label, colour)
              VALUES (${canvas}, ${fact.nodeId}, ${fact.label}, ${fact.colour})
              ON CONFLICT (canvas_name, node_id, label) DO UPDATE SET colour = excluded.colour`;
          }
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
    // Bodies written before the links step project once, here, at boot: the
    // walk is install-local (its marker lives in install-ops) and a failure
    // never gates startup — it logs and resumes on the next boot.
    const installOps = yield* Effect.serviceOption(InstallOpsService);
    if (Option.isSome(installOps)) {
      yield* runArtifactLinksBackfill({ sql, installOps: installOps.value }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            console.error("[artifacts] body links backfill deferred to next boot:", error);
          }),
        ),
      );
    }

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
        const labels = yield* labelRows(sql, canvas, [id]);
        const artifact = artifactOfRow(row.value, labels.get(id) ?? []);
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
            ${query.labels === undefined || query.labels.length === 0
              ? sql``
              : sql`AND ${sql.and(
                  query.labels.map(
                    (label) => sql`EXISTS (
                      SELECT 1 FROM artifact_labels matched
                      WHERE matched.canvas_name = artifact_heads.canvas_name
                        AND matched.artifact_id = artifact_heads.artifact_id
                        AND (matched.label = ${label} OR substr(matched.label, 1, length(${label}) + 1) = ${label} || '/'))`,
                  ),
                )}`}
          ORDER BY updated_at DESC, artifact_id DESC
          LIMIT ${query.limit + 1}`,
      })(undefined);
      const page = rows.slice(0, query.limit);
      const labels = yield* labelRows(sql, canvasName, page.map((row) => row.artifact_id));
      const artifacts: Artifact[] = [];
      for (const row of page) {
        const artifact = artifactOfRow(row, labels.get(row.artifact_id) ?? []);
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

    const submitNode = Effect.fn("artifacts.submitNode")(function* (
      writer: InstallationId,
      command: ResourceCommand<ArtifactOp>,
      context: RulingContext,
    ) {
      const canvas = command.canvasName;
      const prior = yield* rulingRow({ canvas, writer, opId: command.opId });
      if (Option.isSome(prior)) {
        const stored = decodeStoredNodeRuling(parse(prior.value.ruling_json));
        if (Result.isSuccess(stored)) {
          return stored.success.kind === "applied"
            ? { kind: "applied" as const, opId: command.opId, facts: [] }
            : { kind: "refused" as const, opId: command.opId, error: stored.success.error as WorkErrorBody, root: stored.success.root as OpId };
        }
        return yield* unreadable("submitNode", `the ruling of ${command.opId}`);
      }
      const rulings = yield* priorRulings(canvas, writer, command);
      const now = Date.now();
      // A node command reads no artifact: it rules on an empty state, as every machine would.
      const domain = artifactDomain({ now: () => now, bodyRef: artifactBodyRef });
      const ruled = rule(domain, { state: emptyArtifactState(), rulings }, writer, command, context);
      const ruling = ruled.ruling;
      if (ruling.kind === "applied") yield* projectArtifactFacts(sql, canvas, command.opId, ruling.facts, () => undefined);
      const outcome: ArtifactNodeSubmitOutcome =
        ruling.kind === "applied"
          ? { kind: "applied", opId: ruling.opId, facts: ruling.facts }
          : { kind: "refused", opId: ruling.opId, error: ruling.error, root: ruling.root };
      const record: RulingRecord =
        outcome.kind === "applied"
          ? { kind: "applied", nodeId: command.target.nodeId }
          : { kind: "refused", error: outcome.error, root: outcome.root };
      yield* recorder.record({
        canvasName: canvas,
        writer,
        command,
        kind: "artifact",
        record,
        ruling: ruling as ResourceRuling<typeof Schema.Json.Type>,
        at: new Date(now).toISOString(),
      });
      return outcome;
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "artifacts.submitNode"), Effect.mapError(persistence("submitNode")));

    const labelColours = Effect.fn("artifacts.labelColours")(function* (canvasName: string, nodeIds: ReadonlyArray<NodeId>) {
      // Null-prototype records: `__proto__` and `constructor` are labels like any other.
      const held = new Map<NodeId, Record<string, ArtifactLabelColour>>(
        nodeIds.map((id) => [id, Object.create(null) as Record<string, ArtifactLabelColour>]),
      );
      if (nodeIds.length === 0) return held as ReadonlyMap<NodeId, ArtifactLabelColours>;
      const rows = yield* sql<{ readonly node_id: string; readonly label: string; readonly colour: string }>`
        SELECT node_id, label, colour FROM artifact_label_colours
        WHERE canvas_name = ${canvasName} AND ${sql.in("node_id", nodeIds)}
        ORDER BY node_id, label`;
      for (const row of rows) {
        const colour = decodeLabelColour(row.colour);
        if (Result.isFailure(colour)) return yield* unreadable("labelColours", `the colour of ${row.label} on ${row.node_id}`);
        held.get(row.node_id as NodeId)![row.label] = colour.success;
      }
      return held as ReadonlyMap<NodeId, ArtifactLabelColours>;
    }, Effect.mapError(persistence("labelColours")));

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

    const precheckOf = Effect.fn("artifacts.precheck")(function* (
      writer: InstallationId,
      queued: ReadonlyArray<ResourceCommand<ArtifactOp>>,
      command: ResourceCommand<ArtifactOp>,
      refused: ReadonlyMap<CommandKey, RefusedRuling>,
      context: RulingContext,
    ) {
      const canvas = command.canvasName;
      const commands = [...queued, command];
      const entries = new Map<ItemId, ArtifactEntry>();
      for (const id of new Set(commands.flatMap(({ target }) => (target.itemId === undefined ? [] : [target.itemId])))) {
        const entry = yield* readEntry(canvas, id);
        if (Option.isSome(entry)) entries.set(id, entry.value);
      }
      const domain = artifactDomain({ now: Date.now, bodyRef: artifactBodyRef });
      return Option.fromNullishOr(precheck(domain, { state: entries, rulings: refused }, writer, queued, command, context));
    }, Effect.mapError(persistence("precheck")));

    return ArtifactRepository.of({
      list,
      head,
      body,
      history,
      localWriter,
      submit,
      submitNode,
      labelColours,
      overlay: overlayOf,
      precheck: precheckOf,
    });
  }),
);
