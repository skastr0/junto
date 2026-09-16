/**
 * One-shot migration of historical inline Base64 work media into the local
 * content store. Runs after StateEngine is up; gated by the install-ops
 * backfill ledger (`install-ops.db` / `content.inline-media.v1`), not by
 * product `junto.db`. The product table `content_inline_media_migration`
 * remains for schema identity only and is no longer the authority.
 *
 * Scope law: this walk rewrites MATERIAL PROJECTIONS ONLY (parts_json /
 * parts_json columns). The work logs — work_events, work_facts,
 * work_commands, work_dispositions — are immutable by schema trigger and are
 * never touched: historical records keep their inline
 * Base64 forever, and every decode path admits it (decode-admits-history).
 * New media flows through the content store at write time.
 *
 * Idempotent — a complete install-ops marker is a free no-op on every
 * subsequent boot; a partial run leaves the marker pending and safely
 * resumes next boot (content ingest is content-addressed, row rewrites are
 * per-row txns).
 */

import { Effect } from "effect";
import type { ContentRef } from "@shared/content";
import type {
  StateReader,
  StateRow,
  StateWriter,
} from "../state/service";
import type {
  InstallOpsError,
  InstallOpsServiceShape,
} from "../install-ops/service";
import {
  BACKFILL_INLINE_MEDIA_V1,
} from "../install-ops/engine";
import {
  recordContentObject,
  recordContentRef,
  type ContentOwner,
  type ContentOwnerKind,
} from "./manifest";
import { ContentStoreError, ingestContentBytes } from "./store";
import { unjournaledWorkMutation } from "../work/mutation-seam";

export type InlineMediaMigrationReport = {
  readonly status: "complete" | "already-complete";
  readonly objectsIngested: number;
  readonly rowsRewritten: number;
};

export class InlineMediaMigrationError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "InlineMediaMigrationError";
  }
}

type StateService = {
  readonly read: <A>(
    operation: string,
    body: (reader: StateReader) => A,
  ) => Effect.Effect<A, unknown>;
  readonly transaction: <A>(
    operation: string,
    body: (writer: StateWriter) => A,
  ) => Effect.Effect<A, unknown>;
};

const INLINE_KEYS = new Set(["bytesBase64", "dataBase64"]);

const isPlainObject = (
  value: unknown,
): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasInlineBinary = (value: unknown): boolean => {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasInlineBinary);
  for (const [key, nested] of Object.entries(value)) {
    if (INLINE_KEYS.has(key)) return true;
    if (hasInlineBinary(nested)) return true;
  }
  return false;
};

const decodeBase64 = (encoded: string): Buffer => {
  const cleaned = encoded.replace(/\s+/g, "");
  if (cleaned.length === 0) {
    throw new InlineMediaMigrationError("empty base64 payload");
  }
  return Buffer.from(cleaned, "base64");
};

type PendingIngest = {
  readonly bytes: Buffer;
  readonly mediaType: string;
  readonly displayName?: string;
  readonly path: ReadonlyArray<string | number>;
};

const collectInlinePayloads = (
  value: unknown,
  path: ReadonlyArray<string | number> = [],
): PendingIngest[] => {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      collectInlinePayloads(entry, [...path, index]),
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of INLINE_KEYS) {
    const encoded = record[key];
    if (typeof encoded === "string") {
      const mediaType =
        typeof record.mediaType === "string" && record.mediaType.length > 0
          ? record.mediaType
          : "application/octet-stream";
      const displayName =
        typeof record.displayName === "string" && record.displayName.length > 0
          ? record.displayName
          : undefined;
      return [
        {
          bytes: decodeBase64(encoded),
          mediaType,
          displayName,
          path,
        },
      ];
    }
  }
  const nested: PendingIngest[] = [];
  for (const [key, child] of Object.entries(record)) {
    nested.push(...collectInlinePayloads(child, [...path, key]));
  }
  return nested;
};

const setAtPath = (
  root: unknown,
  path: ReadonlyArray<string | number>,
  replacement: unknown,
): unknown => {
  if (path.length === 0) return replacement;
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    const copy = root.slice();
    const index = Number(head);
    copy[index] = setAtPath(copy[index], rest, replacement);
    return copy;
  }
  if (isPlainObject(root)) {
    return {
      ...root,
      [String(head)]: setAtPath(root[String(head)], rest, replacement),
    };
  }
  throw new InlineMediaMigrationError(
    `cannot rewrite non-container at path ${path.join(".")}`,
  );
};

const asContentPart = (
  ref: ContentRef,
): { kind: "content"; ref: ContentRef } => ({
  kind: "content",
  ref,
});

type JsonColumnTarget = {
  readonly table: string;
  readonly jsonColumn: string;
  readonly selectSql: string;
  readonly updateSql: string;
  readonly ownerFromRow: (row: StateRow) => ContentOwner;
  readonly rowKey: (row: StateRow) => string;
};

