import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { HostId } from "@shared/remote-hosts";
import { TimerKey } from "@shared/scheduler-policy";
import {
  StateTransactionOperation,
} from "../state/service";

export class SchedulerPersistenceError extends Schema.TaggedError<SchedulerPersistenceError>()(
  "SchedulerPersistenceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
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
    readonly claimExpression: (
      input: ExpressionClaimInput,
    ) => Effect.Effect<ExpressionClaimResult, SchedulerRepositoryError>;
    readonly reconcileHome: (
      homeStation: string,
      activeTimerKeys: ReadonlyArray<string>,
    ) => Effect.Effect<number, SchedulerRepositoryError>;
  }>()("@junto/SchedulerRepository") {}

const decodeChanges = Schema.decodeUnknownEffect(Schema.Struct({
  changes: Schema.Union([Schema.Number, Schema.BigInt]),
}));

const isHostId = Schema.is(HostId);
const isTimerKey = Schema.is(TimerKey);

const persistenceError = (
  operation: string,
  error: unknown,
): SchedulerRepositoryError =>
  error instanceof SchedulerInputError
    ? error
    : SchedulerPersistenceError.make({
        operation,
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });

export type SchedulerRepositoryOptions = {
  readonly now?: (epochMilliseconds: number) => string;
};

export const makeSchedulerRepositoryLive = (
  options: SchedulerRepositoryOptions = {},
): Layer.Layer<SchedulerRepository, never, SqlClient.SqlClient> =>
  Layer.effect(
    SchedulerRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const selectKeys = SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ home_station: Schema.String, timer_key: Schema.String }),
        execute: () => sql`SELECT home_station, timer_key FROM scheduler_interval_state`,
      });
      const formatTimestamp =
        options.now ??
        ((epochMilliseconds: number) =>
          new Date(epochMilliseconds).toISOString());
      const timestamp = (epochMilliseconds: number) => Effect.try({
        try: () => formatTimestamp(epochMilliseconds),
        catch: (error) => error,
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
            // Dedup is the firings primary key only.
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

      return SchedulerRepository.of({
        claimExpression,
        reconcileHome,
      });
    }),
  );

export const SchedulerRepositoryLive = makeSchedulerRepositoryLive();
