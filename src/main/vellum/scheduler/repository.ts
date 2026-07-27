import { randomUUID } from "node:crypto";
import { Context, Effect, Layer, Schema } from "effect";
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
  StateEngine,
  type StateEngineError,
  type StateRow,
  type StateWriter,
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
    cause: Schema.Defect,
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

export class SchedulerRepository extends Context.Tag(
  "@vellum/SchedulerRepository",
)<
  SchedulerRepository,
  {
    readonly claimInterval: (
      input: SchedulerClaimInput,
    ) => Effect.Effect<SchedulerClaimResult, SchedulerRepositoryError>;
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
  }
>() {}

type SchedulerStateRow = StateRow & {
  readonly home_station: string;
  readonly timer_key: string;
  readonly schedule_id: string;
  readonly interval_milliseconds: number;
  readonly catch_up_policy: string;
  readonly next_due_at_epoch_ms: number;
  readonly next_due_slot: string;
  readonly last_fired_slot: string | null;
  readonly updated_at: string;
};

const isHostId = Schema.is(HostId);
const isTimerKey = Schema.is(TimerKey);
const decodeState = Schema.decodeUnknownEither(IntervalTimerState);

const persistenceError = (
  operation: string,
  error: StateEngineError,
): SchedulerRepositoryError =>
  error.cause instanceof SchedulerStateCorruptError ||
  error.cause instanceof SchedulerInputError
    ? error.cause
    : SchedulerPersistenceError.make({
        operation,
        message: error.message,
        cause: error,
      });

const selectState = (
  reader: Pick<StateWriter, "get">,
  homeStation: string,
  timerKey: string,
): SchedulerStateRow | undefined =>
  reader.get<SchedulerStateRow>(
    `
      SELECT
        home_station,
        timer_key,
        schedule_id,
        interval_milliseconds,
        catch_up_policy,
        next_due_at_epoch_ms,
        next_due_slot,
        last_fired_slot,
        updated_at
      FROM scheduler_interval_state
      WHERE home_station = ? AND timer_key = ?
    `,
    [homeStation, timerKey],
  );

const stateFromRow = (
  row: SchedulerStateRow,
): IntervalTimerStateValue => {
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
  if (decoded._tag === "Left") {
    throw SchedulerStateCorruptError.make({
      homeStation: row.home_station,
      timerKey: row.timer_key,
      message:
        "persisted interval cursor does not satisfy the scheduler contract",
    });
  }
  return decoded.right;
};

const writeState = (
  writer: StateWriter,
  homeStation: string,
  timerKey: string,
  state: IntervalTimerStateValue,
  updatedAt: string,
): void => {
  writer.run(
    `
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(home_station, timer_key) DO UPDATE SET
        schedule_id = excluded.schedule_id,
        interval_milliseconds = excluded.interval_milliseconds,
        catch_up_policy = excluded.catch_up_policy,
        next_due_at_epoch_ms = excluded.next_due_at_epoch_ms,
        next_due_slot = excluded.next_due_slot,
        last_fired_slot = excluded.last_fired_slot,
        updated_at = excluded.updated_at
    `,
    [
      homeStation,
      timerKey,
      state.scheduleId,
      state.intervalMilliseconds,
      state.catchUpPolicy,
      state.nextDueAtEpochMs,
      state.nextDueSlot,
      state.lastFiredSlot ?? null,
      updatedAt,
    ],
  );
};

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
): Layer.Layer<SchedulerRepository, never, StateEngine> =>
  Layer.effect(
    SchedulerRepository,
    Effect.gen(function* () {
      const state = yield* StateEngine;
      const makeScheduleId = options.makeScheduleId ?? randomUUID;
      const timestamp =
        options.now ??
        ((epochMilliseconds: number) =>
          new Date(epochMilliseconds).toISOString());

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

        return yield* state
          .transaction("scheduler.claim-interval", (writer) => {
            const currentRow = selectState(
              writer,
              homeCandidate,
              timerCandidate,
            );
            const current =
              currentRow === undefined
                ? undefined
                : stateFromRow(currentRow);
            const requestedInterval =
              typeof input.everyMinutes === "number"
                ? input.everyMinutes * 60_000
                : Number.NaN;

            if (
              current === undefined ||
              current.intervalMilliseconds !== requestedInterval
            ) {
              const initialized = initialize(input, makeScheduleId);
              if (initialized._tag === "Ineligible") return initialized;
              writeState(
                writer,
                homeCandidate,
                timerCandidate,
                initialized.state,
                timestamp(input.nowEpochMs as number),
              );
              return initialized;
            }

            const evaluated = evaluateIntervalTimer({
              ...input,
              state: current,
            });
            if (evaluated._tag !== "Firing") return evaluated;

            const firing = writer.run(
              `
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
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `,
              [
                homeCandidate,
                timerCandidate,
                evaluated.identity.scheduleId,
                evaluated.catchUpPolicy,
                evaluated.identity.claimSlot,
                evaluated.dueSlot,
                evaluated.scheduledForEpochMs,
                evaluated.observedAtEpochMs,
                evaluated.coalescedMissedSlots,
                timestamp(evaluated.observedAtEpochMs),
              ],
            );
            if (Number(firing.changes) !== 1) {
              throw SchedulerStateCorruptError.make({
                homeStation: homeCandidate,
                timerKey: timerCandidate,
                message:
                  "interval cursor points at an already-claimed firing slot",
              });
            }
            writeState(
              writer,
              homeCandidate,
              timerCandidate,
              evaluated.nextState,
              timestamp(evaluated.observedAtEpochMs),
            );
            return evaluated;
          })
          .pipe(
            Effect.mapError((error) =>
              persistenceError("claim-interval", error)
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
        return yield* state
          .transaction("scheduler.reconcile-home", (writer) => {
            const stored = writer.all<
              StateRow & {
                readonly home_station: string;
                readonly timer_key: string;
              }
            >(
              `
                SELECT home_station, timer_key
                FROM scheduler_interval_state
              `,
            );
            let removed = 0;
            for (const row of stored) {
              if (
                row.home_station === homeStation &&
                active.has(row.timer_key)
              ) {
                continue;
              }
              const result = writer.run(
                `
                  DELETE FROM scheduler_interval_state
                  WHERE home_station = ? AND timer_key = ?
                `,
                [row.home_station, row.timer_key],
              );
              removed += Number(result.changes);
            }
            return removed;
          })
          .pipe(
            Effect.mapError((error) =>
              persistenceError("reconcile-home", error)
            ),
          );
      });

      const readIntervalState = (
        homeStation: string,
        timerKey: string,
      ) =>
        state
          .read("scheduler.read-interval-state", (reader) => {
            const row = reader.get<SchedulerStateRow>(
              `
                SELECT
                  home_station,
                  timer_key,
                  schedule_id,
                  interval_milliseconds,
                  catch_up_policy,
                  next_due_at_epoch_ms,
                  next_due_slot,
                  last_fired_slot,
                  updated_at
                FROM scheduler_interval_state
                WHERE home_station = ? AND timer_key = ?
              `,
              [homeStation, timerKey],
            );
            return row === undefined ? undefined : stateFromRow(row);
          })
          .pipe(
            Effect.mapError((error) =>
              persistenceError("read-interval-state", error)
            ),
          );

      return SchedulerRepository.of({
        claimInterval,
        reconcileHome,
        readIntervalState,
      });
    }),
  );

export const SchedulerRepositoryLive = makeSchedulerRepositoryLive();
