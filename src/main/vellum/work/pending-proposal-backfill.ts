/**
 * Install-ops walk: exact legacy pending proposals -> unadmitted Tasks.
 *
 * Product rows and immutable Work logs are read-only here. The repository owns
 * the sole exact history inspector, a relevant-change epoch, and the atomic
 * Task write. This runner keeps only scalar sweep state plus the repository's
 * opaque keyset cursor. No product or install-local cursor is persisted.
 */

import { Effect, Exit } from "effect";
import {
  BACKFILL_PENDING_PROPOSALS_V1,
} from "@shared/pending-proposal-backfill";
import type {
  InstallOpsError,
  InstallOpsServiceShape,
} from "../install-ops/service";
import type { StateReader } from "../state/service";
import type {
  LegacyProposalMaterializationCursor,
  LegacyProposalMaterializationWitness,
  LegacyProposalMaterializationWitnessPage,
  PersistUnadmittedTaskResult,
} from "./repository";

export { BACKFILL_PENDING_PROPOSALS_V1 } from "@shared/pending-proposal-backfill";

declare const PendingProposalBackfillCursorTypeId: unique symbol;

/** Opaque, single-process continuation. No cursor is product or install state. */
export type PendingProposalBackfillCursor = {
  readonly [PendingProposalBackfillCursorTypeId]: true;
};

export type PendingProposalBackfillPersistCounts = {
  readonly created: number;
  readonly verifiedExisting: number;
  readonly superseded: number;
  readonly invalid: number;
  readonly typedErrors: number;
  readonly timedOut: number;
};

type PendingProposalBackfillReportBase = {
  /** Atomic creates completed by this bounded reconciliation run. */
  readonly materialized: number;
  /** Pending exact pairs observed on the initial sweep. */
  readonly skipped: number;
  /** Pending rows still neither strongly verified nor superseded. */
  readonly failed: number;
  /** Strongly inspected pending rows still missing or invalid. */
  readonly remaining: number;
  /** False while the opaque keyset cursor has not completed a full sweep. */
  readonly remainingExact: boolean;
  readonly persist: PendingProposalBackfillPersistCounts;
};

export type PendingProposalBackfillReport =
  | (PendingProposalBackfillReportBase & {
      readonly status: "complete" | "already-complete";
    })
  | (PendingProposalBackfillReportBase & {
      readonly status: "pending";
      readonly reason: "budget-exhausted";
      readonly cursor: PendingProposalBackfillCursor;
    })
  | (PendingProposalBackfillReportBase & {
      readonly status: "pending";
      readonly reason: "fixed-point-no-progress";
    });

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
  readonly proposalId: string;
}) => Effect.Effect<PersistUnadmittedTaskResult, unknown>;

export type ReadLegacyProposalMaterializationWitnessPage = (input: {
  readonly after?: LegacyProposalMaterializationCursor;
  readonly limit: number;
}) => Effect.Effect<LegacyProposalMaterializationWitnessPage, unknown>;

export type ReadLegacyProposalMaterializationEpoch = () => number;

export const PENDING_PROPOSAL_BACKFILL_MAX_PASSES = 32;
export const PENDING_PROPOSAL_BACKFILL_MAX_PERSIST_ATTEMPTS = 32;
/** One repository witness page per turn. */
export const PENDING_PROPOSAL_BACKFILL_MAX_SCAN_ROWS = 32;
export const PENDING_PROPOSAL_BACKFILL_PERSIST_TIMEOUT_MS = 1_000;

export type PendingProposalBackfillLimits = {
  readonly maxPasses?: number;
  readonly maxPersistAttempts?: number;
  readonly maxScanRows?: number;
  readonly persistTimeoutMs?: number;
};

const positiveLimit = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;

const reconciliationUnresolved = (
  witness: LegacyProposalMaterializationWitness,
): boolean =>
  witness.status === "invalid" ||
  (
    witness.status === "missing" &&
    witness.proposalState === "pending"
  );

const persistCandidate = (
  witness: LegacyProposalMaterializationWitness,
): boolean =>
  witness.proposalState === "pending" &&
  reconciliationUnresolved(witness) &&
  (
    witness.status === "missing" ||
    (
      witness.status === "invalid" &&
      (
        witness.diagnostic.code === "task-collision" ||
        witness.diagnostic.code === "task-create-witness-invalid"
      )
    )
  );

type SweepState = {
  after?: LegacyProposalMaterializationCursor;
  epochAtStart: number;
  verified: number;
  unresolved: number;
  madeProgress: boolean;
  countInitialSkipped: boolean;
  materialized: number;
  skipped: number;
  readonly persistCounts: {
    created: number;
    verifiedExisting: number;
    superseded: number;
    invalid: number;
    typedErrors: number;
    timedOut: number;
  };
};

const continuationStates = new WeakMap<object, SweepState>();

const makeCursor = (state: SweepState): PendingProposalBackfillCursor => {
  const cursor = Object.freeze({}) as PendingProposalBackfillCursor;
  continuationStates.set(cursor as object, state);
  return cursor;
};

