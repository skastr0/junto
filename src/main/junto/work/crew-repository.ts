/**
 * Durable store for crew review verdicts, review receipts, and checkout
 * observations, over the one product StateEngine (no second database, no
 * extra connection). It shares the same runtime as the Work repository:
 * `CrewRepositoryLive` depends on the StateEngine service the rest of the
 * process already provides.
 *
 * Review verdicts are immutable rows keyed by a unique verdict id, bound to the
 * full task identity plus epoch plus canonical subject hash. The gate query
 * takes each reviewer's latest verdict, so a blocking that follows a green
 * withdraws that reviewer's approval.
 */

import { Context, Effect, Layer, Schema } from "effect";
import { StateEngine } from "../state/engine";
import { workProjectionChanges } from "./projection-changes";
import type { StateReader, StateWriter } from "../state/service";
import {
  unjournaledWorkMutation,
  type UnjournaledWorkReason,
} from "./mutation-seam";
import {
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
>("@junto/CrewRepository");

export const CrewRepositoryLive = Layer.effect(
  CrewRepository,
  Effect.gen(function* () {
    const state = yield* StateEngine;
    const changes = workProjectionChanges(state);

    // Every crew write is a Command Center-local operational mutation that
    // mints no replicated work fact, so it runs inside one transaction under a
    // declared journal-free reason (see work/mutation-seam.ts).
    const writeTx = <A>(
      op: string,
      body: (writer: StateWriter) => A,
      affected: ReadonlyArray<CrewSink> | ((writer: StateWriter) => ReadonlyArray<CrewSink>) = [],
    ): Effect.Effect<A, CrewRepositoryError> =>
      state.transaction(op, (writer) => {
        const sinks = typeof affected === "function" ? affected(writer) : affected;
        const before = writer.get<{ n: number | bigint }>("SELECT total_changes() AS n")!.n;
        const value = body(writer);
        const changed = writer.get<{ n: number | bigint }>("SELECT total_changes() AS n")!.n !== before;
        return { value, sinks: changed ? sinks : [] };
      }).pipe(
        Effect.mapError((error) => toCrewError(op, error)),
        Effect.tap(({ sinks }) => Effect.sync(() => {
          const seen = new Set<string>();
          for (const sink of sinks) {
            const key = JSON.stringify([sink.canvasName, sink.nodeId]);
            if (!seen.has(key)) changes.notify(sink);
            seen.add(key);
          }
        })),
        Effect.map(({ value }) => value),
      );

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
