/**
 * The operator's read point in each mail thread (0.11.3): one per thread of
 * a canvas, shared by the desktop and the phone. A thread between two seats is
 * one conversation, so reading it under either seat reads it under both. The
 * seat in each call is only the scope: a seat reads and marks its own threads.
 *
 * A point only moves forward, in the thread's order. A mark that does not move
 * it writes nothing and tells no one, so a surface may mark on every render.
 * Unread is derived where threads are summarized (`unreadPast`), never stored.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { mailAfter, readPointKey, seatMailThreadEntries, type MailReadChanged, type MailReadPoint } from "@shared/mail-threads";
import { afterSqlCommit } from "../state/sql-commit";
import { StateTransactionOperation } from "../state/service";
import { seatThreadsInput } from "./operator-threads";

type Listener = (change: MailReadChanged) => void;
const listeners = new Set<Listener>();

/** Hear each read point that moves, after it commits, from any surface. Returns the unsubscribe. */
export const onReadChanged = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const announce = (change: MailReadChanged): void => {
  for (const listener of [...listeners]) {
    try {
      listener(change);
    } catch (error) {
      // A listener cannot turn a committed read into a failed one.
      console.error(`[mail-reads] change listener failed for ${change.canvasName}/${change.threadId}:`, error);
    }
  }
};

type PointRow = { readonly thread_id: string; readonly through_message_id: string; readonly read_at: number };

const pointOf = (row: PointRow): MailReadPoint => ({ through: row.through_message_id, at: Number(row.read_at) });

const heldPoint = (sql: SqlClient.SqlClient, canvasName: string, threadId: string) =>
  Effect.map(
    sql<PointRow>`SELECT thread_id, through_message_id, read_at FROM operator_mail_reads
      WHERE canvas_name = ${canvasName} AND thread_id = ${threadId}`,
    (rows) => (rows[0] === undefined ? undefined : pointOf(rows[0])),
  );

/**
 * The read points of a seat's threads, by thread id; a thread never read is
 * absent. `threadIds` narrows it to one page; an id not of the seat's is left out.
 */
export const readPoints = (canvasName: string, nodeId: string, threadIds?: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const seats = seatMailThreadEntries(yield* seatThreadsInput(canvasName), nodeId);
    const wanted = (threadIds ?? [...seats.keys()]).filter((threadId) => seats.has(threadId));
    const points = new Map<string, MailReadPoint>();
    if (wanted.length === 0) return points as ReadonlyMap<string, MailReadPoint>;
    const rows = yield* sql<PointRow>`SELECT thread_id, through_message_id, read_at FROM operator_mail_reads
      WHERE canvas_name = ${canvasName} AND ${sql.in("thread_id", wanted)}`;
    for (const row of rows) points.set(row.thread_id, pointOf(row));
    return points as ReadonlyMap<string, MailReadPoint>;
  });

/**
 * Read a seat's thread through `through`, or through its newest mail when none
 * is named. Answers the point as it stands after the mark, moved or not, and
 * undefined on a refusal: a thread not of the seat's, a mail not of the
 * thread, or a store that could not be read or written. Never fails.
 */
export const markRead = (canvasName: string, nodeId: string, threadId: string, through?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const messages = seatMailThreadEntries(yield* seatThreadsInput(canvasName), nodeId).get(threadId);
    if (messages === undefined || messages.length === 0) return undefined;
    const target = through === undefined ? messages.at(-1) : messages.find((message) => message.messageId === through);
    if (target === undefined) return undefined;
    const moves = (held: MailReadPoint | undefined) => held === undefined || mailAfter(target, readPointKey(held));
    // The common case, a mark that moves nothing, reads once and opens no transaction.
    const before = yield* heldPoint(sql, canvasName, threadId);
    if (!moves(before)) return before;
    const seats = [...new Set(messages.flatMap((message) => [message.from, ...message.to]).flatMap((party) => (party.kind === "seat" ? [party.nodeId] : [])))];
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const held = yield* heldPoint(sql, canvasName, threadId);
        if (!moves(held)) return held;
        const at = Date.now();
        yield* sql`INSERT INTO operator_mail_reads (canvas_name, thread_id, through_message_id, through_at, read_at)
          VALUES (${canvasName}, ${threadId}, ${target.messageId}, ${target.at}, ${at})
          ON CONFLICT (canvas_name, thread_id) DO UPDATE SET
            through_message_id = excluded.through_message_id, through_at = excluded.through_at, read_at = excluded.read_at`;
        yield* afterSqlCommit(sql, () => announce({ canvasName, threadId, seats }));
        return { through: target.messageId, at } satisfies MailReadPoint;
      }),
    ).pipe(Effect.provideService(StateTransactionOperation, "mail.markRead"));
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error(`[mail-reads] ${canvasName}/${threadId} could not be marked read:`, error);
        return undefined;
      })),
  );