const PARTS_TARGETS: ReadonlyArray<JsonColumnTarget> = [
  {
    table: "work_messages",
    jsonColumn: "parts_json",
    selectSql: `
      SELECT canvas_name, node_id, message_id, parts_json
      FROM work_messages
    `,
    updateSql: `
      UPDATE work_messages
      SET parts_json = ?
      WHERE canvas_name = ? AND node_id = ? AND message_id = ?
    `,
    ownerFromRow: (row) => ({
      kind: "message" satisfies ContentOwnerKind,
      canvasName: String(row.canvas_name),
      nodeId: String(row.node_id),
      recordId: String(row.message_id),
    }),
    rowKey: (row) =>
      `work_messages:${row.canvas_name}/${row.node_id}/${row.message_id}`,
  },
  {
    table: "work_task_messages",
    jsonColumn: "parts_json",
    selectSql: `
      SELECT canvas_name, node_id, parent_lane, item_id, message_id, parts_json
      FROM work_task_messages
    `,
    updateSql: `
      UPDATE work_task_messages
      SET parts_json = ?
      WHERE canvas_name = ? AND node_id = ? AND parent_lane = ?
        AND item_id = ? AND message_id = ?
    `,
    ownerFromRow: (row) => ({
      kind: "message",
      canvasName: String(row.canvas_name),
      nodeId: String(row.node_id),
      recordId: String(row.message_id),
    }),
    rowKey: (row) =>
      `work_task_messages:${row.canvas_name}/${row.node_id}/${row.parent_lane}/${row.item_id}/${row.message_id}`,
  },
  {
    table: "work_artifacts",
    jsonColumn: "parts_json",
    selectSql: `
      SELECT canvas_name, node_id, artifact_id, parts_json
      FROM work_artifacts
    `,
    updateSql: `
      UPDATE work_artifacts
      SET parts_json = ?
      WHERE canvas_name = ? AND node_id = ? AND artifact_id = ?
    `,
    ownerFromRow: (row) => ({
      kind: "artifact",
      canvasName: String(row.canvas_name),
      nodeId: String(row.node_id),
      recordId: String(row.artifact_id),
    }),
    rowKey: (row) =>
      `work_artifacts:${row.canvas_name}/${row.node_id}/${row.artifact_id}`,
  },
  {
    table: "work_board_topics",
    jsonColumn: "parts_json",
    selectSql: `
      SELECT canvas_name, node_id, topic_id, parts_json
      FROM work_board_topics
    `,
    updateSql: `
      UPDATE work_board_topics
      SET parts_json = ?
      WHERE canvas_name = ? AND node_id = ? AND topic_id = ?
    `,
    ownerFromRow: (row) => ({
      kind: "board_topic",
      canvasName: String(row.canvas_name),
      nodeId: String(row.node_id),
      recordId: String(row.topic_id),
    }),
    rowKey: (row) =>
      `work_board_topics:${row.canvas_name}/${row.node_id}/${row.topic_id}`,
  },
  {
    table: "work_board_posts",
    jsonColumn: "parts_json",
    selectSql: `
      SELECT canvas_name, node_id, topic_id, post_id, parts_json
      FROM work_board_posts
    `,
    updateSql: `
      UPDATE work_board_posts
      SET parts_json = ?
      WHERE canvas_name = ? AND node_id = ? AND topic_id = ? AND post_id = ?
    `,
    ownerFromRow: (row) => ({
      kind: "board_post",
      canvasName: String(row.canvas_name),
      nodeId: String(row.node_id),
      recordId: String(row.post_id),
    }),
    rowKey: (row) =>
      `work_board_posts:${row.canvas_name}/${row.node_id}/${row.topic_id}/${row.post_id}`,
  },
];

const parseJson = (text: string, label: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new InlineMediaMigrationError(`invalid JSON in ${label}`, {
      cause,
    });
  }
};

const tableExists = (reader: StateReader, table: string): boolean =>
  reader.get<{ readonly name: string }>(
    `
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name = ?
    `,
    [table],
  ) !== undefined;

type IngestedObject = {
  readonly ref: ContentRef;
  readonly verifiedAt: string;
};

const externalizeInlineMedia = (
  value: unknown,
  root: string,
): Effect.Effect<
  {
    readonly value: unknown;
    readonly changed: boolean;
    readonly objects: ReadonlyArray<IngestedObject>;
  },
  ContentStoreError | InlineMediaMigrationError
> =>
  Effect.gen(function* () {
    const pending = collectInlinePayloads(value);
    if (pending.length === 0) {
      return { value, changed: false, objects: [] };
    }

    let next = value;
    const objects: IngestedObject[] = [];
    // Deepest paths first so parent index paths stay stable while rewriting.
    const ordered = [...pending].sort((a, b) => b.path.length - a.path.length);
    for (const item of ordered) {
      const ingested = yield* Effect.tryPromise({
        try: () =>
          ingestContentBytes({
            root,
            source: item.bytes,
            mediaType: item.mediaType,
            displayName: item.displayName,
          }),
        catch: (cause) =>
          cause instanceof ContentStoreError
            ? cause
            : new InlineMediaMigrationError(
                cause instanceof Error ? cause.message : String(cause),
                { cause },
              ),
      });
      objects.push({
        ref: ingested.ref,
        verifiedAt: ingested.verifiedAt,
      });
      next = setAtPath(next, item.path, asContentPart(ingested.ref));
    }
    return { value: next, changed: true, objects };
  });

