/**
 * Durable store for crew mail delivery attempts and review verdicts, over the
 * one product StateEngine (no second database, no extra connection). It shares
 * the same runtime as the Work repository: `CrewRepositoryLive` depends on the
 * StateEngine service the rest of the process already provides.
 *
 * Delivery attempts are the transport truth per (message, recipient seat,
 * recipient generation). They are enqueued (durably) before any transport
 * action, an intent witness (`attemptedAt`) is stamped immediately before the
 * physical write, and the terminal facts are stamped set-once afterwards so no
 * fact ever clears another. Recovery maps a crashed intent (attempted, no
 * outcome) to `unresolved`, preserving uncertainty and preventing a blind
 * same-generation replay. Exactly-once across an external-TUI crash is not
 * promised.
 *
 * Review verdicts are immutable rows keyed by a unique verdict id, bound to the
 * full task identity plus epoch plus canonical subject hash. The gate query
 * takes each reviewer's latest verdict, so a blocking that follows a green
 * withdraws that reviewer's approval.
 */

import { Context, Effect, Layer, Schema } from "effect";
import { StateEngine } from "../state/engine";
import type { StateReader, StateWriter } from "../state/service";
import {
  unjournaledWorkMutation,
  type UnjournaledWorkReason,
} from "./mutation-seam";
import {
  DeliveryAttempt,
  MailAttemptReason,
  MailDeliveryPolicy,
  ReviewVerdict,
  VERDICT_SUBJECT_HASH_DOMAIN,
} from "../../../shared/crew";

export { subjectHashOf } from "./review-subject-hash";

