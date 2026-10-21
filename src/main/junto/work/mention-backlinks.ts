// Backlinks (docs/plans/0.10/03 section 3): `work_mentions`, a projection of
// mail rows (mention-state-schema.ts). The row's own writer adds its
// backlinks in the same transaction; the migration that made the table
// rebuilds them from every row; the window reads them newest first. What
// counts and what a row mentions is the shared rule (mention-backlinks.ts).

import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { messageIdTimeMs } from "@shared/message-delivery";
import { MENTION_KIND_OF_NODE, mentionLinksOf, type MentionableNodeKind } from "@shared/mention";
import { backlinkKeysOf, backlinkTextOf, writtenHere, type BacklinkSource } from "@shared/mention-backlinks";
import type { NodeKind } from "@shared/model/kinds";
import type { NodeId } from "@shared/physics/schema";
import { KIND_TABLES } from "../model/state-schema";
import { afterSqlCommit } from "../state/sql-commit";
import type { DatabaseSync } from "node:sqlite";

/** The tables of the node kinds a mention can name. Identifiers never come from a caller. */
const MENTIONABLE = (Object.keys(MENTION_KIND_OF_NODE) as ReadonlyArray<MentionableNodeKind>).map(
  (kind) => [kind, KIND_TABLES[kind]] as const,
);

/** One query for the kinds of `count` nodes on a canvas: bind (canvas, ...ids) once per mentionable table. */
const kindsSql = (count: number): string => {
  const ids = Array.from({ length: count }, () => "?").join(", ");
  return MENTIONABLE.map(([kind, table]) => `SELECT '${kind}' AS kind, id FROM ${table} WHERE canvas_name = ? AND id IN (${ids})`).join(
    " UNION ALL ",
  );
};

const kindsBindings = (canvasName: string, ids: ReadonlyArray<string>): ReadonlyArray<string> =>
  MENTIONABLE.flatMap(() => [canvasName, ...ids]);

/** The nodes a row's links name, before any lookup: none for a row whose words were not written here. */
const linkedNodes = (row: BacklinkSource): ReadonlyArray<string> =>
  writtenHere(row) ? [...new Set(mentionLinksOf(backlinkTextOf(row)).map((link) => link.target.nodeId))] : [];

/** A backlink's time: its message id's, or 0 for an id that is no ULID, so it sorts last. */
const atMsOf = (messageId: string): number => messageIdTimeMs(messageId) ?? 0;

const INSERT_SQL = `
  INSERT OR IGNORE INTO work_mentions(canvas_name, mention_key, node_id, message_id, at_ms)
  VALUES (?, ?, ?, ?, ?)
`;

// ── the writer's ───────────────────────────────────────────────────────────

export type MentionsChangedListener = (canvasName: string) => void;
const listeners = new Set<MentionsChangedListener>();

/** Told after a commit that added backlinks on a canvas. Returns the unsubscribe. */
export const onMentionsChanged = (listener: MentionsChangedListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Add a mail row's backlinks, inside the transaction that writes the row.
 * A node the canvas does not hold, or of a kind nothing mentions, names
 * nothing; the row's words stay as written.
 */
export const writeMentions = Effect.fn("work.writeMentions")(function* (
  writer: SqlClient.SqlClient,
  canvasName: string,
  nodeId: string,
  messageId: string,
  row: BacklinkSource,
) {
  const linked = linkedNodes(row);
  // Most mail names nothing: it pays no lookup.
  if (linked.length === 0) return;
  const kinds = new Map(
    (yield* writer.unsafe<{ kind: NodeKind; id: string }>(kindsSql(linked.length), kindsBindings(canvasName, linked))).map(
      (found) => [found.id, found.kind] as const,
    ),
  );
  const keys = backlinkKeysOf(row, (id: NodeId) => kinds.get(id));
  if (keys.length === 0) return;
  const atMs = atMsOf(messageId);
  for (const key of keys) yield* writer.unsafe(INSERT_SQL, [canvasName, key, nodeId, messageId, atMs]);
  yield* afterSqlCommit(writer, () => {
    for (const listener of listeners) listener(canvasName);
  });
});

// ── the rebuild ────────────────────────────────────────────────────────────

type StoredRow = {
  readonly canvas_name: string;
  readonly node_id: string;
  readonly message_id: string;
  readonly actor_seat_id: string;
  readonly parts_json: string;
  readonly metadata_json: string | null;
};

const parsed = (json: string | null): unknown => {
  if (json === null) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};

const sourceOf = (row: StoredRow): BacklinkSource => {
  const parts = parsed(row.parts_json);
  const metadata = parsed(row.metadata_json);
  return {
    actorSeatId: row.actor_seat_id,
    parts: Array.isArray(parts) ? (parts as BacklinkSource["parts"]) : [],
    metadata: typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>) : undefined,
  };
};

/**
 * Every backlink again, from every mail row as stored now: what the writer
 * would have added for each. Run inside the caller's transaction.
 */
export const rebuildMentions = (database: Pick<DatabaseSync, "exec" | "prepare">): void => {
  database.exec("DELETE FROM work_mentions");
  const insert = database.prepare(INSERT_SQL);
  const kinds = new Map<string, NodeKind | null>();
  const kindOf = (canvasName: string, id: string): NodeKind | undefined => {
    const key = `${canvasName}\u0000${id}`;
    if (!kinds.has(key)) {
      const found = database.prepare(kindsSql(1)).get(...kindsBindings(canvasName, [id])) as { kind: NodeKind } | undefined;
      kinds.set(key, found?.kind ?? null);
    }
    return kinds.get(key) ?? undefined;
  };
  const rows = database
    .prepare("SELECT canvas_name, node_id, message_id, actor_seat_id, parts_json, metadata_json FROM work_messages")
    .iterate() as Iterable<StoredRow>;
  for (const row of rows) {
    const source = sourceOf(row);
    if (linkedNodes(source).length === 0) continue;
    for (const key of backlinkKeysOf(source, (id) => kindOf(row.canvas_name, id))) {
      insert.run(row.canvas_name, key, row.node_id, row.message_id, atMsOf(row.message_id));
    }
  }
};

// ── the read ───────────────────────────────────────────────────────────────

/** Where a page of backlinks ends: the last one read, by the read's order. */
export type MentionAfter = { readonly atMs: number; readonly messageId: string; readonly nodeId: string };

export type MentionRow = {
  readonly node_id: string;
  readonly message_id: string;
  readonly at_ms: number;
  readonly actor_seat_id: string;
  readonly metadata_json: string | null;
};

/**
 * Up to `limit` rows mentioning `key` on a canvas, newest first, after
 * `after` when given. Joined with the mail row, which says who wrote it and
 * in what thread; a row and its backlinks go together.
 */
export const readMentions = (
  sql: SqlClient.SqlClient,
  canvasName: string,
  key: string,
  limit: number,
  after?: MentionAfter,
) =>
  sql.unsafe<MentionRow>(
    `
      SELECT mention.node_id, mention.message_id, mention.at_ms, mail.actor_seat_id, mail.metadata_json
      FROM work_mentions AS mention
      JOIN work_messages AS mail USING (canvas_name, node_id, message_id)
      WHERE mention.canvas_name = ? AND mention.mention_key = ?
        ${after === undefined ? "" : "AND (mention.at_ms, mention.message_id, mention.node_id) < (?, ?, ?)"}
      ORDER BY mention.at_ms DESC, mention.message_id DESC, mention.node_id DESC
      LIMIT ?
    `,
    after === undefined
      ? [canvasName, key, limit]
      : [canvasName, key, after.atMs, after.messageId, after.nodeId, limit],
  );
