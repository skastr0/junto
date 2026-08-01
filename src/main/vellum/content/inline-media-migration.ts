/**
 * One-shot migration of historical inline Base64 work media into the local
 * content store. Runs after StateEngine is up; gated by the
 * `content_inline_media_migration` singleton marker (schema v13).
 *
 * Expand-only product law: columns stay; rows are rewritten in place.
 * Idempotent — a complete marker is a free no-op on every subsequent boot.
 */

import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { ContentRef } from "@shared/content";
import { WORK_PROTOCOL } from "@shared/work-protocol";
import type {
  StateEngine,
  StateReader,
  StateRow,
  StateWriter,
} from "../state/service";
import {
  recordContentObject,
  recordContentRef,
  type ContentOwner,
  type ContentOwnerKind,
} from "./manifest";
import { ingestContentBytes } from "./store";

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

/**
 * Mirror of work/repository normalizeJson + content hash. Duplicated here so
 * content startup does not import the full Work repository graph.
 */
const normalizeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      )
      .map(([key, nested]) => [key, normalizeJson(nested)]),
  );
};

const workRecordContentSha256 = (semantic: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(normalizeJson(semantic)), "utf8")
    .digest("hex");

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
  {
    table: "work_task_proposals",
    jsonColumn: "brief_json",
    selectSql: `
      SELECT canvas_name, node_id, proposal_id, brief_json
      FROM work_task_proposals
    `,
    updateSql: `
      UPDATE work_task_proposals
      SET brief_json = ?
      WHERE canvas_name = ? AND node_id = ? AND proposal_id = ?
    `,
    ownerFromRow: (row) => ({
      kind: "task",
      canvasName: String(row.canvas_name),
      nodeId: String(row.node_id),
      recordId: String(row.proposal_id),
    }),
    rowKey: (row) =>
      `work_task_proposals:${row.canvas_name}/${row.node_id}/${row.proposal_id}`,
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

const readMarker = (
  reader: StateReader,
): { status: string; objects_ingested: number | bigint } | undefined => {
  if (!tableExists(reader, "content_inline_media_migration")) return undefined;
  return reader.get<{
    readonly status: string;
    readonly objects_ingested: number | bigint;
  }>(
    `
      SELECT status, objects_ingested
      FROM content_inline_media_migration
      WHERE singleton = 1
    `,
  );
};

const ensurePendingMarker = (writer: StateWriter): void => {
  writer.run(
    `
      INSERT INTO content_inline_media_migration(
        singleton, status, objects_ingested, completed_at
      ) VALUES (1, 'pending', 0, NULL)
      ON CONFLICT(singleton) DO NOTHING
    `,
  );
};

const markComplete = (
  writer: StateWriter,
  objectsIngested: number,
): void => {
  writer.run(
    `
      INSERT INTO content_inline_media_migration(
        singleton, status, objects_ingested, completed_at
      ) VALUES (1, 'complete', ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        status = 'complete',
        objects_ingested = excluded.objects_ingested,
        completed_at = excluded.completed_at
    `,
    [objectsIngested, new Date().toISOString()],
  );
};

type IngestedObject = {
  readonly ref: ContentRef;
  readonly verifiedAt: string;
};

const externalizeInlineMedia = async (
  value: unknown,
  root: string,
): Promise<{
  readonly value: unknown;
  readonly changed: boolean;
  readonly objects: ReadonlyArray<IngestedObject>;
}> => {
  const pending = collectInlinePayloads(value);
  if (pending.length === 0) {
    return { value, changed: false, objects: [] };
  }

  let next = value;
  const objects: IngestedObject[] = [];
  // Deepest paths first so parent index paths stay stable while rewriting.
  const ordered = [...pending].sort((a, b) => b.path.length - a.path.length);
  for (const item of ordered) {
    const ingested = await ingestContentBytes({
      root,
      source: item.bytes,
      mediaType: item.mediaType,
      displayName: item.displayName,
    });
    objects.push({
      ref: ingested.ref,
      verifiedAt: ingested.verifiedAt,
    });
    next = setAtPath(next, item.path, asContentPart(ingested.ref));
  }
  return { value: next, changed: true, objects };
};

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
    case "work_task_proposals":
      return [
        json,
        String(row.canvas_name),
        String(row.node_id),
        String(row.proposal_id),
      ];
    default:
      throw new InlineMediaMigrationError(
        `unknown parts target table: ${target.table}`,
      );
  }
};

