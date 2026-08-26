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

import { Effect, Schema } from "effect";
import {
  BACKFILL_PENDING_PROPOSALS_V1,
  materializePendingProposal,
  planProposalBackfill,
  planProposalBackfillFrontier,
  proposalBackfillDependencyKey,
  proposalBackfillTaskKey,
  recoverClaimsFromProposalRecordJsonStrict,
  type PendingProposalSnapshot,
  type UnadmittedMaterialization,
} from "@shared/pending-proposal-backfill";
import { TaskProposal } from "@shared/work-model";
import type {
  InstallOpsError,
  InstallOpsServiceShape,
} from "../install-ops/service";
import type { StateReader, StateRow } from "../state/service";

export { BACKFILL_PENDING_PROPOSALS_V1 } from "@shared/pending-proposal-backfill";

export type PendingProposalBackfillReport = {
  /** `pending` asks the caller to schedule another bounded pass. */
  readonly status: "complete" | "already-complete" | "pending";
  /** Durable same-id proposal/task pairs absent initially and present finally. */
  readonly materialized: number;
  /** Initially pending proposals that already had a durable same-id Task. */
  readonly skipped: number;
  /** Attempted rows without a durable same-id pair at the final witness. */
  readonly failed: number;
  /** Pending proposals still missing a same-id Task at the final witness. */
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

const STRICT_DECODE_OPTIONS = { onExcessProperty: "error" } as const;
const decodeTaskProposal = Schema.decodeUnknownSync(
  TaskProposal,
  STRICT_DECODE_OPTIONS,
);

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

/** Decode the complete historical proposal before it reaches the persist port. */
const snapshotFromRow = (row: ProposalScanRow): PendingProposalSnapshot => {
  try {
    return decodeTaskProposal({
      id: row.proposal_id,
      state: row.state,
      brief: parseJson(row.brief_json, `${row.proposal_id}.brief`),
      proposedBy: {
        seatId: row.proposer_seat_id,
        canvasName: row.proposer_canvas_name,
        nodeId: row.proposer_node_id,
      },
      ...(row.approved_task_id !== null
        ? { approvedTaskId: row.approved_task_id }
        : {}),
      ...(row.depends_on_json !== null
        ? {
            dependsOn: parseJson(
              row.depends_on_json,
              `${row.proposal_id}.dependsOn`,
            ),
          }
        : {}),
      ...(row.finish_criteria_json !== null
        ? {
            finishCriteria: parseJson(
              row.finish_criteria_json,
              `${row.proposal_id}.finishCriteria`,
            ),
          }
        : {}),
      ...(row.metadata_json !== null
        ? {
            metadata: parseJson(
              row.metadata_json,
              `${row.proposal_id}.metadata`,
            ),
          }
        : {}),
      ...(row.reason !== null ? { reason: row.reason } : {}),
    });
  } catch (cause) {
    if (cause instanceof PendingProposalBackfillError) throw cause;
    throw new PendingProposalBackfillError(
      `proposal "${row.proposal_id}" failed strict historical decode`,
      { cause },
    );
  }
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

/**
 * Cumulative durable witnesses. Pending state is deliberately not part of this
 * join: a proposal can approve or reject after its same-id Task commits.
 */
const loadSameIdMaterializationKeys = (
  reader: StateReader,
): ReadonlySet<string> => {
  if (
    !tableExists(reader, "work_task_proposals") ||
    !tableExists(reader, "work_tasks")
  ) {
    return new Set();
  }
  const rows = reader.all<{
    readonly canvas_name: string;
    readonly node_id: string;
    readonly proposal_id: string;
  }>(
    `
      SELECT
        proposal.canvas_name,
        proposal.node_id,
        proposal.proposal_id
      FROM work_task_proposals AS proposal
      INNER JOIN work_tasks AS task
        ON task.canvas_name = proposal.canvas_name
        AND task.node_id = proposal.node_id
        AND task.task_id = proposal.proposal_id
      ORDER BY proposal.canvas_name, proposal.node_id, proposal.proposal_id
    `,
  );
  return new Set(
    rows.map((row) =>
      proposalBackfillTaskKey(
        row.canvas_name,
        row.node_id,
        row.proposal_id,
      )
    ),
  );
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
  readonly recordType: string;
  readonly canvasName: string;
  readonly nodeId: string;
  readonly proposalId: string;
  readonly operation: string;
  readonly sha: string;
  readonly json: string;
  readonly originAt: string;
  readonly receivedAt: string;
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
        record_type AS recordType,
        canvas_name AS canvasName,
        node_id AS nodeId,
        proposal_id AS proposalId,
        operation,
        content_sha256 AS sha,
        record_json AS json,
        origin_at AS originAt,
        received_at AS receivedAt
      FROM work_proposal_events
      ORDER BY event_home, entity_home, length(seq), seq
    `,
  );
};

const proposalEventWitnessKey = (event: ProposalEventWitness): string =>
  JSON.stringify([event.eventHome, event.entityHome, event.seq]);

const proposalEventWitnessValue = (event: ProposalEventWitness): string =>
  JSON.stringify([
    event.eventHome,
    event.entityHome,
    event.seq,
    event.recordType,
    event.canvasName,
    event.nodeId,
    event.proposalId,
    event.operation,
    event.sha,
    event.json,
    event.originAt,
    event.receivedAt,
  ]);

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
      proposalEventWitnessValue(current) !== proposalEventWitnessValue(event)
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
  /** All durable exact proposal/task pairs, including non-pending proposals. */
  readonly sameIdMaterializationKeys: ReadonlySet<string>;
};

const loadProposalScan = (reader: StateReader): ProposalScan => ({
  rows: loadPendingProposalRows(reader),
  existing: loadExistingTaskIndex(reader),
  sameIdMaterializationKeys: loadSameIdMaterializationKeys(reader),
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

export const PENDING_PROPOSAL_BACKFILL_MAX_PASSES = 32;
export const PENDING_PROPOSAL_BACKFILL_MAX_PERSIST_ATTEMPTS = 32;
export const PENDING_PROPOSAL_BACKFILL_PERSIST_TIMEOUT_MS = 1_000;

type PendingProposalBackfillLimits = {
  readonly maxPasses?: number;
  readonly maxPersistAttempts?: number;
  readonly persistTimeoutMs?: number;
};

const positiveLimit = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;

const sameStringSet = (
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean =>
  left.size === right.size && [...left].every((value) => right.has(value));

/**
 * Drain one bounded durable fixed-point pass. Safe every boot and after legacy
 * ingress. A `pending` report is an explicit continuation request: the caller
 * must schedule another pass instead of keeping WorkLive construction open.
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
  readonly limits?: PendingProposalBackfillLimits;
}): Effect.Effect<
  PendingProposalBackfillReport,
  PendingProposalBackfillError | InstallOpsError | unknown
> =>
  Effect.gen(function* () {
    const backfillId = BACKFILL_PENDING_PROPOSALS_V1;
    const maxPasses = positiveLimit(
      input.limits?.maxPasses,
      PENDING_PROPOSAL_BACKFILL_MAX_PASSES,
    );
    const maxPersistAttempts = positiveLimit(
      input.limits?.maxPersistAttempts,
      PENDING_PROPOSAL_BACKFILL_MAX_PERSIST_ATTEMPTS,
    );
    const persistTimeoutMs = positiveLimit(
      input.limits?.persistTimeoutMs,
      PENDING_PROPOSAL_BACKFILL_PERSIST_TIMEOUT_MS,
    );
    const initialMarker = yield* input.installOps.getBackfill(backfillId);
    let markerStatus = initialMarker?.status;
    let markerObjects = initialMarker?.objectsIngested ?? 0;

    const eventsBefore = yield* input.state.read(
      "work.pending-proposals.fingerprint-before",
      loadProposalEventWitnesses,
    );

    const attemptedKeys = new Set<string>();
    let baselineSameIdKeys: ReadonlySet<string> | undefined;
    const skippedKeys = new Set<string>();
    let passCount = 0;
    let persistAttempts = 0;

    const observe = (scan: ProposalScan) => {
      const classified = classifyProposalScan(scan);
      if (baselineSameIdKeys === undefined) {
        baselineSameIdKeys = new Set(scan.sameIdMaterializationKeys);
        for (const row of classified.matched) {
          skippedKeys.add(scanRowKey(row));
        }
      }
      return classified;
    };

    const report = (
      status: PendingProposalBackfillReport["status"],
      scan: ProposalScan,
      missing: ReadonlyArray<ProposalScanRow>,
    ): PendingProposalBackfillReport => {
      const baseline = baselineSameIdKeys ?? new Set<string>();
      let materialized = 0;
      for (const key of scan.sameIdMaterializationKeys) {
        if (!baseline.has(key)) materialized += 1;
      }
      let failed = 0;
      for (const key of attemptedKeys) {
        if (!scan.sameIdMaterializationKeys.has(key)) failed += 1;
      }
      return {
        status,
        materialized,
        skipped: skippedKeys.size,
        failed,
        remaining: missing.length,
      };
    };

    const reopenMarker = () =>
      input.installOps.reopenPending(backfillId).pipe(
        Effect.map(() => {
          markerStatus = "pending" as const;
        }),
      );

    const ensureMarkerPending = () => {
      if (markerStatus === "complete") return reopenMarker();
      if (markerStatus === undefined) {
        return input.installOps.ensurePending(backfillId).pipe(
          Effect.map(() => {
            markerStatus = "pending" as const;
          }),
        );
      }
      return Effect.void;
    };

    /** Any verification failure invalidates even a completion from an older run. */
    const verifyEvents = () =>
      verifyProposalEventPrefix(input.state, eventsBefore).pipe(
        Effect.catch((error) =>
          markerStatus === "complete"
            ? reopenMarker().pipe(
                Effect.flatMap(() => Effect.fail(error)),
              )
            : Effect.fail(error)
        ),
      );

    while (true) {
      const scan = yield* input.state.read(
        "work.pending-proposals.scan",
        loadProposalScan,
      );
      const classified = observe(scan);

      if (classified.missing.length === 0) {
        const exactObjects = scan.sameIdMaterializationKeys.size;
        if (
          markerStatus === "complete" &&
          markerObjects === exactObjects
        ) {
          yield* verifyEvents();
          return report("already-complete", scan, []);
        }

        yield* ensureMarkerPending();
        // The full immutable prefix must be verified before completion is
        // recorded in the independently committed install-ops database.
        yield* verifyEvents();
        yield* input.installOps.markComplete(backfillId, exactObjects);
        markerStatus = "complete";
        markerObjects = exactObjects;

        const postMarkerScan = yield* input.state.read(
          "work.pending-proposals.post-marker-scan",
          loadProposalScan,
        );
        const postMarker = observe(postMarkerScan);
        if (
          postMarker.missing.length === 0 &&
          sameStringSet(
            postMarkerScan.sameIdMaterializationKeys,
            scan.sameIdMaterializationKeys,
          )
        ) {
          // A later verification error must reopen the marker. Appends after
          // this snapshot remain discoverable because every invocation scans
          // product state even when the marker says complete.
          yield* verifyEvents();
          return report("complete", postMarkerScan, []);
        }

        yield* reopenMarker();
        passCount += 1;
        if (passCount >= maxPasses) {
          yield* verifyEvents();
          return report(
            "pending",
            postMarkerScan,
            postMarker.missing,
          );
        }
        continue;
      }

      yield* ensureMarkerPending();
      if (
        passCount >= maxPasses ||
        persistAttempts >= maxPersistAttempts
      ) {
        yield* verifyEvents();
        return report("pending", scan, classified.missing);
      }
      passCount += 1;

      const candidateRows = new Map<
        string,
        {
          readonly row: ProposalScanRow;
          readonly materialization: UnadmittedMaterialization;
        }
      >();
      const candidates: Array<{
        readonly key: string;
        readonly canvasName: string;
        readonly dependsOn?: ReadonlyArray<string>;
      }> = [];
      for (const row of classified.missing) {
        const key = scanRowKey(row);
        if (attemptedKeys.has(key)) continue;
        try {
          // Strictly decode every historical arm and the complete resulting
          // Task before frontier planning. Invalid rows cannot hide forever
          // behind an unresolved dependency.
          const proposal = snapshotFromRow(row);
          const recordJson = yield* input.state.read(
            "work.pending-proposals.claims",
            (reader) => loadCreateRecordJson(reader, row),
          );
          const materialization = materializePendingProposal({
            proposal,
            claimsFromRecord:
              recoverClaimsFromProposalRecordJsonStrict(recordJson),
          });
          candidateRows.set(key, { row, materialization });
          candidates.push({
            key,
            canvasName: row.canvas_name,
            ...(proposal.dependsOn !== undefined
              ? { dependsOn: proposal.dependsOn }
              : {}),
          });
        } catch {
          // Invalid historical data is a counted row failure. It never erases
          // explicit edges, infers replacements from prose, or defects boot.
          attemptedKeys.add(key);
        }
      }

      const frontier = planProposalBackfillFrontier({
        candidates,
        existingDependencyKeys: scan.existing.dependencyKeys,
      });
      if (frontier.ready.length === 0) {
        yield* verifyEvents();
        return report("pending", scan, classified.missing);
      }

      for (const key of frontier.ready) {
        if (persistAttempts >= maxPersistAttempts) break;
        const candidate = candidateRows.get(key);
        if (candidate === undefined) continue;

        const current = yield* input.state.read(
          "work.pending-proposals.pre-persist",
          (reader) =>
            proposalStillPendingAndUnmaterialized(reader, candidate.row),
        );
        if (!current) continue;

        attemptedKeys.add(key);
        persistAttempts += 1;
        let persist: Effect.Effect<void, unknown>;
        try {
          persist = input.persist({
            canvasName: candidate.row.canvas_name,
            nodeId: candidate.row.node_id,
            materialization: candidate.materialization,
          });
        } catch {
          continue;
        }
        // Typed persist refusal is one row failure. Defects and interruption
        // still escape so acquisition cannot pretend a crashed pass completed.
        yield* persist.pipe(
          Effect.timeoutOrElse({
            duration: persistTimeoutMs,
            orElse: () => Effect.void,
          }),
          Effect.catch(() => Effect.void),
        );
      }
    }
  });
