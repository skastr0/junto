/**
 * Install-ops walk: pending proposals → unadmitted tasks.
 *
 * NEW FILE, unwired. Do not import this from boot until GO: Task.admission /
 * Task.raisedBy and a repository persist path must exist first.
 *
 * This module SELECTs product rows and writes only the install-ops marker.
 * It never INSERT/UPDATE/DELETE work_* tables (repository.ts remains the
 * sole work-plane writer) and never touches work_proposal_events.
 *
 * Completeness: marker is complete only when a scan finds no pending
 * proposal without a matching work_tasks row. A no-op persist cannot
 * complete the walk. Failure leaves the marker pending for the next boot.
 */

import { Effect } from "effect";
import {
  BACKFILL_PENDING_PROPOSALS_V1,
  materializePendingProposal,
  planProposalBackfill,
  proposalBackfillTaskKey,
  recoverClaimsFromProposalRecordJson,
  type PendingProposalSnapshot,
  type UnadmittedMaterialization,
} from "@shared/pending-proposal-backfill";
import type { FinishCriteria, Message, WorkMetadata } from "@shared/work-model";
import type { ActorRef } from "@shared/work-reference";
import type {
  InstallOpsError,
  InstallOpsServiceShape,
} from "../install-ops/service";
import type { StateReader, StateRow } from "../state/service";

export { BACKFILL_PENDING_PROPOSALS_V1 } from "@shared/pending-proposal-backfill";

export type PendingProposalBackfillReport = {
  readonly status: "complete" | "already-complete" | "pending";
  readonly materialized: number;
  readonly skipped: number;
};

export class PendingProposalBackfillError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "PendingProposalBackfillError";
  }
}

type StateService = {
  readonly read: <A>(
    operation: string,
    body: (reader: StateReader) => A,
  ) => Effect.Effect<A, unknown>;
};

export type PersistUnadmittedTask = (input: {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly materialization: UnadmittedMaterialization;
}) => Effect.Effect<void, unknown>;

type ProposalScanRow = StateRow & {
  readonly canvas_name: string;
  readonly node_id: string;
  readonly proposal_id: string;
  readonly state: string;
  readonly brief_json: string;
  readonly proposer_seat_id: string;
  readonly proposer_canvas_name: string;
  readonly proposer_node_id: string;
  readonly approved_task_id: string | null;
  readonly metadata_json: string | null;
  readonly reason: string | null;
  readonly depends_on_json: string | null;
  readonly finish_criteria_json: string | null;
};

const tableExists = (reader: StateReader, table: string): boolean =>
  reader.get<{ readonly name: string }>(
    `
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name = ?
    `,
    [table],
  ) !== undefined;

const parseJson = (raw: string, label: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new PendingProposalBackfillError(
      `invalid JSON at ${label}`,
      { cause },
    );
  }
};

const asMessage = (value: unknown, proposalId: string): Message => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PendingProposalBackfillError(
      `proposal "${proposalId}" brief is not an object`,
    );
  }
  const record = value as Record<string, unknown>;
  if (typeof record.messageId !== "string" || record.messageId.length === 0) {
    throw new PendingProposalBackfillError(
      `proposal "${proposalId}" brief is missing messageId`,
    );
  }
  if (typeof record.role !== "string") {
    throw new PendingProposalBackfillError(
      `proposal "${proposalId}" brief is missing role`,
    );
  }
  if (!Array.isArray(record.parts)) {
    throw new PendingProposalBackfillError(
      `proposal "${proposalId}" brief is missing parts`,
    );
  }
  return value as Message;
};

const asActorRef = (row: ProposalScanRow): ActorRef => ({
  seatId: row.proposer_seat_id as ActorRef["seatId"],
  canvasName: row.proposer_canvas_name,
  nodeId: row.proposer_node_id,
});

