/**
 * A page box comment's purged shot, as this machine keeps it (plan 06, B7,
 * remote-security's ruling). The editing machine keeps the purge when the
 * operator writes it, and every other machine when its `shot.purged` row
 * arrives, each in the transaction that writes or takes the row: the
 * comment goes in `content_purges`, and every message claim of the comment
 * and of the replies in its thread is released, so the bytes go at the next
 * collection. After that the shot reads removed, and a later pull, notice or
 * copy brings back nothing readable: `shotPurgedHere` is asked first.
 *
 * A seat that read the shot has a copy in its workspace, outside the store.
 * Once the purge commits, that copy goes from every seat's workspace here
 * (`removeSeatShotCopies`); a sweep that failed runs again at start from
 * `content_purges`. Bytes a seat already read or copied elsewhere stay with it.
 */
import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { ContentRef } from "@shared/wire/content-ref";
import { contentMaterializationPath, contentMaterializationRoot } from "../content/agent-access";
import { ContentManifest } from "../content/manifest";
import { workHome } from "../content/operator-attachments";
import { afterSqlCommit } from "../state/sql-commit";

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
  // After the commit, never inside it: a file removed is not rolled back.
  yield* afterSqlCommit(writer, () => sweepSeatShotCopies(workHome(), comment));
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

/** A seat's copy of a page box shot, as page-shot-seat.ts names it: `<sha256>-page-box.png`. */
const SEAT_SHOT_FILE = /^[a-f0-9]{64}-page-box\.png$/;

const inside = (root: string, candidate: string): boolean => {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`);
};

/** Is there a real directory at the path, not a link to one? */
const directoryAt = (path: string): boolean => {
  try {
    const info = lstatSync(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Remove every seat's workspace copy of a purged comment's shot. Each copy is
 * at `<root>/<canvas>/<seat>/mail-<comment>/<sha256>-page-box.png`
 * (`contentMaterializationPath`), so this is one directory read per seat
 * directory of the canvas, a seat gone from the canvas included. No link is
 * followed: a seat or thread directory that is a link is passed over, and a
 * copy is unlinked, never opened. Other files in the thread's directory, an
 * operator's attachments, stay. Returns the copies removed.
 */
export const removeSeatShotCopies = (home: string, comment: PurgedComment): number => {
  const root = contentMaterializationRoot(home);
  const probe = contentMaterializationPath({
    workHome: home,
    canvasName: comment.canvasName,
    targetNodeId: "seat",
    taskId: `mail-${comment.messageId}`,
    ref: { sha256: "0".repeat(64), byteLength: 0, mediaType: "image/png" } as ContentRef,
    name: "page-box.png",
  });
  const thread = basename(dirname(probe));
  const canvas = dirname(dirname(dirname(probe)));
  if (!directoryAt(root) || !directoryAt(canvas)) return 0;
  let removed = 0;
  for (const seat of readdirSync(canvas)) {
    const directory = join(canvas, seat, thread);
    if (!directoryAt(join(canvas, seat)) || !directoryAt(directory)) continue;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (!SEAT_SHOT_FILE.test(name) || !inside(root, path) || directoryAt(path)) continue;
      unlinkSync(path);
      removed += 1;
    }
  }
  return removed;
};

const sweepSeatShotCopies = (home: string, comment: PurgedComment): void => {
  try {
    removeSeatShotCopies(home, comment);
  } catch (cause) {
    // Run again at start (sweepPurgedShotCopies).
    Effect.runFork(Effect.logWarning("a purged shot's seat copies could not be removed yet", cause).pipe(Effect.annotateLogs({ area: "content" })));
  }
};

/** At start: remove the seat copies of every purge kept here, for any sweep that failed. */
export const sweepPurgedShotCopies = Effect.fn("work.sweepPurgedShotCopies")(function* (reader: SqlClient.SqlClient) {
  const purges = yield* reader.unsafe<{ canvas_name: string; node_id: string; record_id: string }>(
    "SELECT canvas_name, node_id, record_id FROM content_purges",
  );
  const home = workHome();
  for (const purge of purges) sweepSeatShotCopies(home, { canvasName: purge.canvas_name, nodeId: purge.node_id, messageId: purge.record_id });
});