const recordObjectsAndRefs = (
  writer: StateWriter,
  objects: ReadonlyArray<IngestedObject>,
  owner: ContentOwner,
): void => {
  for (const object of objects) {
    recordContentObject(writer, {
      sha256: object.ref.sha256,
      byteLength: object.ref.byteLength,
      verifiedAt: object.verifiedAt,
    });
    recordContentRef(writer, {
      ref: object.ref,
      owner,
    });
  }
};

const updateBindingsForPartsTarget = (
  target: JsonColumnTarget,
  row: StateRow,
  json: string,
): ReadonlyArray<string> => {
  switch (target.table) {
    case "work_messages":
      return [
        json,
        String(row.canvas_name),
        String(row.node_id),
        String(row.message_id),
      ];
    case "work_task_messages":
      return [
        json,
        String(row.canvas_name),
        String(row.node_id),
        String(row.parent_lane),
        String(row.item_id),
        String(row.message_id),
      ];
    case "work_artifacts":
      return [
        json,
        String(row.canvas_name),
        String(row.node_id),
        String(row.artifact_id),
      ];
    case "work_board_topics":
      return [
        json,
        String(row.canvas_name),
        String(row.node_id),
        String(row.topic_id),
      ];
    case "work_board_posts":
      return [
        json,
        String(row.canvas_name),
        String(row.node_id),
        String(row.topic_id),
        String(row.post_id),
      ];
    default:
      throw new InlineMediaMigrationError(
        `unknown parts target table: ${target.table}`,
      );
  }
};

const migratePartsTargets = (
  state: StateService,
  root: string,
): Effect.Effect<
  { objects: number; rows: number },
  ContentStoreError | InlineMediaMigrationError | unknown
> =>
  Effect.gen(function* () {
    let objects = 0;
    let rows = 0;

    for (const target of PARTS_TARGETS) {
      const candidates = yield* state.read(
        `content.inline-media.scan.${target.table}`,
        (reader) => {
          if (!tableExists(reader, target.table)) return [];
          return reader.all(target.selectSql).filter((row) => {
            const raw = row[target.jsonColumn];
            if (typeof raw !== "string") return false;
            try {
              return hasInlineBinary(JSON.parse(raw));
            } catch {
              return false;
            }
          });
        },
      );

      for (const row of candidates) {
        const raw = String(row[target.jsonColumn]);
        const parsed = parseJson(raw, target.rowKey(row));
        const rewritten = yield* externalizeInlineMedia(parsed, root);
        if (!rewritten.changed) continue;

        const json = JSON.stringify(rewritten.value);
        yield* state.transaction(
          `content.inline-media.rewrite.${target.table}`,
          (writer) => {
            // Declared journal-free: a one-time content move over projection
            // rows, deliberately minting no work fact (it is not a work
            // transition and must not replicate as one).
            unjournaledWorkMutation("content.inline-media.backfill", () => {
              writer.run(
                target.updateSql,
                updateBindingsForPartsTarget(target, row, json),
              );
            });
            recordObjectsAndRefs(
              writer,
              rewritten.objects,
              target.ownerFromRow(row),
            );
          },
        );
        objects += rewritten.objects.length;
        rows += 1;
      }
    }

    return { objects, rows };
  });

/**
 * Run the one-shot historical Base64 → content store migration over the
 * material projection tables. Immutable work logs are never touched.
 *
 * Failures surface as Effect errors; the boot integration logs and retries
 * next boot — a pending backfill must never gate app startup. Safe to call
 * every boot.
 *
 * Completeness is recorded only on the install-ops ledger so product DB
 * seeds cannot claim "already migrated" without local files.
 */
export const runInlineMediaMigration = (input: {
  /** Structural: only read/transaction needed; accepts full StateEngineShape. */
  readonly state: StateService;
  readonly root: string;
  readonly installOps: InstallOpsServiceShape;
}): Effect.Effect<
  InlineMediaMigrationReport,
  ContentStoreError | InlineMediaMigrationError | InstallOpsError | unknown
> =>
  Effect.gen(function* () {
    const state = input.state;
    const root = input.root;
    const installOps = input.installOps;
    const backfillId = BACKFILL_INLINE_MEDIA_V1;

    const marker = yield* installOps.getBackfill(backfillId);

    if (marker?.status === "complete") {
      return {
        status: "already-complete" as const,
        objectsIngested: marker.objectsIngested,
        rowsRewritten: 0,
      };
    }

    yield* installOps.ensurePending(backfillId);

    const parts = yield* migratePartsTargets(state, root);

    const objectsIngested = parts.objects;
    const rowsRewritten = parts.rows;

    yield* installOps.markComplete(backfillId, objectsIngested);

    return {
      status: "complete" as const,
      objectsIngested,
      rowsRewritten,
    };
  });
