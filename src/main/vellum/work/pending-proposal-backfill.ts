/**
 * Install-ops walk: pending proposals → unadmitted tasks.
 *
 * SELECT only; persist is a port (WorkLive wires repository.createTask).
 * Never touches work_proposal_events. Completeness: no pending proposal
 * remains without a matching work_tasks row.
 *
 * Skips (by design, not defects):
 * - rejected proposals — never were tasks; leave as historical proposal rows
 * - approved proposals — live work is already work_tasks at approved_task_id
 *   (possibly a different id); never rewrite those ids
 * - pending whose proposal_id already exists as a work_tasks row (resume)
 * A remaining pending row has an explicit unresolved dependency, invalid
 * durable planning data, or a persist that failed closed. The marker stays
 * pending and a later invocation resumes from exact durable task witnesses.
 */

import { Effect } from "effect";
import {
  BACKFILL_PENDING_PROPOSALS_V1,
  materializePendingProposal,
  planProposalBackfill,
  planProposalBackfillFrontier,
  proposalBackfillDependencyKey,
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
  /** Exact same-id task rows first witnessed during this invocation. */
  readonly materialized: number;
  /** Pending proposals already carrying an exact same-id task row. */
  readonly skipped: number;
  /** Rows whose decode or persist attempt failed during this invocation. */
  readonly failed: number;
  /** Pending proposals still missing an exact same-id task at the final witness. */
  readonly remaining: number;
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

const dependsOnFromRow = (
  row: ProposalScanRow,
): ReadonlyArray<string> | undefined => {
  if (row.depends_on_json === null) return undefined;
  const value = parseJson(
    row.depends_on_json,
    `${row.proposal_id}.dependsOn`,
  );
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string")) {
    throw new PendingProposalBackfillError(
      `proposal "${row.proposal_id}" dependsOn is not a string array`,
    );
  }
  // Preserve the exact authored array. Repository validation owns empties,
  // duplicates, self references, missing ids, and cycles.
  return value;
};

const snapshotFromRow = (row: ProposalScanRow): PendingProposalSnapshot => {
  const state = row.state;
  if (state !== "pending" && state !== "approved" && state !== "rejected") {
    throw new PendingProposalBackfillError(
      `proposal "${row.proposal_id}" has unknown state ${state}`,
    );
  }
  const dependsOn = dependsOnFromRow(row);
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
    ...(dependsOn !== undefined ? { dependsOn } : {}),
    ...(finishCriteria !== undefined ? { finishCriteria } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(row.reason !== null ? { reason: row.reason } : {}),
  };
};

type ExistingTaskIndex = {
  readonly exactKeys: Set<string>;
  readonly dependencyKeys: Set<string>;
};

