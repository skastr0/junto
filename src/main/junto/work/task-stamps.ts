/**
 * Task stamps on the verdict table (plan 04, ruling 1b). A stamp is a
 * `work_review_verdicts` row on a task subject, keyed by the reviewer's node:
 * a seat stamp names `reviewer_node_id`, an operator stamp names no one, and
 * neither carries seat ids, which only a seat's verdict on a commit needs.
 * approve and changes are written as green and blocking, so the review gate
 * reads one table.
 *
 * The verdict id derives from (canvas, task, epoch, reviewer, at), so the
 * ruler and every replica folding its ruling write the same row, and writing
 * it twice is a no-op. Only the id's conflict is: a row that breaks a CHECK
 * fails the write, so a ruled stamp is never dropped.
 *
 * A stamp without a subject hash stores its verdict id in `subject_hash`
 * (the column is required); reading it back, that hash is no hash.
 */

import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { NodeId } from "@shared/physics/schema";
import { reviewerKey, seatNodeId, type Stamp, type TaskId, type TaskNodeId } from "@shared/task-model";
import { WorkMutationContext, unjournaledWorkMutationEffect } from "./mutation-seam";

const STAMP_VERDICT_DOMAIN = "junto/task-stamp/v1";

export const stampVerdictId = (canvas: string, taskId: TaskId, stamp: Stamp): string =>
  `stamp_${
    createHash("sha256")
      .update(JSON.stringify([STAMP_VERDICT_DOMAIN, canvas, taskId, stamp.epoch, reviewerKey(stamp.reviewer), stamp.at]), "utf8")
      .digest("hex")
  }`;

/**
 * Run a verdict write under the work-table seam: inside a transaction that
 * already explains its writes as is, otherwise declared as a review verdict.
 * Outside any seam (a bare client, as in tests) it runs as is.
 */
const admitted = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const scope = yield* WorkMutationContext;
    return scope === null || scope.journaled || scope.unjournaled !== undefined
      ? yield* body
      : yield* unjournaledWorkMutationEffect("crew.review-verdict", body);
  });

/** Write a task's stamps at its node; stamps already written are left as they are. */
export const writeTaskStamps = (
  sql: SqlClient.SqlClient,
  canvas: string,
  task: { readonly id: TaskId; readonly node: TaskNodeId; readonly stamps: ReadonlyArray<Stamp> },
) =>
  task.stamps.length === 0
    ? Effect.void
    : admitted(Effect.forEach(task.stamps, (stamp) => {
      const verdictId = stampVerdictId(canvas, task.id, stamp);
      return sql`
        INSERT INTO work_review_verdicts (
          verdict_id, kind, reviewer_kind, reviewer_seat_id, reviewer_node_id, author_seat_id,
          subject_kind, subject_task_installation, subject_task_canvas, subject_task_node, subject_task_item,
          subject_epoch, subject_sha, subject_checkout, subject_hash, epoch, findings_json, refs_json, posted_at_ms
        ) VALUES (
          ${verdictId}, ${stamp.verdict === "approve" ? "green" : "blocking"}, ${stamp.reviewer.kind}, NULL,
          ${stamp.reviewer.kind === "seat" ? stamp.reviewer.seat : null}, NULL,
          'task', (SELECT installation_id FROM installation WHERE singleton = 1), ${canvas}, ${task.node}, ${task.id},
          ${stamp.epoch}, NULL, NULL, ${stamp.subjectHash ?? verdictId}, ${stamp.epoch},
          ${JSON.stringify(stamp.text === undefined ? [] : [stamp.text])}, '[]', ${stamp.at}
        )
        ON CONFLICT (verdict_id) DO NOTHING`;
    }, { discard: true }));

const StampRow = Schema.Struct({
  verdict_id: Schema.String,
  kind: Schema.Literals(["green", "blocking"]),
  reviewer_kind: Schema.Literals(["seat", "operator"]),
  reviewer_node_id: Schema.NullOr(Schema.String),
  subject_task_item: Schema.String,
  subject_task_node: Schema.String,
  subject_hash: Schema.String,
  epoch: Schema.Number,
  findings_json: Schema.String,
  posted_at_ms: Schema.Number,
});
type StampRow = typeof StampRow.Type;
const decodeStampRows = Schema.decodeUnknownEffect(Schema.Array(StampRow));
const decodeFindings = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));

/** A stamp row as a stamp, or nothing when it does not decode. */
export const stampOfRow = (row: StampRow): Stamp | undefined => {
  if (row.reviewer_kind === "seat" && row.reviewer_node_id === null) return undefined;
  const findings = decodeFindings(row.findings_json);
  if (findings._tag === "None") return undefined;
  const text = findings.value[0];
  return {
    reviewer: row.reviewer_kind === "operator"
      ? { kind: "operator" }
      : { kind: "seat", seat: seatNodeId(row.reviewer_node_id as NodeId) },
    verdict: row.kind === "green" ? "approve" : "changes",
    epoch: row.epoch,
    ...(row.subject_hash === row.verdict_id ? {} : { subjectHash: row.subject_hash }),
    ...(text === undefined ? {} : { text }),
    at: row.posted_at_ms,
  };
};

/**
 * The stamps of the given tasks on their current layer, oldest first: at the
 * node each sits on now, from the epoch it arrived there with (`since`). A row that does not decode is reported by task id in `unreadable`.
 */
export const readTaskStamps = (
  sql: SqlClient.SqlClient,
  canvas: string,
  heads: ReadonlyArray<{ readonly taskId: string; readonly node: string; readonly since: number }>,
) =>
  Effect.gen(function* () {
    const stamps = new Map<string, Stamp[]>();
    const unreadable = new Set<string>();
    if (heads.length === 0) return { stamps, unreadable };
    const headOf = new Map(heads.map((head) => [head.taskId, head]));
    const rows = yield* decodeStampRows(
      yield* sql`
        SELECT verdict_id, kind, reviewer_kind, reviewer_node_id, subject_task_item, subject_task_node, subject_hash,
          epoch, findings_json, posted_at_ms
        FROM work_review_verdicts
        WHERE subject_kind = 'task' AND subject_task_canvas = ${canvas} AND reviewer_seat_id IS NULL
          AND ${sql.in("subject_task_item", [...headOf.keys()])}
        ORDER BY posted_at_ms, verdict_id`,
    );
    for (const row of rows) {
      const head = headOf.get(row.subject_task_item);
      if (head === undefined || head.node !== row.subject_task_node || row.epoch < head.since) continue;
      const stamp = stampOfRow(row);
      if (stamp === undefined) {
        unreadable.add(row.subject_task_item);
        continue;
      }
      const held = stamps.get(row.subject_task_item);
      if (held === undefined) stamps.set(row.subject_task_item, [stamp]);
      else held.push(stamp);
    }
    return { stamps, unreadable };
  });