export class CrewRepositoryError extends Schema.TaggedError<CrewRepositoryError>()(
  "CrewRepositoryError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

const toCrewError = (operation: string, error: unknown): CrewRepositoryError =>
  error instanceof CrewRepositoryError
    ? error
    : CrewRepositoryError.make({
        operation,
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });

/** The recipient sink: the canvas node whose seat owns the mailbox. */
export type CrewSink = {
  readonly canvasName: string;
  readonly nodeId: string;
};

export type EnqueueAttemptInput = {
  readonly sink: CrewSink;
  readonly messageId: string;
  readonly recipientSeatId: string;
  readonly recipientGeneration: string;
  readonly policy: MailDeliveryPolicy;
  readonly batchId?: string;
  readonly at: string;
};

export type AttemptOutcome =
  | { readonly kind: "notified"; readonly at: string }
  | { readonly kind: "unresolved"; readonly at: string }
  | {
      readonly kind: "refused";
      readonly at: string;
      readonly reason: typeof MailAttemptReason.Type;
    };

export type RecordAttemptInput = {
  readonly sink: CrewSink;
  readonly messageId: string;
  readonly recipientSeatId: string;
  readonly recipientGeneration: string;
  readonly outcome: AttemptOutcome;
  readonly write?: {
    readonly writesBefore: number;
    readonly writesAfter: number;
    readonly at: string;
  };
};

export type AttemptKey = {
  readonly sink: CrewSink;
  readonly messageId: string;
  readonly recipientSeatId: string;
  readonly recipientGeneration: string;
};

export type VerdictSubjectIdentity =
  | {
      readonly kind: "task";
      readonly installationId: string;
      readonly canvasName: string;
      readonly nodeId: string;
      readonly taskId: string;
    }
  | { readonly kind: "commit"; readonly sha: string };

export type CurrentGreenInput = {
  readonly installationId: string;
  readonly canvasName: string;
  readonly nodeId: string;
  readonly taskId: string;
  readonly epoch: number;
  readonly subjectHash: string;
  readonly excludingSeatId: string;
};

export type ReviewReceiptInput = {
  readonly canvasName: string;
  readonly sourceKind: "task-fact" | "checkout";
  readonly sourceId: string;
  readonly refSha: string;
  readonly reviewerSeatId: string;
  readonly authorSeatId: string;
  readonly taskId?: string;
  readonly messageId?: string;
  readonly createdAt: string;
};

export type CheckoutObservationInput = {
  readonly checkoutKey: string;
  readonly sha: string;
  readonly seatId?: string;
  readonly taskId?: string;
  readonly attributedVia?: "claim-context" | "update-context";
  readonly observedAt: string;
};

const decodeAttempt = Schema.decodeUnknownSync(DeliveryAttempt);
const decodeVerdict = Schema.decodeUnknownSync(ReviewVerdict);

/**
 * Each reviewer's latest verdict, then true if any is green. Latest is by max
 * postedAtMs; on a tie (same reviewer, same postedAtMs) BLOCKING WINS
 * regardless of insertion or array order (root tie ruling). verdict id only
 * breaks ties among same-kind rows, which never changes the outcome.
 */
export const anyReviewerLatestGreen = (
  rows: ReadonlyArray<{
    readonly reviewer_seat_id: string;
    readonly kind: string;
    readonly posted_at_ms: number;
  }>,
): boolean => {
  const latest = new Map<string, { at: number; kind: string }>();
  for (const row of rows) {
    const prior = latest.get(row.reviewer_seat_id);
    if (prior === undefined || row.posted_at_ms > prior.at) {
      latest.set(row.reviewer_seat_id, { at: row.posted_at_ms, kind: row.kind });
    } else if (row.posted_at_ms === prior.at && row.kind === "blocking") {
      // Tie at the latest instant: blocking wins.
      latest.set(row.reviewer_seat_id, { at: prior.at, kind: "blocking" });
    }
  }
  for (const entry of latest.values()) {
    if (entry.kind === "green") return true;
  }
  return false;
};

type AttemptRow = {
  readonly canvas_name: string;
  readonly node_id: string;
  readonly message_id: string;
  readonly recipient_seat_id: string;
  readonly recipient_generation: string;
  readonly policy: string;
  readonly batch_id: string | null;
  readonly queued_at: string;
  readonly attempted_at: string | null;
  readonly notified_at: string | null;
  readonly unresolved_at: string | null;
  readonly refused_at: string | null;
  readonly refused_reason: string | null;
  readonly writes_before: number | null;
  readonly writes_after: number | null;
  readonly write_at: string | null;
  readonly attempt_seq: number;
  readonly resolved_seq: number;
};

const attemptFromRow = (row: AttemptRow): typeof DeliveryAttempt.Type =>
  decodeAttempt({
    messageId: row.message_id,
    recipient: {
      seat: {
        seatId: row.recipient_seat_id,
        canvasName: row.canvas_name,
        nodeId: row.node_id,
      },
      generation: row.recipient_generation,
    },
    policy: row.policy,
    ...(row.batch_id !== null ? { batchId: row.batch_id } : {}),
    facts: {
      generation: row.recipient_generation,
      queuedAt: row.queued_at,
      ...(row.attempted_at !== null ? { attemptedAt: row.attempted_at } : {}),
      ...(row.notified_at !== null ? { notifiedAt: row.notified_at } : {}),
      ...(row.unresolved_at !== null ? { unresolvedAt: row.unresolved_at } : {}),
      ...(row.refused_at !== null ? { refusedAt: row.refused_at } : {}),
      ...(row.refused_reason !== null ? { refusedReason: row.refused_reason } : {}),
    },
    ...(row.writes_before !== null &&
    row.writes_after !== null &&
    row.write_at !== null
      ? {
          write: {
            writesBefore: row.writes_before,
            writesAfter: row.writes_after,
            at: row.write_at,
          },
        }
      : {}),
  });

const readAttemptRow = (
  reader: StateReader,
  key: AttemptKey,
): AttemptRow | undefined =>
  reader.get<AttemptRow>(
    `SELECT * FROM work_mail_attempts
     WHERE canvas_name = ? AND node_id = ? AND message_id = ?
       AND recipient_seat_id = ? AND recipient_generation = ?`,
    [
      key.sink.canvasName,
      key.sink.nodeId,
      key.messageId,
      key.recipientSeatId,
      key.recipientGeneration,
    ],
  );

type VerdictRow = {
  readonly verdict_id: string;
  readonly kind: string;
  readonly reviewer_seat_id: string;
  readonly reviewer_node_id: string | null;
  readonly author_seat_id: string;
  readonly subject_kind: string;
  readonly subject_task_installation: string | null;
  readonly subject_task_canvas: string | null;
  readonly subject_task_node: string | null;
  readonly subject_task_item: string | null;
  readonly subject_epoch: number | null;
  readonly subject_sha: string | null;
  readonly subject_hash: string;
  readonly epoch: number;
  readonly findings_json: string;
  readonly refs_json: string;
  readonly posted_at_ms: number;
};

const verdictFromRow = (row: VerdictRow): typeof ReviewVerdict.Type =>
  decodeVerdict({
    verdictId: row.verdict_id,
    kind: row.kind,
    reviewerSeatId: row.reviewer_seat_id,
    ...(row.reviewer_node_id !== null
      ? { reviewerNodeId: row.reviewer_node_id }
      : {}),
    authorSeatId: row.author_seat_id,
    subject:
      row.subject_kind === "task"
        ? {
            kind: "task",
            installationId: row.subject_task_installation ?? "",
            canvasName: row.subject_task_canvas ?? "",
            nodeId: row.subject_task_node ?? "",
            taskId: row.subject_task_item ?? "",
            epoch: row.subject_epoch ?? 0,
            subjectHash: row.subject_hash,
          }
        : { kind: "commit", sha: row.subject_sha ?? "", subjectHash: row.subject_hash },
    subjectHash: row.subject_hash,
    epoch: row.epoch,
    findings: JSON.parse(row.findings_json) as string[],
    refs: JSON.parse(row.refs_json) as ReadonlyArray<unknown>,
    postedAtMs: row.posted_at_ms,
  });

/**
 * Insert one verdict via a caller-owned StateWriter, so a blocking verdict and
 * the task send-back it triggers commit in ONE transaction. StateEngine forbids
 * nested transactions, so a composing caller opens a single
 * `state.transaction` and calls this inside it. Insert-once by verdict id
 * (a repost of the same id is a no-op).
 */
export const applyVerdictWrite = (
  writer: StateWriter,
  verdict: typeof ReviewVerdict.Type,
): void => {
  const subject = verdict.subject;
  writer.run(
    `INSERT OR IGNORE INTO work_review_verdicts(
       verdict_id, kind, reviewer_seat_id, reviewer_node_id, author_seat_id,
       subject_kind, subject_task_installation, subject_task_canvas,
       subject_task_node, subject_task_item, subject_epoch, subject_sha,
       subject_checkout, subject_hash, epoch, findings_json, refs_json,
       posted_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      verdict.verdictId,
      verdict.kind,
      verdict.reviewerSeatId,
      verdict.reviewerNodeId ?? null,
      verdict.authorSeatId,
      subject.kind,
      subject.kind === "task" ? subject.installationId : null,
      subject.kind === "task" ? subject.canvasName : null,
      subject.kind === "task" ? subject.nodeId : null,
      subject.kind === "task" ? subject.taskId : null,
      subject.kind === "task" ? subject.epoch : null,
      subject.kind === "commit" ? subject.sha : null,
      null,
      verdict.subjectHash,
      verdict.epoch,
      JSON.stringify(verdict.findings),
      JSON.stringify(verdict.refs),
      verdict.postedAtMs,
    ],
  );
};

/** Rows for the gate query, ordered so JS reduction sees each reviewer's history. */
const gateRows = (
  reader: StateReader,
  input: {
    readonly installationId: string;
    readonly canvasName: string;
    readonly nodeId: string;
    readonly taskId: string;
    readonly epoch: number;
    readonly subjectHash: string;
    readonly excludingSeatId: string;
  },
): ReadonlyArray<{
  readonly reviewer_seat_id: string;
  readonly kind: string;
  readonly posted_at_ms: number;
}> =>
  reader.all(
    `SELECT reviewer_seat_id, kind, posted_at_ms
       FROM work_review_verdicts
     WHERE subject_kind = 'task'
       AND subject_task_installation = ?
       AND subject_task_canvas = ?
       AND subject_task_node = ?
       AND subject_task_item = ?
       AND epoch = ?
       AND subject_hash = ?
       AND reviewer_seat_id <> ?`,
    [
      input.installationId,
      input.canvasName,
      input.nodeId,
      input.taskId,
      input.epoch,
      input.subjectHash,
      input.excludingSeatId,
    ],
  ) as ReadonlyArray<{
    readonly reviewer_seat_id: string;
    readonly kind: string;
    readonly posted_at_ms: number;
  }>;

/**
 * Writer-time review gate, the SAME rule as {@link CrewRepository.currentGreenExists}
 * but callable synchronously inside a caller-owned transaction so the completion
 * check and the completion write commit together — a concurrent blocking, new
 * epoch, or changed subject that lands between a service preflight and the
 * commit is caught here at write time. A distinct eligible reviewer's latest
 * verdict on the exact identity + epoch + subject hash must be green.
 */
export const reviewGateSatisfiedWithin = (
  reader: StateReader,
  input: {
    readonly installationId: string;
    readonly canvasName: string;
    readonly nodeId: string;
    readonly taskId: string;
    readonly epoch: number;
    readonly subjectHash: string;
    readonly excludingSeatId: string;
  },
): boolean => anyReviewerLatestGreen(gateRows(reader, input));

/**
 * Insert one review receipt via a caller-owned StateWriter, so the receipt
 * dedupe row commits in the same transaction as the task mutation that minted
 * it. Insert-once by the receipt's unique key.
 */
export const applyReviewReceiptWrite = (
  writer: StateWriter,
  input: ReviewReceiptInput,
): void => {
  writer.run(
    `INSERT OR IGNORE INTO work_review_receipts(
       canvas_name, source_kind, source_id, ref_sha, reviewer_seat_id,
       task_id, author_seat_id, message_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.canvasName,
      input.sourceKind,
      input.sourceId,
      input.refSha,
      input.reviewerSeatId,
      input.taskId ?? null,
      input.authorSeatId,
      input.messageId ?? null,
      input.createdAt,
    ],
  );
};

export type CrewRepositoryShape = {
  /** Durable queued row before any transport action. Idempotent per key. */
  readonly enqueueAttempt: (
    input: EnqueueAttemptInput,
  ) => Effect.Effect<
    { readonly attempt: typeof DeliveryAttempt.Type; readonly created: boolean },
    CrewRepositoryError
  >;
  /** Atomic durable membership for a batched notify: all members before transport. */
  readonly enqueueBatch: (input: {
    readonly members: ReadonlyArray<EnqueueAttemptInput>;
  }) => Effect.Effect<ReadonlyArray<typeof DeliveryAttempt.Type>, CrewRepositoryError>;
  /** Stamp the intent witness immediately BEFORE the physical write. Set-once. */
  readonly markAttempted: (
    input: AttemptKey & { readonly at: string },
  ) => Effect.Effect<void, CrewRepositoryError>;
  /** Stamp a terminal outcome and optional write evidence. Each fact set-once. */
  readonly recordAttempt: (
    input: RecordAttemptInput,
  ) => Effect.Effect<typeof DeliveryAttempt.Type, CrewRepositoryError>;
  readonly attempt: (
    key: AttemptKey,
  ) => Effect.Effect<typeof DeliveryAttempt.Type | undefined, CrewRepositoryError>;
  readonly attemptsForMessage: (
    sink: CrewSink,
    messageId: string,
  ) => Effect.Effect<ReadonlyArray<typeof DeliveryAttempt.Type>, CrewRepositoryError>;
  /** True if any generation of this message to this seat reached notified. */
  readonly hasNotifiedAcrossGenerations: (
    sink: CrewSink,
    messageId: string,
    recipientSeatId: string,
  ) => Effect.Effect<boolean, CrewRepositoryError>;
  /**
   * Boot recovery: a crashed intent (attempted, no terminal outcome) becomes
   * unresolved. Returns how many rows were reconciled.
   */
  readonly reconcileUnresolvedAttempts: (
    at: string,
  ) => Effect.Effect<number, CrewRepositoryError>;
  /** Post a verdict in its own transaction. Immutable, idempotent by id. */
  readonly postVerdict: (
    verdict: typeof ReviewVerdict.Type,
  ) => Effect.Effect<
    { readonly verdict: typeof ReviewVerdict.Type; readonly created: boolean },
    CrewRepositoryError
  >;
  readonly verdictsForSubject: (
    subject: VerdictSubjectIdentity,
  ) => Effect.Effect<ReadonlyArray<typeof ReviewVerdict.Type>, CrewRepositoryError>;
  /**
   * Gate query: a distinct eligible reviewer's LATEST verdict on the exact
   * identity + epoch + subject hash is green (blocking after green does not
   * count).
   */
  readonly currentGreenExists: (
    input: CurrentGreenInput,
  ) => Effect.Effect<boolean, CrewRepositoryError>;
  /** Receipt-feed dedupe + first-seen sha provenance. Returns created. */
  readonly recordReviewReceipt: (
    input: ReviewReceiptInput,
  ) => Effect.Effect<boolean, CrewRepositoryError>;
  /** Watcher record. A null seat is never attributed. Returns created. */
  readonly recordCheckoutObservation: (
    input: CheckoutObservationInput,
  ) => Effect.Effect<boolean, CrewRepositoryError>;
  /** First author recorded for a sha, or undefined. */
  readonly firstAuthorForSha: (
    refSha: string,
  ) => Effect.Effect<string | undefined, CrewRepositoryError>;
};

export type CrewRepository = CrewRepositoryShape;

export const CrewRepository = Context.Service<
  CrewRepository,
  CrewRepositoryShape
>("@vellum-command/CrewRepository");

export const CrewRepositoryLive = Layer.effect(
  CrewRepository,
  Effect.gen(function* () {
    const state = yield* StateEngine;

    // Every crew write is a Command Center-local operational mutation that
    // mints no replicated work fact, so it runs inside one transaction under a
    // declared journal-free reason (see work/mutation-seam.ts).
    const writeTx = <A>(
      op: string,
      body: (writer: StateWriter) => A,
    ): Effect.Effect<A, CrewRepositoryError> =>
      state
        .transaction(op, body)
        .pipe(Effect.mapError((error) => toCrewError(op, error)));

    const insertQueued = (writer: StateWriter, input: EnqueueAttemptInput): void => {
      writer.run(
        `INSERT OR IGNORE INTO work_mail_attempts(
           canvas_name, node_id, message_id, recipient_seat_id,
           recipient_generation, policy, batch_id, queued_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.sink.canvasName,
          input.sink.nodeId,
          input.messageId,
          input.recipientSeatId,
          input.recipientGeneration,
          input.policy,
          input.batchId ?? null,
          input.at,
          input.at,
        ],
      );
    };

    const enqueueAttempt: CrewRepositoryShape["enqueueAttempt"] = (input) =>
      writeTx("crew.enqueueAttempt", (writer) =>
        unjournaledWorkMutation("crew.mail-attempt", () => {
          const before = readAttemptRow(writer, input);
          insertQueued(writer, input);
          const row = readAttemptRow(writer, input);
          if (row === undefined) {
            throw new Error("attempt row missing after enqueue");
          }
          return { attempt: attemptFromRow(row), created: before === undefined };
        }));

    const enqueueBatch: CrewRepositoryShape["enqueueBatch"] = (input) =>
      writeTx("crew.enqueueBatch", (writer) =>
        unjournaledWorkMutation("crew.mail-attempt", () => {
          const out: Array<typeof DeliveryAttempt.Type> = [];
          for (const member of input.members) {
            insertQueued(writer, member);
            // Associate the batch id onto the row whether it was just created or
            // already queued/refused by a prior individual attempt, so an
            // existing member joins this batch. Other facts (queued_at, the
            // refusal facts, intent seq) are preserved; the batch id is the
            // current batch (latest batch wins on a re-batch).
            if (member.batchId !== undefined) {
              writer.run(
                `UPDATE work_mail_attempts SET batch_id = ?, updated_at = ?
                 WHERE canvas_name = ? AND node_id = ? AND message_id = ?
                   AND recipient_seat_id = ? AND recipient_generation = ?`,
                [
                  member.batchId,
                  member.at,
                  member.sink.canvasName,
                  member.sink.nodeId,
                  member.messageId,
                  member.recipientSeatId,
                  member.recipientGeneration,
                ],
              );
            }
            const row = readAttemptRow(writer, member);
            if (row === undefined) {
              throw new Error("batch member row missing after enqueue");
            }
            out.push(attemptFromRow(row));
          }
          return out;
        }));

    const markAttempted: CrewRepositoryShape["markAttempted"] = (input) =>
      writeTx("crew.markAttempted", (writer) =>
        unjournaledWorkMutation("crew.mail-attempt", () => {
          writer.run(
            `UPDATE work_mail_attempts
               SET attempt_seq = attempt_seq + 1,
                   attempted_at = coalesce(attempted_at, ?),
                   updated_at = ?
             WHERE canvas_name = ? AND node_id = ? AND message_id = ?
               AND recipient_seat_id = ? AND recipient_generation = ?`,
            [
              input.at,
              input.at,
              input.sink.canvasName,
              input.sink.nodeId,
              input.messageId,
              input.recipientSeatId,
              input.recipientGeneration,
            ],
          );
        }));

    const recordAttempt: CrewRepositoryShape["recordAttempt"] = (input) =>
      writeTx("crew.recordAttempt", (writer) =>
        unjournaledWorkMutation("crew.mail-attempt", () => {
          const outcome = input.outcome;
          const notifiedAt = outcome.kind === "notified" ? outcome.at : null;
          const unresolvedAt = outcome.kind === "unresolved" ? outcome.at : null;
          const refusedAt = outcome.kind === "refused" ? outcome.at : null;
          const refusedReason = outcome.kind === "refused" ? outcome.reason : null;
          const at = outcome.at;
          writer.run(
            `UPDATE work_mail_attempts SET
               notified_at = coalesce(notified_at, ?),
               unresolved_at = coalesce(unresolved_at, ?),
               refused_at = coalesce(refused_at, ?),
               refused_reason = coalesce(refused_reason, ?),
               writes_before = coalesce(writes_before, ?),
               writes_after = coalesce(writes_after, ?),
               write_at = coalesce(write_at, ?),
               resolved_seq = attempt_seq,
               updated_at = ?
             WHERE canvas_name = ? AND node_id = ? AND message_id = ?
               AND recipient_seat_id = ? AND recipient_generation = ?`,
            [
              notifiedAt,
              unresolvedAt,
              refusedAt,
              refusedReason,
              input.write?.writesBefore ?? null,
              input.write?.writesAfter ?? null,
              input.write?.at ?? null,
              at,
              input.sink.canvasName,
              input.sink.nodeId,
              input.messageId,
              input.recipientSeatId,
              input.recipientGeneration,
            ],
          );
          const row = readAttemptRow(writer, input);
          if (row === undefined) {
            throw new Error("attempt row missing on recordAttempt");
          }
          return attemptFromRow(row);
        }));

    const attempt: CrewRepositoryShape["attempt"] = (key) =>
      state
        .read("crew.attempt", (reader) => {
          const row = readAttemptRow(reader, key);
          return row === undefined ? undefined : attemptFromRow(row);
        })
        .pipe(Effect.mapError((error) => toCrewError("crew.attempt", error)));

    const attemptsForMessage: CrewRepositoryShape["attemptsForMessage"] = (
      sink,
      messageId,
    ) =>
      state
        .read("crew.attemptsForMessage", (reader) =>
          reader
            .all<AttemptRow>(
              `SELECT * FROM work_mail_attempts
               WHERE canvas_name = ? AND node_id = ? AND message_id = ?
               ORDER BY queued_at, recipient_generation`,
              [sink.canvasName, sink.nodeId, messageId],
            )
            .map(attemptFromRow),
        )
        .pipe(
          Effect.mapError((error) =>
            toCrewError("crew.attemptsForMessage", error),
          ),
        );

    const hasNotifiedAcrossGenerations: CrewRepositoryShape["hasNotifiedAcrossGenerations"] =
      (sink, messageId, recipientSeatId) =>
        state
          .read("crew.hasNotifiedAcrossGenerations", (reader) => {
            const row = reader.get<{ readonly n: number }>(
              `SELECT count(*) AS n FROM work_mail_attempts
               WHERE canvas_name = ? AND node_id = ? AND message_id = ?
                 AND recipient_seat_id = ? AND notified_at IS NOT NULL`,
              [sink.canvasName, sink.nodeId, messageId, recipientSeatId],
            );
            return (row?.n ?? 0) > 0;
          })
          .pipe(
            Effect.mapError((error) =>
              toCrewError("crew.hasNotifiedAcrossGenerations", error),
            ),
          );

    const reconcileUnresolvedAttempts: CrewRepositoryShape["reconcileUnresolvedAttempts"] =
      (at) =>
        writeTx("crew.reconcileUnresolvedAttempts", (writer) =>
        unjournaledWorkMutation("crew.mail-attempt", () => {
            // An open physical intent (attempt_seq > resolved_seq) that never
            // recorded an outcome is a crash: reopen it as unresolved and close
            // it, WITHOUT clearing a prior refused_at fact. A clean queued row
            // (never attempted: attempt_seq = 0) is left alone.
            const result = writer.run(
              `UPDATE work_mail_attempts
                 SET unresolved_at = coalesce(unresolved_at, ?),
                     resolved_seq = attempt_seq,
                     updated_at = ?
               WHERE attempt_seq > resolved_seq`,
              [at, at],
            );
            return Number(result.changes ?? 0);
          }));

    const postVerdict: CrewRepositoryShape["postVerdict"] = (verdict) =>
      writeTx("crew.postVerdict", (writer) =>
        unjournaledWorkMutation("crew.review-verdict", () => {
          const before = writer.get<{ readonly verdict_id: string }>(
            `SELECT verdict_id FROM work_review_verdicts WHERE verdict_id = ?`,
            [verdict.verdictId],
          );
          applyVerdictWrite(writer, verdict);
          return { verdict, created: before === undefined };
        }));

    const verdictsForSubject: CrewRepositoryShape["verdictsForSubject"] = (
      subject,
    ) =>
      state
        .read("crew.verdictsForSubject", (reader) => {
          const rows =
            subject.kind === "task"
              ? reader.all<VerdictRow>(
                  `SELECT * FROM work_review_verdicts
                   WHERE subject_kind = 'task'
                     AND subject_task_installation = ?
                     AND subject_task_canvas = ?
                     AND subject_task_node = ?
                     AND subject_task_item = ?
                   ORDER BY posted_at_ms, verdict_id`,
                  [
                    subject.installationId,
                    subject.canvasName,
                    subject.nodeId,
                    subject.taskId,
                  ],
                )
              : reader.all<VerdictRow>(
                  `SELECT * FROM work_review_verdicts
                   WHERE subject_kind = 'commit' AND subject_sha = ?
                   ORDER BY posted_at_ms, verdict_id`,
                  [subject.sha],
                );
          return rows.map(verdictFromRow);
        })
        .pipe(
          Effect.mapError((error) =>
            toCrewError("crew.verdictsForSubject", error),
          ),
        );

    const currentGreenExists: CrewRepositoryShape["currentGreenExists"] = (
      input,
    ) =>
      state
        .read("crew.currentGreenExists", (reader) =>
          reviewGateSatisfiedWithin(reader, input),
        )
        .pipe(
          Effect.mapError((error) =>
            toCrewError("crew.currentGreenExists", error),
          ),
        );

    const recordReviewReceipt: CrewRepositoryShape["recordReviewReceipt"] = (
      input,
    ) =>
      writeTx("crew.recordReviewReceipt", (writer) =>
        unjournaledWorkMutation("crew.review-receipt", () => {
          const before = writer.get<{ readonly n: number }>(
            `SELECT count(*) AS n FROM work_review_receipts
             WHERE canvas_name = ? AND source_kind = ? AND source_id = ?
               AND ref_sha = ? AND reviewer_seat_id = ?`,
            [
              input.canvasName,
              input.sourceKind,
              input.sourceId,
              input.refSha,
              input.reviewerSeatId,
            ],
          );
          applyReviewReceiptWrite(writer, input);
          return (before?.n ?? 0) === 0;
        }));

    const recordCheckoutObservation: CrewRepositoryShape["recordCheckoutObservation"] =
      (input) =>
        writeTx("crew.recordCheckoutObservation", (writer) =>
        unjournaledWorkMutation("crew.checkout-observation", () => {
            const result = writer.run(
              `INSERT OR IGNORE INTO work_review_checkout_observations(
                 checkout_key, sha, seat_id, task_id, attributed_via, observed_at
               ) VALUES (?, ?, ?, ?, ?, ?)`,
              [
                input.checkoutKey,
                input.sha,
                input.seatId ?? null,
                input.taskId ?? null,
                input.attributedVia ?? null,
                input.observedAt,
              ],
            );
            return Number(result.changes ?? 0) > 0;
          }));

    const firstAuthorForSha: CrewRepositoryShape["firstAuthorForSha"] = (
      refSha,
    ) =>
      state
        .read("crew.firstAuthorForSha", (reader) => {
          const row = reader.get<{ readonly author_seat_id: string }>(
            `SELECT author_seat_id FROM work_review_receipts
             WHERE ref_sha = ? ORDER BY created_at, source_id LIMIT 1`,
            [refSha],
          );
          return row?.author_seat_id;
        })
        .pipe(
          Effect.mapError((error) => toCrewError("crew.firstAuthorForSha", error)),
        );

    return {
      enqueueAttempt,
      enqueueBatch,
      markAttempted,
      recordAttempt,
      attempt,
      attemptsForMessage,
      hasNotifiedAcrossGenerations,
      reconcileUnresolvedAttempts,
      postVerdict,
      verdictsForSubject,
      currentGreenExists,
      recordReviewReceipt,
      recordCheckoutObservation,
      firstAuthorForSha,
    };
  }),
);

export { VERDICT_SUBJECT_HASH_DOMAIN };