const loadExistingTaskIndex = (reader: StateReader): ExistingTaskIndex => {
  if (!tableExists(reader, "work_tasks")) {
    return { exactKeys: new Set(), dependencyKeys: new Set() };
  }
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
  return {
    exactKeys: new Set(
      rows.map((row) =>
        proposalBackfillTaskKey(row.canvas_name, row.node_id, row.task_id),
      ),
    ),
    dependencyKeys: new Set(
      rows.map((row) =>
        proposalBackfillDependencyKey(row.canvas_name, row.task_id),
      ),
    ),
  };
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

type ProposalEventWitness = {
  readonly eventHome: string;
  readonly entityHome: string;
  readonly seq: string;
  readonly sha: string;
  readonly json: string;
};

const loadProposalEventWitnesses = (
  reader: StateReader,
): ReadonlyArray<ProposalEventWitness> => {
  if (!tableExists(reader, "work_proposal_events")) return [];
  return reader.all<ProposalEventWitness>(
    `
      SELECT
        event_home AS eventHome,
        entity_home AS entityHome,
        seq,
        content_sha256 AS sha,
        record_json AS json
      FROM work_proposal_events
      ORDER BY event_home, entity_home, length(seq), seq
    `,
  );
};

const proposalEventWitnessKey = (event: ProposalEventWitness): string =>
  JSON.stringify([event.eventHome, event.entityHome, event.seq]);

/** Existing immutable rows must remain byte-identical; concurrent appends are valid. */
const proposalEventPrefixError = (
  before: ReadonlyArray<ProposalEventWitness>,
  after: ReadonlyArray<ProposalEventWitness>,
): PendingProposalBackfillError | undefined => {
  const afterByKey = new Map(
    after.map((event) => [proposalEventWitnessKey(event), event] as const),
  );
  for (const event of before) {
    const current = afterByKey.get(proposalEventWitnessKey(event));
    if (
      current === undefined ||
      current.sha !== event.sha ||
      current.json !== event.json
    ) {
      return new PendingProposalBackfillError(
        "preexisting work_proposal_events row changed during pending-proposal backfill",
      );
    }
  }
  return undefined;
};

type ProposalScan = {
  readonly rows: ReadonlyArray<ProposalScanRow>;
  readonly existing: ExistingTaskIndex;
};

const loadProposalScan = (reader: StateReader): ProposalScan => ({
  rows: loadPendingProposalRows(reader),
  existing: loadExistingTaskIndex(reader),
});

const scanRowKey = (row: ProposalScanRow): string =>
  proposalBackfillTaskKey(row.canvas_name, row.node_id, row.proposal_id);

const classifyProposalScan = (
  scan: ProposalScan,
): {
  readonly matched: ReadonlyArray<ProposalScanRow>;
  readonly missing: ReadonlyArray<ProposalScanRow>;
} => {
  const matched: ProposalScanRow[] = [];
  const missing: ProposalScanRow[] = [];
  for (const row of scan.rows) {
    const plan = planProposalBackfill({
      state: row.state as PendingProposalSnapshot["state"],
      proposalId: row.proposal_id,
      canvasName: row.canvas_name,
      nodeId: row.node_id,
      ...(row.approved_task_id !== null
        ? { approvedTaskId: row.approved_task_id }
        : {}),
      existingTaskKeys: scan.existing.exactKeys,
    });
    (plan.action === "materialize" ? missing : matched).push(row);
  }
  return { matched, missing };
};

/** Narrows the scan→persist race. The persist port must still recheck atomically. */
const proposalStillPendingAndUnmaterialized = (
  reader: StateReader,
  row: ProposalScanRow,
): boolean => {
  if (!tableExists(reader, "work_task_proposals")) return false;
  const proposal = reader.get<{ readonly state: string }>(
    `
      SELECT state
      FROM work_task_proposals
      WHERE canvas_name = ? AND node_id = ? AND proposal_id = ?
    `,
    [row.canvas_name, row.node_id, row.proposal_id],
  );
  if (proposal?.state !== "pending") return false;
  if (!tableExists(reader, "work_tasks")) return true;
  return reader.get(
    `
      SELECT task_id
      FROM work_tasks
      WHERE canvas_name = ? AND node_id = ? AND task_id = ?
    `,
    [row.canvas_name, row.node_id, row.proposal_id],
  ) === undefined;
};

const verifyProposalEventPrefix = (
  state: StateService,
  before: ReadonlyArray<ProposalEventWitness>,
): Effect.Effect<void, PendingProposalBackfillError | unknown> =>
  state.read(
    "work.pending-proposals.fingerprint-after",
    loadProposalEventWitnesses,
  ).pipe(
    Effect.flatMap((after) => {
      const error = proposalEventPrefixError(before, after);
      return error === undefined ? Effect.void : Effect.fail(error);
    }),
  );

/**
 * Drain one durable fixed point. Safe every boot and after legacy ingress.
 * Ordinary row failures stay pending and do not stop independent branches.
 * Defects/interruption escape, leaving the marker pending for a later resume.
 *
 * `persist` must atomically recheck that this exact proposal is still pending
 * and the same-id task is absent before committing task.create. The local
 * precheck below only narrows that cross-call race.
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
    const initialMarker = yield* input.installOps.getBackfill(backfillId);
    const markerObjects = initialMarker?.objectsIngested ?? 0;
    let markerStatus = initialMarker?.status;

    const eventsBefore = yield* input.state.read(
      "work.pending-proposals.fingerprint-before",
      loadProposalEventWitnesses,
    );

    const attemptedKeys = new Set<string>();
    const materializedKeys = new Set<string>();
    const skippedKeys = new Set<string>();

    const observe = (scan: ProposalScan) => {
      const classified = classifyProposalScan(scan);
      for (const row of classified.matched) {
        const key = scanRowKey(row);
        if (attemptedKeys.has(key)) {
          materializedKeys.add(key);
        } else if (!materializedKeys.has(key)) {
          skippedKeys.add(key);
        }
      }
      return classified;
    };

    const report = (
      status: PendingProposalBackfillReport["status"],
      missing: ReadonlyArray<ProposalScanRow>,
    ): PendingProposalBackfillReport => {
      const missingKeys = new Set(missing.map(scanRowKey));
      let failed = 0;
      for (const key of attemptedKeys) {
        if (missingKeys.has(key)) failed += 1;
      }
      return {
        status,
        materialized: materializedKeys.size,
        skipped: skippedKeys.size,
        failed,
        remaining: missing.length,
      };
    };

    while (true) {
      const scan = yield* input.state.read(
        "work.pending-proposals.scan",
        loadProposalScan,
      );
      const classified = observe(scan);

      if (classified.missing.length === 0) {
        if (markerStatus === "complete") {
          yield* verifyProposalEventPrefix(input.state, eventsBefore);
          return report("already-complete", []);
        }
        if (markerStatus === undefined) {
          yield* input.installOps.ensurePending(backfillId);
          markerStatus = "pending";
        }

        yield* input.installOps.markComplete(
          backfillId,
          markerObjects + materializedKeys.size,
        );
        markerStatus = "complete";

        // Marker first, witness second: an arrival in the scan→marker window is
        // seen here, reopened, and drained in this same invocation.
        const postMarkerScan = yield* input.state.read(
          "work.pending-proposals.post-marker-scan",
          loadProposalScan,
        );
        const postMarker = observe(postMarkerScan);
        if (postMarker.missing.length === 0) {
          yield* verifyProposalEventPrefix(input.state, eventsBefore);
          return report("complete", []);
        }

        yield* input.installOps.reopenPending(backfillId);
        markerStatus = "pending";
        continue;
      }

      if (markerStatus === "complete") {
        // A prior completion is advisory: older ingress can append later.
        yield* input.installOps.reopenPending(backfillId);
        markerStatus = "pending";
      } else if (markerStatus === undefined) {
        yield* input.installOps.ensurePending(backfillId);
        markerStatus = "pending";
      }

      const candidateRows = new Map<string, ProposalScanRow>();
      const candidates: Array<{
        readonly key: string;
        readonly canvasName: string;
        readonly dependsOn?: ReadonlyArray<string>;
      }> = [];
      for (const row of classified.missing) {
        const key = scanRowKey(row);
        if (attemptedKeys.has(key)) continue;
        try {
          const dependsOn = dependsOnFromRow(row);
          candidateRows.set(key, row);
          candidates.push({
            key,
            canvasName: row.canvas_name,
            ...(dependsOn !== undefined ? { dependsOn } : {}),
          });
        } catch {
          // Invalid explicit planning data is a row failure, never permission
          // to erase the edge or infer a replacement from prose.
          attemptedKeys.add(key);
        }
      }

      const frontier = planProposalBackfillFrontier({
        candidates,
        existingDependencyKeys: scan.existing.dependencyKeys,
      });
      if (frontier.ready.length === 0) {
        yield* verifyProposalEventPrefix(input.state, eventsBefore);
        return report("pending", classified.missing);
      }

      for (const key of frontier.ready) {
        const row = candidateRows.get(key);
        if (row === undefined) continue;

        const current = yield* input.state.read(
          "work.pending-proposals.pre-persist",
          (reader) => proposalStillPendingAndUnmaterialized(reader, row),
        );
        if (!current) continue;

        attemptedKeys.add(key);
        const recordJson = yield* input.state.read(
          "work.pending-proposals.claims",
          (reader) => loadCreateRecordJson(reader, row),
        );

        let materialization: UnadmittedMaterialization;
        try {
          materialization = materializePendingProposal({
            proposal: snapshotFromRow(row),
            claimsFromRecord: recoverClaimsFromProposalRecordJson(recordJson),
          });
        } catch {
          continue;
        }

        let persist: Effect.Effect<void, unknown>;
        try {
          persist = input.persist({
            canvasName: row.canvas_name,
            nodeId: row.node_id,
            materialization,
          });
        } catch {
          continue;
        }
        yield* persist.pipe(Effect.catch(() => Effect.void));
      }
    }
  });
