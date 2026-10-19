/**
 * Durable store for crew review verdicts, review receipts, and checkout
 * observations, over the product SqlClient (no second database or connection).
 * Standalone methods own transactions; participants compose with Work's
 * transaction on the same client.
 *
 * Review verdicts are immutable rows keyed by a unique verdict id, bound to the
 * full task identity plus epoch plus canonical subject hash. The gate query
 * takes each reviewer's latest verdict, so a blocking that follows a green
 * withdraws that reviewer's approval.
 */

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { StateTransactionOperation } from "../state/service";
import { unjournaledWorkMutationEffect } from "./mutation-seam";
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
      latest.set(row.reviewer_seat_id, {
        at: row.posted_at_ms,
        kind: row.kind,
      });
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
        : {
            kind: "commit",
            sha: row.subject_sha ?? "",
            subjectHash: row.subject_hash,
          },
    subjectHash: row.subject_hash,
    epoch: row.epoch,
    findings: JSON.parse(row.findings_json) as string[],
    refs: JSON.parse(row.refs_json) as ReadonlyArray<unknown>,
    postedAtMs: row.posted_at_ms,
  });

export type CrewRepositoryShape = {
  /** Participants join the caller's SQL transaction and never commit it. */
  readonly postVerdictWithin: (
    verdict: typeof ReviewVerdict.Type,
  ) => Effect.Effect<
    { readonly verdict: typeof ReviewVerdict.Type; readonly created: boolean },
    CrewRepositoryError
  >;
  readonly recordReviewReceiptWithin: (
    input: ReviewReceiptInput,
  ) => Effect.Effect<boolean, CrewRepositoryError>;
  /** Post a verdict in its own transaction. Immutable, idempotent by id. */
  readonly postVerdict: (
    verdict: typeof ReviewVerdict.Type,
  ) => Effect.Effect<
    { readonly verdict: typeof ReviewVerdict.Type; readonly created: boolean },
    CrewRepositoryError
  >;
  readonly verdictsForSubject: (
    subject: VerdictSubjectIdentity,
  ) => Effect.Effect<
    ReadonlyArray<typeof ReviewVerdict.Type>,
    CrewRepositoryError
  >;
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
    const sql = yield* SqlClient.SqlClient;
    const changed = Schema.decodeUnknownEffect(
      Schema.Struct({
        changes: Schema.Union([Schema.Number, Schema.BigInt]),
      }),
    );
    const verdictRows = SqlSchema.findAll({
      Request: Schema.Union([
        Schema.Struct({
          kind: Schema.Literal("task"),
          installationId: Schema.String,
          canvasName: Schema.String,
          nodeId: Schema.String,
          taskId: Schema.String,
        }),
        Schema.Struct({ kind: Schema.Literal("commit"), sha: Schema.String }),
      ]),
      Result: Schema.Struct({
        verdict_id: Schema.String,
        kind: Schema.String,
        reviewer_seat_id: Schema.String,
        reviewer_node_id: Schema.NullOr(Schema.String),
        author_seat_id: Schema.String,
        subject_kind: Schema.String,
        subject_task_installation: Schema.NullOr(Schema.String),
        subject_task_canvas: Schema.NullOr(Schema.String),
        subject_task_node: Schema.NullOr(Schema.String),
        subject_task_item: Schema.NullOr(Schema.String),
        subject_epoch: Schema.NullOr(Schema.Number),
        subject_sha: Schema.NullOr(Schema.String),
        subject_hash: Schema.String,
        epoch: Schema.Number,
        findings_json: Schema.String,
        refs_json: Schema.String,
        posted_at_ms: Schema.Number,
      }),
      execute: (subject) =>
        subject.kind === "task"
          ? sql`SELECT * FROM work_review_verdicts
            WHERE subject_kind = 'task' AND subject_task_installation = ${subject.installationId}
              AND subject_task_canvas = ${subject.canvasName} AND subject_task_node = ${subject.nodeId}
              AND subject_task_item = ${subject.taskId} ORDER BY posted_at_ms, verdict_id`
          : sql`SELECT * FROM work_review_verdicts
            WHERE subject_kind = 'commit' AND subject_sha = ${subject.sha} ORDER BY posted_at_ms, verdict_id`,
    });
    const greenRows = SqlSchema.findAll({
      Request: Schema.Struct({
        installationId: Schema.String,
        canvasName: Schema.String,
        nodeId: Schema.String,
        taskId: Schema.String,
        epoch: Schema.Number,
        subjectHash: Schema.String,
        excludingSeatId: Schema.String,
      }),
      Result: Schema.Struct({
        reviewer_seat_id: Schema.String,
        kind: Schema.String,
        posted_at_ms: Schema.Number,
      }),
      execute: (
        input,
      ) => sql`SELECT reviewer_seat_id, kind, posted_at_ms FROM work_review_verdicts
        WHERE subject_kind = 'task' AND subject_task_installation = ${input.installationId}
          AND subject_task_canvas = ${input.canvasName} AND subject_task_node = ${input.nodeId}
          AND subject_task_item = ${input.taskId} AND epoch = ${input.epoch}
          AND subject_hash = ${input.subjectHash} AND reviewer_seat_id <> ${input.excludingSeatId}`,
    });
    const authorRow = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ author_seat_id: Schema.String }),
      execute: (refSha) => sql`SELECT author_seat_id FROM work_review_receipts
        WHERE ref_sha = ${refSha} ORDER BY created_at, source_id LIMIT 1`,
    });

    const postVerdictWithin = Effect.fn("crew.postVerdictWithin")(
      function* (verdict: typeof ReviewVerdict.Type) {
        const subject = verdict.subject;
        const result = yield* unjournaledWorkMutationEffect(
          "crew.review-verdict",
          sql`
        INSERT OR IGNORE INTO work_review_verdicts(
          verdict_id, kind, reviewer_seat_id, reviewer_node_id, author_seat_id,
          subject_kind, subject_task_installation, subject_task_canvas, subject_task_node,
          subject_task_item, subject_epoch, subject_sha, subject_checkout, subject_hash,
          epoch, findings_json, refs_json, posted_at_ms
        ) VALUES (${verdict.verdictId}, ${verdict.kind}, ${verdict.reviewerSeatId},
          ${verdict.reviewerNodeId ?? null}, ${verdict.authorSeatId}, ${subject.kind},
          ${subject.kind === "task" ? subject.installationId : null},
          ${subject.kind === "task" ? subject.canvasName : null},
          ${subject.kind === "task" ? subject.nodeId : null},
          ${subject.kind === "task" ? subject.taskId : null},
          ${subject.kind === "task" ? subject.epoch : null},
          ${subject.kind === "commit" ? subject.sha : null}, ${null},
          ${verdict.subjectHash}, ${verdict.epoch}, ${JSON.stringify(verdict.findings)},
          ${JSON.stringify(verdict.refs)}, ${verdict.postedAtMs})
      `.raw.pipe(Effect.flatMap(changed)),
        );
        return { verdict, created: Number(result.changes) > 0 };
      },
      Effect.mapError((error) => toCrewError("crew.postVerdict", error)),
    );

    const verdictsForSubject = Effect.fn("crew.verdictsForSubject")(
      function* (subject: VerdictSubjectIdentity) {
        const rows = yield* verdictRows(subject);
        return yield* Effect.try({
          try: () => rows.map(verdictFromRow),
          catch: (error) => error,
        });
      },
      Effect.mapError((error) => toCrewError("crew.verdictsForSubject", error)),
    );

    const currentGreenExists = (input: CurrentGreenInput) =>
      greenRows(input).pipe(
        Effect.map(anyReviewerLatestGreen),
        Effect.mapError((error) =>
          toCrewError("crew.currentGreenExists", error),
        ),
      );

    const recordReviewReceiptWithin = Effect.fn(
      "crew.recordReviewReceiptWithin",
    )(
      function* (input: ReviewReceiptInput) {
        const result = yield* unjournaledWorkMutationEffect(
          "crew.review-receipt",
          sql`
        INSERT OR IGNORE INTO work_review_receipts(
          canvas_name, source_kind, source_id, ref_sha, reviewer_seat_id,
          task_id, author_seat_id, message_id, created_at
        ) VALUES (${input.canvasName}, ${input.sourceKind}, ${input.sourceId}, ${input.refSha},
          ${input.reviewerSeatId}, ${input.taskId ?? null}, ${input.authorSeatId},
          ${input.messageId ?? null}, ${input.createdAt})
      `.raw.pipe(Effect.flatMap(changed)),
        );
        return Number(result.changes) > 0;
      },
      Effect.mapError((error) =>
        toCrewError("crew.recordReviewReceipt", error),
      ),
    );

    const postVerdict = (verdict: typeof ReviewVerdict.Type) =>
      postVerdictWithin(verdict).pipe(
        sql.withTransaction,
        Effect.provideService(StateTransactionOperation, "crew.postVerdict"),
        Effect.mapError((error) => toCrewError("crew.postVerdict", error)),
      );
    const recordReviewReceipt = (input: ReviewReceiptInput) =>
      recordReviewReceiptWithin(input).pipe(
        sql.withTransaction,
        Effect.provideService(
          StateTransactionOperation,
          "crew.recordReviewReceipt",
        ),
        Effect.mapError((error) =>
          toCrewError("crew.recordReviewReceipt", error),
        ),
      );
    const recordCheckoutObservation = Effect.fn(
      "crew.recordCheckoutObservation",
    )(
      function* (input: CheckoutObservationInput) {
        const result = yield* unjournaledWorkMutationEffect(
          "crew.checkout-observation",
          sql`
        INSERT OR IGNORE INTO work_review_checkout_observations(
          checkout_key, sha, seat_id, task_id, attributed_via, observed_at
        ) VALUES (${input.checkoutKey}, ${input.sha}, ${input.seatId ?? null},
          ${input.taskId ?? null}, ${input.attributedVia ?? null}, ${input.observedAt})
      `.raw.pipe(Effect.flatMap(changed)),
        );
        return Number(result.changes) > 0;
      },
      sql.withTransaction,
      Effect.provideService(
        StateTransactionOperation,
        "crew.recordCheckoutObservation",
      ),
      Effect.mapError((error) =>
        toCrewError("crew.recordCheckoutObservation", error),
      ),
    );

    const firstAuthorForSha = (refSha: string) =>
      authorRow(refSha).pipe(
        Effect.map((row) =>
          row._tag === "Some" ? row.value.author_seat_id : undefined,
        ),
        Effect.mapError((error) =>
          toCrewError("crew.firstAuthorForSha", error),
        ),
      );

    return {
      postVerdictWithin,
      recordReviewReceiptWithin,
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
