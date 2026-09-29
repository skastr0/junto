import { randomUUID } from "node:crypto";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { HostId } from "@shared/remote-hosts";
import {
  evaluateIntervalTimer,
  initializeIntervalTimer,
  IntervalTimerState,
  TimerKey,
  type EvaluateIntervalTimerInput,
  type IntervalTimerEvaluation,
  type IntervalTimerState as IntervalTimerStateValue,
  type TimerIneligible,
  type TimerKey as TimerKeyValue,
} from "@shared/scheduler-policy";
import {
  StateTransactionOperation,
} from "../state/service";

export type SchedulerClaimResult =
  | IntervalTimerEvaluation
  | {
      readonly _tag: "Initialized";
      readonly state: IntervalTimerStateValue;
    };

export type SchedulerClaimInput = Omit<
  EvaluateIntervalTimerInput,
  "state"
>;

export class SchedulerPersistenceError extends Schema.TaggedError<SchedulerPersistenceError>()(
  "SchedulerPersistenceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export class SchedulerStateCorruptError extends Schema.TaggedError<SchedulerStateCorruptError>()(
  "SchedulerStateCorruptError",
  {
    homeStation: Schema.String,
    timerKey: Schema.String,
    message: Schema.String,
  },
) {}

export class SchedulerInputError extends Schema.TaggedError<SchedulerInputError>()(
  "SchedulerInputError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export type SchedulerRepositoryError =
  | SchedulerPersistenceError
  | SchedulerStateCorruptError
  | SchedulerInputError;

/**
 * effect-foundation **S4-rest-main** (staged, not half-migrated):
 * - Canonical id: `@junto/SchedulerRepository` — single definition; no dual path.
 * - Service id: Context.Service (Effect V4 live).
 * - Shape:
 *   `class SchedulerRepository extends Context.Service<SchedulerRepository, SchedulerRepository>()("@junto/SchedulerRepository") {}`
 * - Layer today: SchedulerRepositoryLive / makeSchedulerRepositoryLive — V4 rename candidate SchedulerRepository.layer
 *   Do not dual-export Live + `.layer` names.
 */
/** Claim a calendar (crontab) due slot once; advances next due on success. */
export type ExpressionClaimInput = {
  readonly homeStation: string;
  readonly timerKey: string;
  /** Stable id for the expression (e.g. the expression source string). */
  readonly scheduleId: string;
  readonly dueAtEpochMs: number;
  readonly nextDueAtEpochMs: number;
  readonly nowEpochMs: number;
};

export type ExpressionClaimResult =
  | { readonly _tag: "Claimed"; readonly dueAtEpochMs: number; readonly nextDueAtEpochMs: number }
  | { readonly _tag: "Duplicate" }
  | { readonly _tag: "Ineligible"; readonly reason: string };

export class SchedulerRepository extends Context.Service<SchedulerRepository,
  {
    readonly claimInterval: (
      input: SchedulerClaimInput,
    ) => Effect.Effect<SchedulerClaimResult, SchedulerRepositoryError>;
    readonly claimExpression: (
      input: ExpressionClaimInput,
    ) => Effect.Effect<ExpressionClaimResult, SchedulerRepositoryError>;
    readonly reconcileHome: (
      homeStation: string,
      activeTimerKeys: ReadonlyArray<string>,
    ) => Effect.Effect<number, SchedulerRepositoryError>;
    readonly readIntervalState: (
      homeStation: string,
      timerKey: string,
    ) => Effect.Effect<
      IntervalTimerStateValue | undefined,
      SchedulerRepositoryError
    >;
  }>()("@junto/SchedulerRepository") {}

const SchedulerStateRow = Schema.Struct({
  home_station: Schema.String,
  timer_key: Schema.String,
  schedule_id: Schema.String,
  interval_milliseconds: Schema.Number,
  catch_up_policy: Schema.String,
  next_due_at_epoch_ms: Schema.Number,
  next_due_slot: Schema.String,
  last_fired_slot: Schema.NullOr(Schema.String),
  updated_at: Schema.String,
});
const decodeChanges = Schema.decodeUnknownEffect(Schema.Struct({
  changes: Schema.Union([Schema.Number, Schema.BigInt]),
}));

const isHostId = Schema.is(HostId);
const isTimerKey = Schema.is(TimerKey);
const decodeState = Schema.decodeUnknownResult(IntervalTimerState);

const persistenceError = (
  operation: string,
  error: unknown,
): SchedulerRepositoryError =>
  error instanceof SchedulerStateCorruptError ||
  error instanceof SchedulerInputError
    ? error
    : SchedulerPersistenceError.make({
        operation,
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });

const stateFromRow = (
  row: typeof SchedulerStateRow.Type,
): Effect.Effect<IntervalTimerStateValue, SchedulerStateCorruptError> => {
  const candidate = {
    version: 1 as const,
    scheduleId: row.schedule_id,
    intervalMilliseconds: row.interval_milliseconds,
    catchUpPolicy: row.catch_up_policy,
    nextDueAtEpochMs: row.next_due_at_epoch_ms,
    nextDueSlot: row.next_due_slot,
    ...(row.last_fired_slot === null
      ? {}
      : { lastFiredSlot: row.last_fired_slot }),
  };
  const decoded = decodeState(candidate);
  if (decoded._tag === "Failure") {
    return Effect.fail(SchedulerStateCorruptError.make({
      homeStation: row.home_station,
      timerKey: row.timer_key,
      message:
        "persisted interval cursor does not satisfy the scheduler contract",
    }));
  }
  return Effect.succeed(decoded.success);
};

const writeState = (
  sql: SqlClient.SqlClient,
  homeStation: string,
  timerKey: string,
  state: IntervalTimerStateValue,
  updatedAt: string,
) => sql`
      INSERT INTO scheduler_interval_state(
        home_station,
        timer_key,
        schedule_id,
        interval_milliseconds,
        catch_up_policy,
        next_due_at_epoch_ms,
        next_due_slot,
        last_fired_slot,
        updated_at
      ) VALUES (${homeStation}, ${timerKey}, ${state.scheduleId}, ${state.intervalMilliseconds},
        ${state.catchUpPolicy}, ${state.nextDueAtEpochMs}, ${state.nextDueSlot}, ${state.lastFiredSlot ?? null}, ${updatedAt})
      ON CONFLICT(home_station, timer_key) DO UPDATE SET
        schedule_id = excluded.schedule_id,
        interval_milliseconds = excluded.interval_milliseconds,
        catch_up_policy = excluded.catch_up_policy,
        next_due_at_epoch_ms = excluded.next_due_at_epoch_ms,
        next_due_slot = excluded.next_due_slot,
        last_fired_slot = excluded.last_fired_slot,
        updated_at = excluded.updated_at
    `;

const initialize = (
  input: SchedulerClaimInput,
  makeScheduleId: () => string,
):
  | TimerIneligible
  | {
      readonly _tag: "Initialized";
      readonly state: IntervalTimerStateValue;
    } => {
  const initialized = initializeIntervalTimer({
    scheduleId: makeScheduleId(),
    nowEpochMs: input.nowEpochMs,
    everyMinutes: input.everyMinutes,
  });
  if (initialized._tag === "Ineligible") return initialized;

  // Initialization also admits the single-home boundary. Evaluating at the
  // same instant is necessarily NotDue when the home is valid.
  const admitted = evaluateIntervalTimer({
    ...input,
    state: initialized.state,
  });
  if (admitted._tag === "Ineligible") return admitted;
  return {
    _tag: "Initialized",
    state: initialized.state,
  };
};

export type SchedulerRepositoryOptions = {
  readonly makeScheduleId?: () => string;
  readonly now?: (epochMilliseconds: number) => string;
};

export const makeSchedulerRepositoryLive = (
  options: SchedulerRepositoryOptions = {},
): Layer.Layer<SchedulerRepository, never, SqlClient.SqlClient> =>
  Layer.effect(
    SchedulerRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const selectState = SqlSchema.findAll({
        Request: Schema.Struct({ homeStation: Schema.String, timerKey: Schema.String }),
        Result: SchedulerStateRow,
        execute: ({ homeStation, timerKey }) => sql`
          SELECT home_station, timer_key, schedule_id, interval_milliseconds, catch_up_policy,
            next_due_at_epoch_ms, next_due_slot, last_fired_slot, updated_at
          FROM scheduler_interval_state WHERE home_station = ${homeStation} AND timer_key = ${timerKey}
        `,
      });
      const selectKeys = SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ home_station: Schema.String, timer_key: Schema.String }),
        execute: () => sql`SELECT home_station, timer_key FROM scheduler_interval_state`,
      });
      const makeScheduleId = options.makeScheduleId ?? randomUUID;
      const formatTimestamp =
        options.now ??
        ((epochMilliseconds: number) =>
          new Date(epochMilliseconds).toISOString());
      const timestamp = (epochMilliseconds: number) => Effect.try({
        try: () => formatTimestamp(epochMilliseconds),
        catch: (error) => error,
      });

      const claimInterval = Effect.fn(
        "SchedulerRepository.claimInterval",
      )(function* (input: SchedulerClaimInput) {
        const homeCandidate =
          input.homeStationIds.length === 1 &&
          typeof input.homeStationIds[0] === "string"
            ? input.homeStationIds[0]
            : undefined;
        const timerCandidate =
          typeof input.timerKey === "string" ? input.timerKey : undefined;

        // The pure policy owns invalid-input classification. Without a valid
        // key/home there is deliberately no database lookup or mutation.
        if (
          homeCandidate === undefined ||
          timerCandidate === undefined ||
          !isHostId(homeCandidate) ||
          !isTimerKey(timerCandidate)
        ) {
          const seed = initialize(input, makeScheduleId);
          return seed;
        }

        return yield* sql.withTransaction(Effect.gen(function* () {
            const currentRow = (yield* selectState({ homeStation: homeCandidate, timerKey: timerCandidate }))[0];
            const current =
              currentRow === undefined
                ? undefined
                : yield* stateFromRow(currentRow);
            const requestedInterval =
              typeof input.everyMinutes === "number"
                ? input.everyMinutes * 60_000
                : Number.NaN;

            if (
              current === undefined ||
              current.intervalMilliseconds !== requestedInterval
            ) {
              const initialized = yield* Effect.try({
                try: () => initialize(input, makeScheduleId),
                catch: (error) => error,
              });
              if (initialized._tag === "Ineligible") return initialized;
              yield* writeState(
                sql,
                homeCandidate,
                timerCandidate,
                initialized.state,
                yield* timestamp(input.nowEpochMs as number),
              );
              return initialized;
            }

            const evaluated = evaluateIntervalTimer({
              ...input,
              state: current,
            });
            if (evaluated._tag !== "Firing") return evaluated;

            const claimedAt = yield* timestamp(evaluated.observedAtEpochMs);
            const firing = yield* sql`
                INSERT OR IGNORE INTO scheduler_interval_firings(
                  home_station,
                  timer_key,
                  schedule_id,
                  catch_up_policy,
                  claim_slot,
                  due_slot,
                  scheduled_for_epoch_ms,
                  observed_at_epoch_ms,
                  coalesced_missed_slots,
                  claimed_at
                ) VALUES (${homeCandidate}, ${timerCandidate}, ${evaluated.identity.scheduleId}, ${evaluated.catchUpPolicy},
                  ${evaluated.identity.claimSlot}, ${evaluated.dueSlot}, ${evaluated.scheduledForEpochMs},
                  ${evaluated.observedAtEpochMs}, ${evaluated.coalescedMissedSlots}, ${claimedAt})
              `.raw.pipe(Effect.flatMap(decodeChanges));
            if (Number(firing.changes) !== 1) {
              return yield* SchedulerStateCorruptError.make({
                homeStation: homeCandidate,
                timerKey: timerCandidate,
                message:
                  "interval cursor points at an already-claimed firing slot",
              });
            }
            yield* writeState(
              sql,
              homeCandidate,
              timerCandidate,
              evaluated.nextState,
              yield* timestamp(evaluated.observedAtEpochMs),
            );
            return evaluated;
          }))
          .pipe(
            Effect.provideService(StateTransactionOperation, "scheduler.claim-interval"),
            Effect.mapError((error) =>
              persistenceError("claim-interval", error)
            ),
          );
      });

      const claimExpression = Effect.fn(
        "SchedulerRepository.claimExpression",
      )(function* (input: ExpressionClaimInput) {
        if (
          !isHostId(input.homeStation) ||
          !isTimerKey(input.timerKey) ||
          input.scheduleId.length === 0 ||
          input.scheduleId.length > 256 ||
          !Number.isSafeInteger(input.dueAtEpochMs) ||
          input.dueAtEpochMs < 0 ||
          !Number.isSafeInteger(input.nextDueAtEpochMs) ||
          input.nextDueAtEpochMs <= input.dueAtEpochMs
        ) {
          return {
            _tag: "Ineligible" as const,
            reason: "invalid-expression-claim",
          };
        }
        const claimSlot = String(input.dueAtEpochMs);
        return yield* sql.withTransaction(Effect.gen(function* () {
            const claimedAt = yield* timestamp(input.nowEpochMs);
            const firing = yield* sql`
                INSERT OR IGNORE INTO scheduler_interval_firings(
                  home_station,
                  timer_key,
                  schedule_id,
                  catch_up_policy,
                  claim_slot,
                  due_slot,
                  scheduled_for_epoch_ms,
                  observed_at_epoch_ms,
                  coalesced_missed_slots,
                  claimed_at
                ) VALUES (${input.homeStation}, ${input.timerKey}, ${input.scheduleId}, 'coalesce-latest',
                  ${claimSlot}, ${claimSlot}, ${input.dueAtEpochMs}, ${input.nowEpochMs}, '0', ${claimedAt})
              `.raw.pipe(Effect.flatMap(decodeChanges));
            if (Number(firing.changes) !== 1) {
              return { _tag: "Duplicate" as const };
            }
            // Expression timers do not use the interval cursor (slot successor
            // invariant). Dedup is the firings primary key only.
            return {
              _tag: "Claimed" as const,
              dueAtEpochMs: input.dueAtEpochMs,
              nextDueAtEpochMs: input.nextDueAtEpochMs,
            };
          }))
          .pipe(
            Effect.provideService(StateTransactionOperation, "scheduler.claim-expression"),
            Effect.mapError((error) =>
              persistenceError("claim-expression", error)
            ),
          );
      });

      const reconcileHome = Effect.fn(
        "SchedulerRepository.reconcileHome",
      )(function* (
        homeStation: string,
        activeTimerKeys: ReadonlyArray<string>,
      ) {
        if (
          !isHostId(homeStation) ||
          activeTimerKeys.some((key) => !isTimerKey(key))
        ) {
          return yield* SchedulerInputError.make({
            operation: "reconcile-home",
            message:
              "scheduler reconciliation requires one valid home and valid timer keys",
          });
        }
        const active = new Set(activeTimerKeys);
        return yield* sql.withTransaction(Effect.gen(function* () {
            const stored = yield* selectKeys(undefined);
            let removed = 0;
            for (const row of stored) {
              if (
                row.home_station === homeStation &&
                active.has(row.timer_key)
              ) {
                continue;
              }
              const result = yield* sql`
                  DELETE FROM scheduler_interval_state
                  WHERE home_station = ${row.home_station} AND timer_key = ${row.timer_key}
                `.raw.pipe(Effect.flatMap(decodeChanges));
              removed += Number(result.changes);
            }
            return removed;
          }))
          .pipe(
            Effect.provideService(StateTransactionOperation, "scheduler.reconcile-home"),
            Effect.mapError((error) =>
              persistenceError("reconcile-home", error)
            ),
          );
      });

      const readIntervalState = Effect.fn("SchedulerRepository.readIntervalState")(function* (
        homeStation: string,
        timerKey: string,
      ) {
        const row = (yield* selectState({ homeStation, timerKey }))[0];
        return row === undefined ? undefined : yield* stateFromRow(row);
      }, Effect.mapError((error) => persistenceError("read-interval-state", error)));

      return SchedulerRepository.of({
        claimInterval,
        claimExpression,
        reconcileHome,
        readIntervalState,
      });
    }),
  );

export const SchedulerRepositoryLive = makeSchedulerRepositoryLive();