const consumeCursor = (
  cursor: PendingProposalBackfillCursor,
): SweepState => {
  const state = continuationStates.get(cursor as object);
  if (state === undefined) {
    throw new PendingProposalBackfillError(
      "pending-proposal continuation is not valid in this process",
    );
  }
  continuationStates.delete(cursor as object);
  return state;
};

const checkedEpoch = (
  readEpoch: ReadLegacyProposalMaterializationEpoch,
): number => {
  const epoch = readEpoch();
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new PendingProposalBackfillError(
      "pending-proposal reconciliation epoch is invalid",
    );
  }
  return epoch;
};

const freshSweep = (epochAtStart: number): SweepState => ({
  epochAtStart,
  verified: 0,
  unresolved: 0,
  madeProgress: false,
  countInitialSkipped: true,
  materialized: 0,
  skipped: 0,
  persistCounts: {
    created: 0,
    verifiedExisting: 0,
    superseded: 0,
    invalid: 0,
    typedErrors: 0,
    timedOut: 0,
  },
});

const rotateSweep = (state: SweepState, epochAtStart: number): void => {
  state.after = undefined;
  state.epochAtStart = epochAtStart;
  state.verified = 0;
  state.unresolved = 0;
  state.madeProgress = false;
  state.countInitialSkipped = false;
};

const reportFromState = (
  state: SweepState,
  remainingExact: boolean,
): PendingProposalBackfillReportBase => ({
  materialized: state.materialized,
  skipped: state.skipped,
  failed: state.unresolved,
  remaining: state.unresolved,
  remainingExact,
  persist: { ...state.persistCounts },
});

const reopenBestEffort = (
  installOps: InstallOpsServiceShape,
  backfillId: string,
): Effect.Effect<void> =>
  installOps.reopenPending(backfillId).pipe(
    Effect.asVoid,
    Effect.catchCause(() => Effect.void),
  );

type PersistAttempt =
  | { readonly kind: "result"; readonly result: PersistUnadmittedTaskResult }
  | { readonly kind: "typed-error" }
  | { readonly kind: "timeout" };

const runPersistAttempt = (
  persist: PersistUnadmittedTask,
  witness: LegacyProposalMaterializationWitness,
  timeoutMs: number,
): Effect.Effect<PersistAttempt> => {
  let effect: Effect.Effect<PersistUnadmittedTaskResult, unknown>;
  try {
    effect = persist({
      canvasName: witness.canvasName,
      nodeId: witness.nodeId,
      proposalId: witness.proposalId,
    });
  } catch {
    return Effect.succeed({ kind: "typed-error" as const });
  }
  return effect.pipe(
    Effect.map((result) => ({ kind: "result" as const, result })),
    Effect.catch(() => Effect.succeed({ kind: "typed-error" as const })),
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.succeed({ kind: "timeout" as const }),
    }),
  );
};

const recordPersistAttempt = (
  state: SweepState,
  attempt: PersistAttempt,
): { readonly settled: boolean; readonly progress: boolean } => {
  if (attempt.kind === "timeout") {
    state.persistCounts.timedOut += 1;
    return { settled: false, progress: false };
  }
  if (attempt.kind === "typed-error") {
    state.persistCounts.typedErrors += 1;
    return { settled: false, progress: false };
  }

  switch (attempt.result.status) {
    case "created":
      state.persistCounts.created += 1;
      state.materialized += 1;
      state.verified += 1;
      state.unresolved -= 1;
      state.madeProgress = true;
      return { settled: true, progress: true };
    case "already-materialized":
      state.persistCounts.verifiedExisting += 1;
      state.verified += 1;
      state.unresolved -= 1;
      return { settled: true, progress: false };
    case "no-longer-pending":
      state.persistCounts.superseded += 1;
      state.unresolved -= 1;
      return { settled: true, progress: false };
    case "invalid":
      state.persistCounts.invalid += 1;
      return { settled: false, progress: false };
  }
};

const pendingContinuation = (
  state: SweepState,
): PendingProposalBackfillReport => ({
  ...reportFromState(state, false),
  status: "pending",
  reason: "budget-exhausted",
  cursor: makeCursor(state),
});

/**
 * Run one bounded strong-index slice. Each turn reads at most 32 witnesses.
 * Completion requires a whole no-progress/no-invalid sweep and an unchanged
 * relevant repository epoch on both sides of the marker write.
 */
export const runPendingProposalBackfill = (input: {
  /** Retained for the stable call contract; product reads stay in the repository. */
  readonly state: StateService;
  readonly installOps: InstallOpsServiceShape;
  readonly persist: PersistUnadmittedTask;
  readonly readWitnessPage: ReadLegacyProposalMaterializationWitnessPage;
  readonly readEpoch: ReadLegacyProposalMaterializationEpoch;
  readonly cursor?: PendingProposalBackfillCursor;
  readonly limits?: PendingProposalBackfillLimits;
}): Effect.Effect<
  PendingProposalBackfillReport,
  PendingProposalBackfillError | InstallOpsError | unknown