const snapshotFromRow = (row: ProposalScanRow): PendingProposalSnapshot => {
  const state = row.state;
  if (state !== "pending" && state !== "approved" && state !== "rejected") {
    throw new PendingProposalBackfillError(
      `proposal "${row.proposal_id}" has unknown state ${state}`,
    );
  }
  const dependsOn =
    row.depends_on_json === null
      ? undefined
      : (parseJson(row.depends_on_json, `${row.proposal_id}.dependsOn`) as
          | ReadonlyArray<string>
          | null);
  const finishCriteria =
    row.finish_criteria_json === null
      ? undefined
      : (parseJson(
          row.finish_criteria_json,
          `${row.proposal_id}.finishCriteria`,
        ) as FinishCriteria);
  const metadata =
    row.metadata_json === null
      ? undefined
      : (parseJson(row.metadata_json, `${row.proposal_id}.metadata`) as WorkMetadata);
  return {
    id: row.proposal_id,
    state,
    brief: asMessage(parseJson(row.brief_json, `${row.proposal_id}.brief`), row.proposal_id),
    proposedBy: asActorRef(row),
    ...(row.approved_task_id !== null ? { approvedTaskId: row.approved_task_id } : {}),
    ...(Array.isArray(dependsOn) && dependsOn.length > 0 ? { dependsOn } : {}),
    ...(finishCriteria !== undefined ? { finishCriteria } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(row.reason !== null ? { reason: row.reason } : {}),
  };
};

const loadExistingTaskKeys = (reader: StateReader): Set<string> => {
  if (!tableExists(reader, "work_tasks")) return new Set();
  const rows = reader.all<{
    readonly canvas_name: string;
    readonly node_id: string;
    readonly task_id: string;
  }>(
    `
      SELECT canvas_name, node_id, task_id
      FROM work_tasks
    `,
  );
  return new Set(
    rows.map((row) =>
      proposalBackfillTaskKey(row.canvas_name, row.node_id, row.task_id),
    ),
  );
};

const loadPendingProposalRows = (reader: StateReader): ReadonlyArray<ProposalScanRow> => {
  if (!tableExists(reader, "work_task_proposals")) return [];
  const planningJoin = tableExists(reader, "work_proposal_planning");
  const sql = planningJoin
    ? `
      SELECT
        p.canvas_name,
        p.node_id,
        p.proposal_id,
        p.state,
        p.brief_json,
        p.proposer_seat_id,
        p.proposer_canvas_name,
        p.proposer_node_id,
        p.approved_task_id,
        p.metadata_json,
        p.reason,
        pl.depends_on_json,
        pl.finish_criteria_json
      FROM work_task_proposals p
      LEFT JOIN work_proposal_planning pl
        ON pl.canvas_name = p.canvas_name
        AND pl.node_id = p.node_id
        AND pl.proposal_id = p.proposal_id
      WHERE p.state = 'pending'
      ORDER BY p.canvas_name, p.node_id, p.proposal_id
    `
    : `
      SELECT
        canvas_name,
        node_id,
        proposal_id,
        state,
        brief_json,
        proposer_seat_id,
        proposer_canvas_name,
        proposer_node_id,
        approved_task_id,
        metadata_json,
        reason,
        NULL AS depends_on_json,
        NULL AS finish_criteria_json
      FROM work_task_proposals
      WHERE state = 'pending'
      ORDER BY canvas_name, node_id, proposal_id
    `;
  return reader.all<ProposalScanRow>(sql);
};

const loadCreateRecordJson = (
  reader: StateReader,
  row: ProposalScanRow,
): unknown => {
  if (!tableExists(reader, "work_proposal_events")) return undefined;
  const event = reader.get<{ readonly record_json: string }>(
    `
      SELECT record_json
      FROM work_proposal_events
      WHERE canvas_name = ?
        AND node_id = ?
        AND proposal_id = ?
        AND operation = 'proposal.create'
      ORDER BY length(seq), seq
      LIMIT 1
    `,
    [row.canvas_name, row.node_id, row.proposal_id],
  );
  if (event === undefined) return undefined;
  try {
    return JSON.parse(event.record_json) as unknown;
  } catch {
    return event.record_json;
  }
};

const loadProposalEventsFingerprint = (
  reader: StateReader,
): ReadonlyArray<{ readonly seq: string; readonly sha: string; readonly json: string }> => {
  if (!tableExists(reader, "work_proposal_events")) return [];
  return reader.all<{
    readonly seq: string;
    readonly sha: string;
    readonly json: string;
  }>(
    `
      SELECT seq, content_sha256 AS sha, record_json AS json
      FROM work_proposal_events
      ORDER BY event_home, entity_home, length(seq), seq
    `,
  );
};

/**
 * Run one walk. Safe every boot. Never gates startup — callers must catch
 * and leave the marker pending.
 *
 * `persist` is the GO-time seam: mint a submitted Task through WorkRepository
 * (same id, requested admission operator-gated, raisedBy = proposedBy).
 */
export const runPendingProposalBackfill = (input: {
  readonly state: StateService;
  readonly installOps: InstallOpsServiceShape;
  readonly persist: PersistUnadmittedTask;
}): Effect.Effect<
  PendingProposalBackfillReport,
  PendingProposalBackfillError | InstallOpsError | unknown
> =>
  Effect.gen(function* () {
    const backfillId = BACKFILL_PENDING_PROPOSALS_V1;
    const marker = yield* input.installOps.getBackfill(backfillId);
    if (marker?.status === "complete") {
      return {
        status: "already-complete" as const,
        materialized: 0,
        skipped: 0,
      };
    }

    yield* input.installOps.ensurePending(backfillId);

    const eventsBefore = yield* input.state.read(
      "work.pending-proposals.fingerprint-before",
      loadProposalEventsFingerprint,
    );

    const scan = yield* input.state.read(
      "work.pending-proposals.scan",
      (reader) => ({
        rows: loadPendingProposalRows(reader),
        existing: loadExistingTaskKeys(reader),
      }),
    );

    let materialized = 0;
    let skipped = 0;

    for (const row of scan.rows) {
      const plan = planProposalBackfill({
        state: row.state as PendingProposalSnapshot["state"],
        proposalId: row.proposal_id,
        canvasName: row.canvas_name,
        nodeId: row.node_id,
        ...(row.approved_task_id !== null
          ? { approvedTaskId: row.approved_task_id }
          : {}),
        existingTaskKeys: scan.existing,
      });
      if (plan.action === "skip") {
        skipped += 1;
        continue;
      }

      const recordJson = yield* input.state.read(
        "work.pending-proposals.claims",
        (reader) => loadCreateRecordJson(reader, row),
      );
      const snapshot = snapshotFromRow(row);
      const materialization = materializePendingProposal({
        proposal: snapshot,
        claimsFromRecord: recoverClaimsFromProposalRecordJson(recordJson),
      });
      yield* input.persist({
        canvasName: row.canvas_name,
        nodeId: row.node_id,
        materialization,
      });
      scan.existing.add(
        proposalBackfillTaskKey(row.canvas_name, row.node_id, row.proposal_id),
      );
      materialized += 1;
    }

    const eventsAfter = yield* input.state.read(
      "work.pending-proposals.fingerprint-after",
      loadProposalEventsFingerprint,
    );
    if (JSON.stringify(eventsBefore) !== JSON.stringify(eventsAfter)) {
      return yield* Effect.fail(
        new PendingProposalBackfillError(
          "work_proposal_events mutated during pending-proposal backfill",
        ),
      );
    }

    const remaining = yield* input.state.read(
      "work.pending-proposals.remaining",
      (reader) => {
        const existing = loadExistingTaskKeys(reader);
        return loadPendingProposalRows(reader).filter((row) => {
          const plan = planProposalBackfill({
            state: "pending",
            proposalId: row.proposal_id,
            canvasName: row.canvas_name,
            nodeId: row.node_id,
            existingTaskKeys: existing,
          });
          return plan.action === "materialize";
        }).length;
      },
    );

    if (remaining > 0) {
      return {
        status: "pending" as const,
        materialized,
        skipped,
      };
    }

    yield* input.installOps.markComplete(backfillId, materialized);
    return {
      status: "complete" as const,
      materialized,
      skipped,
    };
  });
