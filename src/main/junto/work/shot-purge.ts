/**
 * A page box comment's purged shot, as this machine keeps it (plan 06, B7,
 * remote-security's ruling). The editing machine keeps the purge when the
 * operator writes it, and every other machine when its `shot.purged` row
 * arrives, each in the transaction that writes or takes the row: the
 * comment goes in `content_purges`, and every message claim of the comment
 * and of the replies in its thread is released, so the bytes go at the next
 * collection. After that the shot reads removed, and a later pull, notice or
 * copy brings back nothing readable: `shotPurgedHere` is asked first.
 */
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { ContentManifest } from "../content/manifest";

/** A comment on its page node: the key of a purge. */
export type PurgedComment = {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly messageId: string;
};

/**
 * Keep the purge of a comment's shot, and release its claims here: the
 * comment's own and each held reply's in its thread. Idempotent. Returns the
 * number of claims released.
 */
export const keepShotPurge = Effect.fn("work.keepShotPurge")(function* (
  writer: SqlClient.SqlClient,
  comment: PurgedComment,
  at: string,
) {
  yield* writer.unsafe(
    "INSERT OR IGNORE INTO content_purges (canvas_name, node_id, record_id, purged_at) VALUES (?, ?, ?, ?)",
    [comment.canvasName, comment.nodeId, comment.messageId, at],
  );
  const replies = yield* writer.unsafe<{ message_id: string }>(
    `SELECT message_id FROM work_messages
     WHERE canvas_name = ? AND node_id = ? AND message_id <> ?
       AND json_extract(metadata_json, '$.threadId') = ?`,
    [comment.canvasName, comment.nodeId, comment.messageId, comment.messageId],
  );
  const manifest = yield* ContentManifest;
  let released = 0;
  for (const recordId of [comment.messageId, ...replies.map((reply) => reply.message_id)]) {
    released += yield* manifest.releaseContentRefsForOwner({ kind: "message", canvasName: comment.canvasName, nodeId: comment.nodeId, recordId });
  }
  return released;
});

/**
 * Is the shot of this message owner purged here? The owner is the comment
 * itself, or a held reply whose thread is a purged comment.
 */
export const shotPurgedHere = Effect.fn("work.shotPurgedHere")(function* (
  reader: SqlClient.SqlClient,
  owner: { readonly canvasName: string; readonly nodeId: string; readonly recordId: string },
) {
  const rows = yield* reader.unsafe<{ purged: number }>(
    `SELECT 1 AS purged FROM content_purges
     WHERE canvas_name = ?1 AND node_id = ?2
       AND (record_id = ?3 OR record_id = (
         SELECT json_extract(metadata_json, '$.threadId') FROM work_messages
         WHERE canvas_name = ?1 AND node_id = ?2 AND message_id = ?3))
     LIMIT 1`,
    [owner.canvasName, owner.nodeId, owner.recordId],
  );
  return rows.length > 0;
});

/**
 * A pull of an owner's body, unless the owner is a message whose shot is
 * purged here: then it is never attempted, and `refused` answers instead. A
 * purge that cannot be read is taken as standing.
 */
export const unlessShotPurged = <E, R>(
  reader: SqlClient.SqlClient,
  owner: { readonly kind: string; readonly canvasName: string; readonly nodeId: string; readonly recordId: string },
  pull: Effect.Effect<void, E, R>,
  refused: () => E,
): Effect.Effect<void, E, R> =>
  owner.kind !== "message"
    ? pull
    : Effect.flatMap(shotPurgedHere(reader, owner).pipe(Effect.orElseSucceed(() => true)), (purged) =>
        purged ? Effect.fail(refused()) : pull,
      );