const runRead = <A>(
  state: StateService,
  operation: string,
  body: (reader: StateReader) => A,
): Promise<A> => Effect.runPromise(state.read(operation, body));

const runTxn = <A>(
  state: StateService,
  operation: string,
  body: (writer: StateWriter) => A,
): Promise<A> => Effect.runPromise(state.transaction(operation, body));

const migratePartsTargets = async (
  state: StateService,
  root: string,
): Promise<{ objects: number; rows: number }> => {
  let objects = 0;
  let rows = 0;

  for (const target of PARTS_TARGETS) {
    const candidates = await runRead(
      state,
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
      const rewritten = await externalizeInlineMedia(parsed, root);
      if (!rewritten.changed) continue;

      const json = JSON.stringify(rewritten.value);
      await runTxn(
        state,
        `content.inline-media.rewrite.${target.table}`,
        (writer) => {
          writer.run(
            target.updateSql,
            updateBindingsForPartsTarget(target, row, json),
          );
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
};

/**
 * Rewrite work_facts.result_json and rotate work_events.content_sha256 so
 * load-time integrity still matches. Deferred FK checks let disposition and
 * basis_command sha mirrors update in the same commit.
 */
const migrateWorkFacts = async (
  state: StateService,
  root: string,
): Promise<{ objects: number; rows: number }> => {
  const candidates = await runRead(
    state,
    "content.inline-media.scan.work_facts",
    (reader) => {
      if (!tableExists(reader, "work_facts")) return [];
      return reader
        .all<{
          readonly event_home: string;
          readonly entity_home: string;
          readonly seq: string;
          readonly result_json: string;
          readonly content_sha256: string;
          readonly protocol: string;
          readonly item_kind: string;
          readonly item_id: string;
          readonly item_canvas_name: string;
          readonly item_node_id: string;
          readonly operation: string;
          readonly predecessor_event_home: string | null;
          readonly predecessor_entity_home: string | null;
          readonly predecessor_seq: string | null;
          readonly basis_kind: string;
          readonly basis_authorial_generation: string | null;
          readonly basis_authorial_content_sha256: string | null;
          readonly basis_projected_generation: string | null;
          readonly basis_projected_content_sha256: string | null;
          readonly basis_command_event_home: string | null;
          readonly basis_command_entity_home: string | null;
          readonly basis_command_seq: string | null;
          readonly basis_command_sha256: string | null;
        }>(
          `
            SELECT
              f.event_home,
              f.entity_home,
              f.seq,
              f.result_json,
              e.content_sha256,
              e.protocol,
              e.item_kind,
              e.item_id,
              e.item_canvas_name,
              e.item_node_id,
              e.operation,
              f.predecessor_event_home,
              f.predecessor_entity_home,
              f.predecessor_seq,
              f.basis_kind,
              f.basis_authorial_generation,
              f.basis_authorial_content_sha256,
              f.basis_projected_generation,
              f.basis_projected_content_sha256,
              f.basis_command_event_home,
              f.basis_command_entity_home,
              f.basis_command_seq,
              f.basis_command_sha256
            FROM work_facts f
            INNER JOIN work_events e
              ON e.event_home = f.event_home
              AND e.entity_home = f.entity_home
              AND e.seq = f.seq
          `,
        )
        .filter((row) => {
          try {
            return hasInlineBinary(JSON.parse(row.result_json));
          } catch {
            return false;
          }
        });
    },
  );

  let objects = 0;
  let rows = 0;

  for (const row of candidates) {
    const body = parseJson(
      row.result_json,
      `work_facts:${row.event_home}/${row.entity_home}/${row.seq}`,
    );
    const rewritten = await externalizeInlineMedia(body, root);
    if (!rewritten.changed) continue;

    const predecessor =
      row.predecessor_event_home === null ||
      row.predecessor_entity_home === null ||
      row.predecessor_seq === null
        ? null
        : {
            route: {
              eventHome: row.predecessor_event_home,
              entityHome: row.predecessor_entity_home,
            },
            seq: row.predecessor_seq,
          };

    const basis =
      row.basis_kind === "authorial-intent"
        ? {
            kind: "authorial-intent" as const,
            generation: row.basis_authorial_generation,
            contentSha256: row.basis_authorial_content_sha256,
          }
        : row.basis_kind === "projected-intent"
          ? {
              kind: "projected-intent" as const,
              generation: row.basis_projected_generation,
              contentSha256: row.basis_projected_content_sha256,
            }
          : {
              kind: "command" as const,
              command: {
                route: {
                  eventHome: row.basis_command_event_home,
                  entityHome: row.basis_command_entity_home,
                },
                seq: row.basis_command_seq,
              },
              commandSha256: row.basis_command_sha256,
            };

    const semantic = {
      protocol: row.protocol || WORK_PROTOCOL,
      id: {
        route: {
          eventHome: row.event_home,
          entityHome: row.entity_home,
        },
        seq: row.seq,
      },
      item: {
        kind: row.item_kind,
        itemId: row.item_id,
        sink: {
          canvasName: row.item_canvas_name,
          nodeId: row.item_node_id,
        },
      },
      operation: row.operation,
      recordType: "fact" as const,
      basis,
      predecessor,
      body: rewritten.value,
    };

    const newHash = workRecordContentSha256(semantic);
    const resultJson = JSON.stringify(rewritten.value);
    const oldHash = row.content_sha256;

    const owner: ContentOwner = {
      kind:
        row.item_kind === "artifact"
          ? "artifact"
          : row.item_kind === "message"
            ? "message"
            : row.item_kind === "task"
              ? "task"
              : "other",
      canvasName: row.item_canvas_name,
      nodeId: row.item_node_id,
      recordId: row.item_id,
    };

    await runTxn(
      state,
      "content.inline-media.rewrite.work_facts",
      (writer) => {
        writer.run("PRAGMA defer_foreign_keys = ON");

        writer.run(
          `
            UPDATE work_facts
            SET result_json = ?
            WHERE event_home = ? AND entity_home = ? AND seq = ?
          `,
          [resultJson, row.event_home, row.entity_home, row.seq],
        );

        if (newHash !== oldHash) {
          writer.run(
            `
              UPDATE work_events
              SET content_sha256 = ?
              WHERE event_home = ? AND entity_home = ? AND seq = ?
            `,
            [newHash, row.event_home, row.entity_home, row.seq],
          );
          writer.run(
            `
              UPDATE work_dispositions
              SET fact_sha256 = ?
              WHERE fact_event_home = ?
                AND fact_entity_home = ?
                AND fact_seq = ?
                AND fact_sha256 = ?
            `,
            [newHash, row.event_home, row.entity_home, row.seq, oldHash],
          );
          writer.run(
            `
              UPDATE work_dispositions
              SET command_sha256 = ?
              WHERE command_event_home = ?
                AND command_entity_home = ?
                AND command_seq = ?
                AND command_sha256 = ?
            `,
            [newHash, row.event_home, row.entity_home, row.seq, oldHash],
          );
          writer.run(
            `
              UPDATE work_facts
              SET basis_command_sha256 = ?
              WHERE basis_command_event_home = ?
                AND basis_command_entity_home = ?
                AND basis_command_seq = ?
                AND basis_command_sha256 = ?
            `,
            [newHash, row.event_home, row.entity_home, row.seq, oldHash],
          );
        }

        recordObjectsAndRefs(writer, rewritten.objects, owner);
      },
    );

    objects += rewritten.objects.length;
    rows += 1;
  }

  return { objects, rows };
};

const migrateProposalEvents = async (
  state: StateService,
  root: string,
): Promise<{ objects: number; rows: number }> => {
  const candidates = await runRead(
    state,
    "content.inline-media.scan.work_proposal_events",
    (reader) => {
      if (!tableExists(reader, "work_proposal_events")) return [];
      return reader
        .all<{
          readonly event_home: string;
          readonly entity_home: string;
          readonly seq: string;
          readonly record_json: string;
          readonly content_sha256: string;
          readonly canvas_name: string;
          readonly node_id: string;
          readonly proposal_id: string;
        }>(
          `
            SELECT
              event_home,
              entity_home,
              seq,
              record_json,
              content_sha256,
              canvas_name,
              node_id,
              proposal_id
            FROM work_proposal_events
          `,
        )
        .filter((row) => {
          try {
            return hasInlineBinary(JSON.parse(row.record_json));
          } catch {
            return false;
          }
        });
    },
  );

  let objects = 0;
  let rows = 0;

  for (const row of candidates) {
    const record = parseJson(
      row.record_json,
      `work_proposal_events:${row.event_home}/${row.entity_home}/${row.seq}`,
    );
    if (!isPlainObject(record)) continue;

    const rewritten = await externalizeInlineMedia(record, root);
    if (!rewritten.changed || !isPlainObject(rewritten.value)) continue;

    const nextRecord = { ...rewritten.value };
    const { contentSha256: _old, originAt, ...semantic } = nextRecord as {
      contentSha256?: unknown;
      originAt?: unknown;
      [key: string]: unknown;
    };
    const newHash = workRecordContentSha256(semantic);
    nextRecord.contentSha256 = newHash;
    if (originAt !== undefined) nextRecord.originAt = originAt;

    const owner: ContentOwner = {
      kind: "task",
      canvasName: row.canvas_name,
      nodeId: row.node_id,
      recordId: row.proposal_id,
    };

    await runTxn(
      state,
      "content.inline-media.rewrite.work_proposal_events",
      (writer) => {
        writer.run(
          `
            UPDATE work_proposal_events
            SET record_json = ?, content_sha256 = ?
            WHERE event_home = ? AND entity_home = ? AND seq = ?
          `,
          [
            JSON.stringify(nextRecord),
            newHash,
            row.event_home,
            row.entity_home,
            row.seq,
          ],
        );
        recordObjectsAndRefs(writer, rewritten.objects, owner);
      },
    );

    objects += rewritten.objects.length;
    rows += 1;
  }

  return { objects, rows };
};

/**
 * Run the one-shot historical Base64 → content store migration.
 *
 * Failures throw so app startup surfaces them. Safe to call every boot.
 */
export const runInlineMediaMigration = async (input: {
  readonly state:
    | StateService
    | import("effect").Context.Tag.Service<typeof StateEngine>;
  readonly root: string;
}): Promise<InlineMediaMigrationReport> => {
  const state = input.state as StateService;
  const root = input.root;

  const marker = await runRead(
    state,
    "content.inline-media.marker.read",
    (reader) => readMarker(reader),
  );

  if (marker?.status === "complete") {
    return {
      status: "already-complete",
      objectsIngested: Number(marker.objects_ingested ?? 0),
      rowsRewritten: 0,
    };
  }

  await runTxn(state, "content.inline-media.marker.ensure", (writer) => {
    if (!tableExists(writer, "content_inline_media_migration")) {
      throw new InlineMediaMigrationError(
        "content_inline_media_migration table missing — schema migration to v13 required",
      );
    }
    ensurePendingMarker(writer);
  });

  const parts = await migratePartsTargets(state, root);
  const facts = await migrateWorkFacts(state, root);
  const proposals = await migrateProposalEvents(state, root);

  const objectsIngested =
    parts.objects + facts.objects + proposals.objects;
  const rowsRewritten = parts.rows + facts.rows + proposals.rows;

  await runTxn(state, "content.inline-media.marker.complete", (writer) => {
    markComplete(writer, objectsIngested);
  });

  return {
    status: "complete",
    objectsIngested,
    rowsRewritten,
  };
};