> => {
  const backfillId = BACKFILL_PENDING_PROPOSALS_V1;
  const run = Effect.gen(function* () {
    const maxPasses = positiveLimit(
      input.limits?.maxPasses,
      PENDING_PROPOSAL_BACKFILL_MAX_PASSES,
    );
    const maxPersistAttempts = positiveLimit(
      input.limits?.maxPersistAttempts,
      PENDING_PROPOSAL_BACKFILL_MAX_PERSIST_ATTEMPTS,
    );
    const maxScanRows = positiveLimit(
      input.limits?.maxScanRows,
      PENDING_PROPOSAL_BACKFILL_MAX_SCAN_ROWS,
    );
    const persistTimeoutMs = positiveLimit(
      input.limits?.persistTimeoutMs,
      PENDING_PROPOSAL_BACKFILL_PERSIST_TIMEOUT_MS,
    );
    const pageLimit = Math.min(32, maxPersistAttempts, maxScanRows);

    const markerAtStart = yield* input.installOps.getBackfill(backfillId);
    let markerStatus = markerAtStart?.status;
    const markerObjects = markerAtStart?.objectsIngested ?? 0;
    const state = input.cursor === undefined
      ? freshSweep(checkedEpoch(input.readEpoch))
      : consumeCursor(input.cursor);
    const page = yield* input.readWitnessPage({
      ...(state.after === undefined ? {} : { after: state.after }),
      limit: pageLimit,
    });

    const candidates: Array<{
      readonly witness: LegacyProposalMaterializationWitness;
      settled: boolean;
    }> = [];
    for (const witness of page.witnesses) {
      if (witness.status === "verified") {
        state.verified += 1;
        if (
          state.countInitialSkipped &&
          witness.proposalState === "pending"
        ) {
          state.skipped += 1;
        }
        continue;
      }
      if (!reconciliationUnresolved(witness)) continue;
      state.unresolved += 1;
      if (persistCandidate(witness)) {
        candidates.push({ witness, settled: false });
      }
    }

    const ensureMarkerPending = () => {
      if (markerStatus === "complete") {
        return input.installOps.reopenPending(backfillId).pipe(
          Effect.map(() => {
            markerStatus = "pending" as const;
          }),
        );
      }
      if (markerStatus === undefined) {
        return input.installOps.ensurePending(backfillId).pipe(
          Effect.map(() => {
            markerStatus = "pending" as const;
          }),
        );
      }
      return Effect.void;
    };

    let attempts = 0;
    let round = 0;
    while (
      candidates.some((candidate) => !candidate.settled) &&
      attempts < maxPersistAttempts &&
      round < maxPasses
    ) {
      round += 1;
      let roundProgress = false;
      for (const candidate of candidates) {
        if (candidate.settled || attempts >= maxPersistAttempts) continue;
        attempts += 1;
        const disposition = recordPersistAttempt(
          state,
          yield* runPersistAttempt(
            input.persist,
            candidate.witness,
            persistTimeoutMs,
          ),
        );
        candidate.settled = disposition.settled;
        if (disposition.progress) roundProgress = true;
      }
      if (!roundProgress) break;
    }

    state.after = page.next;
    if (state.after !== undefined) {
      yield* ensureMarkerPending();
      return pendingContinuation(state);
    }

    const epochAtEnd = checkedEpoch(input.readEpoch);
    if (epochAtEnd !== state.epochAtStart || state.madeProgress) {
      yield* ensureMarkerPending();
      rotateSweep(state, epochAtEnd);
      return pendingContinuation(state);
    }

    if (state.unresolved > 0) {
      yield* ensureMarkerPending();
      return {
        ...reportFromState(state, true),
        status: "pending" as const,
        reason: "fixed-point-no-progress" as const,
      };
    }

    const exactObjects = state.verified;
    if (markerStatus === "complete" && markerObjects === exactObjects) {
      const epochAfterValidation = checkedEpoch(input.readEpoch);
      if (epochAfterValidation === state.epochAtStart) {
        return {
          ...reportFromState(state, true),
          status: "already-complete" as const,
        };
      }
      yield* ensureMarkerPending();
      rotateSweep(state, epochAfterValidation);
      return pendingContinuation(state);
    }

    yield* ensureMarkerPending();
    const epochBeforeMarker = checkedEpoch(input.readEpoch);
    if (epochBeforeMarker !== state.epochAtStart) {
      rotateSweep(state, epochBeforeMarker);
      return pendingContinuation(state);
    }

    const marked = yield* Effect.gen(function* () {
      yield* input.installOps.markComplete(backfillId, exactObjects);
      const epochAfterMarker = checkedEpoch(input.readEpoch);
      if (epochAfterMarker !== epochBeforeMarker) {
        yield* input.installOps.reopenPending(backfillId);
        markerStatus = "pending";
        rotateSweep(state, epochAfterMarker);
        return false;
      }
      return true;
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? reopenBestEffort(input.installOps, backfillId)
          : Effect.void
      ),
    );
    if (!marked) return pendingContinuation(state);

    return {
      ...reportFromState(state, true),
      status: "complete" as const,
    };
  });

  return run.pipe(
    Effect.onExit((exit) =>
      Exit.isFailure(exit)
        ? reopenBestEffort(input.installOps, backfillId)
        : Effect.void
    ),
  );
};
