/**
 * A rename made in Junto carries the threads of what moved (0.11, F7 follow-up).
 *
 * A file thread names its file by the node and a path inside it
 * (`thread-subject.ts`), and the anchor repeats that path on a lines anchor.
 * When the operator renames or moves a file or a folder through Junto, the
 * threads written on it would otherwise name a path that no longer exists, so
 * this rewrites them in the same main step as the filesystem change. A rename
 * made outside Junto (Finder) is unseen and leaves them at the old path, which
 * the 0.11 notes say.
 *
 * The rule is pure and lives in `carriedSubject`; `carryFileThreads` is the
 * store walk that applies it, row by row, and is called by the files service.
 */
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import { isRelativePath, THREAD_SUBJECT_KEY } from "@shared/thread-subject";
import { unjournaledWorkMutationEffect } from "./mutation-seam";
import { noteThreadChanged } from "./resource-changes";

/** A path under `from` or equal to it, as a folder move carries what is inside it. */
export const pathUnder = (path: string, from: string): boolean => path === from || path.startsWith(`${from}/`);

/** `path` moved from `from` to `to`; untouched when it is not under `from`. */
export const carriedPath = (path: string, from: string, to: string): string =>
  path === from ? to : `${to}${path.slice(from.length)}`;

/**
 * A row's `metadata` as a rename leaves it: the file subject's path carried,
 * and a lines anchor's own `file` with it. Undefined when the row holds no
 * subject for this node, its subject is not a file's, the path is not under
 * `from`, or the carried path is no path a subject may name.
 */
export const carriedSubject = (
  metadata: Readonly<Record<string, unknown>>,
  nodeId: string,
  from: string,
  to: string,
): Readonly<Record<string, unknown>> | undefined => {
  const held = metadata[THREAD_SUBJECT_KEY];
  if (typeof held !== "object" || held === null) return undefined;
  const subject = held as { readonly kind?: unknown; readonly nodeId?: unknown; readonly path?: unknown; readonly anchor?: unknown };
  if (subject.kind !== "file" || subject.nodeId !== nodeId || typeof subject.path !== "string") return undefined;
  if (!pathUnder(subject.path, from)) return undefined;
  const path = carriedPath(subject.path, from, to);
  if (!isRelativePath(path)) return undefined;
  const anchor = subject.anchor;
  const carriedAnchor =
    typeof anchor === "object" && anchor !== null && (anchor as { readonly kind?: unknown }).kind === "lines"
      ? { ...(anchor as Record<string, unknown>), file: path }
      : anchor;
  return { ...metadata, [THREAD_SUBJECT_KEY]: { ...subject, path, ...(carriedAnchor === undefined ? {} : { anchor: carriedAnchor }) } };
};

/**
 * Carry the threads held at `nodeId` from `from` to `to`, in the rows' own
 * store: every mail row of that node whose subject is a file under `from`.
 * Returns how many rows moved. Idempotent: a row already carried no longer
 * matches `from`. Runs in its own transaction, declared to the work seam: a
 * move mints no fact (see "files.thread-carry" in mutation-seam.ts).
 */
export const carryFileThreads = (
  sql: SqlClient.SqlClient,
  canvasName: string,
  nodeId: string,
  from: string,
  to: string,
): Effect.Effect<number, SqlError.SqlError> =>
  // Reported after the transaction committed, so every window reads the new
  // subject once: another open rail, Mentioned in, Linked from (F7).
  Effect.tap(
    sql.withTransaction(
      unjournaledWorkMutationEffect(
        "files.thread-carry",
        Effect.gen(function* () {
          if (from === to) return 0;
          const rows = yield* sql.unsafe<{ readonly message_id: string; readonly metadata_json: string }>(
            `SELECT message_id AS message_id, metadata_json AS metadata_json
             FROM work_messages
             WHERE canvas_name = ? AND node_id = ? AND metadata_json IS NOT NULL
               AND json_extract(metadata_json, '$.threadSubject.kind') = 'file'
               AND json_extract(metadata_json, '$.threadSubject.nodeId') = ?
               AND (json_extract(metadata_json, '$.threadSubject.path') = ?
                    OR substr(json_extract(metadata_json, '$.threadSubject.path'), 1, length(?) + 1) = ? || '/')`,
            [canvasName, nodeId, nodeId, from, from, from],
          );
          let moved = 0;
          for (const row of rows) {
            const metadata = JSON.parse(row.metadata_json) as Readonly<Record<string, unknown>>;
            const carried = carriedSubject(metadata, nodeId, from, to);
            if (carried === undefined) continue;
            yield* sql`
              UPDATE work_messages SET metadata_json = ${JSON.stringify(carried)}
              WHERE canvas_name = ${canvasName} AND node_id = ${nodeId} AND message_id = ${row.message_id}`;
            moved += 1;
          }
          return moved;
        }),
      ),
    ),
    (moved) =>
      Effect.sync(() => {
        if (moved > 0) noteThreadChanged("file", canvasName);
      }),
  );
