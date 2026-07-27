import { Option, Schema } from "effect";
import { HostId } from "./remote-hosts";

/**
 * Pure interval-scheduler policy.
 *
 * Wall time decides whether a slot is due and is retained as scheduling
 * metadata. It is deliberately not an event ordering key: propagated work is
 * ordered by each home's durable sequence, outside this component.
 */

export const EpochMilliseconds = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
  Schema.filter(
    Number.isSafeInteger,
    { message: () => "epoch milliseconds must be a safe integer" },
  ),
);
export type EpochMilliseconds = typeof EpochMilliseconds.Type;

export const IntervalMilliseconds = Schema.Number.pipe(
  Schema.int(),
  Schema.positive(),
  Schema.filter(
    Number.isSafeInteger,
    { message: () => "interval milliseconds must be a safe integer" },
  ),
);
export type IntervalMilliseconds = typeof IntervalMilliseconds.Type;

export const TimerScheduleId = Schema.NonEmptyString.pipe(
  Schema.maxLength(256),
  Schema.brand("TimerScheduleId"),
);
export type TimerScheduleId = typeof TimerScheduleId.Type;

export const TimerKey = Schema.NonEmptyString.pipe(
  Schema.maxLength(512),
  Schema.brand("TimerKey"),
);
export type TimerKey = typeof TimerKey.Type;

/**
 * Decimal text keeps a slot exact after it outgrows JavaScript's safe integer
 * range and maps directly to SQLite TEXT. Never parse it through Number.
 */
export const TimerSlotId = Schema.String.pipe(
  Schema.pattern(/^(?:0|[1-9][0-9]*)$/),
  Schema.brand("TimerSlotId"),
);
export type TimerSlotId = typeof TimerSlotId.Type;

export const TimerSlotCount = Schema.String.pipe(
  Schema.pattern(/^(?:0|[1-9][0-9]*)$/),
  Schema.brand("TimerSlotCount"),
);
export type TimerSlotCount = typeof TimerSlotCount.Type;

export const INTERVAL_CATCH_UP_POLICY = "coalesce-latest" as const;
export const IntervalCatchUpPolicy = Schema.Literal(
  INTERVAL_CATCH_UP_POLICY,
);
export type IntervalCatchUpPolicy =
  typeof IntervalCatchUpPolicy.Type;

const TimerStateShape = Schema.Struct({
  version: Schema.Literal(1),
  scheduleId: TimerScheduleId,
  intervalMilliseconds: IntervalMilliseconds,
  catchUpPolicy: IntervalCatchUpPolicy,
  nextDueAtEpochMs: EpochMilliseconds,
  nextDueSlot: TimerSlotId,
  lastFiredSlot: Schema.optionalWith(TimerSlotId, { exact: true }),
});

/**
 * The persisted cursor is contiguous: after any fire, the next due slot is
 * exactly the successor of the last fired slot. That makes a corrupted or
 * partially-written cursor fail closed at decode time.
 */
export const IntervalTimerState = TimerStateShape.pipe(
  Schema.filter(
    (state) =>
      state.lastFiredSlot === undefined ||
      BigInt(state.nextDueSlot) === BigInt(state.lastFiredSlot) + 1n,
    {
      message: () =>
        "nextDueSlot must immediately follow lastFiredSlot",
    },
  ),
);
export type IntervalTimerState = typeof IntervalTimerState.Type;

export const TimerIneligibilityReason = Schema.Literal(
  "invalid-local-station",
  "unhomed",
  "ambiguous-home",
  "invalid-home",
  "foreign-home",
  "invalid-timer-key",
  "invalid-clock",
  "invalid-interval",
  "invalid-state",
  "interval-mismatch",
  "schedule-overflow",
);
export type TimerIneligibilityReason =
  typeof TimerIneligibilityReason.Type;

export type TimerIneligible = {
  readonly _tag: "Ineligible";
  readonly reason: TimerIneligibilityReason;
};

export type TimerNotDue = {
  readonly _tag: "NotDue";
  readonly state: IntervalTimerState;
  readonly dueSlot: TimerSlotId;
  readonly dueAtEpochMs: EpochMilliseconds;
};

/**
 * Composite identity intended for a UNIQUE database key.
 *
 * `claimSlot` is the slot read from persisted state, not the latest slot
 * observed on the wall clock. Two contenders that read the same state
 * therefore produce the same identity even if their clocks cross a later
 * interval boundary before evaluation completes.
 */
export const TimerFiringIdentity = Schema.Struct({
  homeStationId: HostId,
  timerKey: TimerKey,
  scheduleId: TimerScheduleId,
  claimSlot: TimerSlotId,
});
export type TimerFiringIdentity = typeof TimerFiringIdentity.Type;

export type CoalescedTimerFiring = {
  readonly _tag: "Firing";
  readonly identity: TimerFiringIdentity;
  readonly catchUpPolicy: IntervalCatchUpPolicy;
  /** Latest due slot at observedAtEpochMs; all earlier missed slots coalesce. */
  readonly dueSlot: TimerSlotId;
  readonly scheduledForEpochMs: EpochMilliseconds;
  readonly observedAtEpochMs: EpochMilliseconds;
  /** Number of additional due slots folded into this one firing. */
  readonly coalescedMissedSlots: TimerSlotCount;
  readonly nextState: IntervalTimerState;
};

export type IntervalTimerEvaluation =
  | TimerIneligible
  | TimerNotDue
  | CoalescedTimerFiring;

export type InitializeIntervalTimerInput = {
  readonly scheduleId: unknown;
  readonly nowEpochMs: unknown;
  readonly everyMinutes: unknown;
};

export type IntervalTimerInitialization =
  | {
      readonly _tag: "Initialized";
      readonly state: IntervalTimerState;
    }
  | TimerIneligible;

export type EvaluateIntervalTimerInput = {
  readonly timerKey: unknown;
  readonly localStationId: unknown;
  /**
   * Resolution happens outside this component. Exactly one valid candidate is
   * required; zero is unhomed and two (even duplicate values) is ambiguous.
   */
  readonly homeStationIds: ReadonlyArray<unknown>;
  readonly nowEpochMs: unknown;
  readonly everyMinutes: unknown;
  readonly state: unknown;
};

const decodeState = Schema.decodeUnknownOption(IntervalTimerState);
const isEpochMilliseconds = Schema.is(EpochMilliseconds);
const isHostId = Schema.is(HostId);
const isScheduleId = Schema.is(TimerScheduleId);
const isTimerKey = Schema.is(TimerKey);

const asSlotId = (value: bigint): TimerSlotId =>
  value.toString(10) as TimerSlotId;

const asSlotCount = (value: bigint): TimerSlotCount =>
  value.toString(10) as TimerSlotCount;

const intervalMillisecondsOf = (
  everyMinutes: unknown,
): IntervalMilliseconds | undefined => {
  if (typeof everyMinutes !== "number" || !Number.isFinite(everyMinutes)) {
    return undefined;
  }
  const milliseconds = everyMinutes * 60_000;
  return Number.isSafeInteger(milliseconds) && milliseconds > 0
    ? milliseconds as IntervalMilliseconds
    : undefined;
};

const ineligible = (
  reason: TimerIneligibilityReason,
): TimerIneligible => ({ _tag: "Ineligible", reason });

/**
 * Start a new interval schedule one full interval after discovery. A caller
 * mints and persists scheduleId; changing/resetting a timer mints a new one so
 * old firing keys cannot collide with the replacement schedule.
 */
export const initializeIntervalTimer = (
  input: InitializeIntervalTimerInput,
): IntervalTimerInitialization => {
  if (!isScheduleId(input.scheduleId)) {
    return ineligible("invalid-state");
  }
  if (!isEpochMilliseconds(input.nowEpochMs)) {
    return ineligible("invalid-clock");
  }
  const intervalMilliseconds = intervalMillisecondsOf(input.everyMinutes);
  if (intervalMilliseconds === undefined) {
    return ineligible("invalid-interval");
  }
  const nextDueAtEpochMs = input.nowEpochMs + intervalMilliseconds;
  if (!Number.isSafeInteger(nextDueAtEpochMs)) {
    return ineligible("schedule-overflow");
  }

  return {
    _tag: "Initialized",
    state: {
      version: 1,
      scheduleId: input.scheduleId,
      intervalMilliseconds,
      catchUpPolicy: INTERVAL_CATCH_UP_POLICY,
      nextDueAtEpochMs: nextDueAtEpochMs as EpochMilliseconds,
      nextDueSlot: asSlotId(0n),
    },
  };
};

const admitHome = (
  localStationId: unknown,
  homeStationIds: ReadonlyArray<unknown>,
): HostId | TimerIneligible => {
  if (!isHostId(localStationId)) {
    return ineligible("invalid-local-station");
  }
  if (homeStationIds.length === 0) {
    return ineligible("unhomed");
  }
  if (homeStationIds.length !== 1) {
    return ineligible("ambiguous-home");
  }
  const homeStationId = homeStationIds[0];
  if (!isHostId(homeStationId)) {
    return ineligible("invalid-home");
  }
  if (homeStationId !== localStationId) {
    return ineligible("foreign-home");
  }
  return homeStationId;
};

const isIneligible = (
  value: HostId | TimerIneligible,
): value is TimerIneligible =>
  typeof value !== "string";

/**
 * Evaluate one persisted interval cursor at an injected wall-clock instant.
 *
 * Late intervals coalesce to the latest due slot and advance directly to its
 * successor. The result contains exactly one firing, never a backlog array.
 */
export const evaluateIntervalTimer = (
  input: EvaluateIntervalTimerInput,
): IntervalTimerEvaluation => {
  const home = admitHome(input.localStationId, input.homeStationIds);
  if (isIneligible(home)) return home;
  if (!isTimerKey(input.timerKey)) {
    return ineligible("invalid-timer-key");
  }
  if (!isEpochMilliseconds(input.nowEpochMs)) {
    return ineligible("invalid-clock");
  }
  const requestedInterval = intervalMillisecondsOf(input.everyMinutes);
  if (requestedInterval === undefined) {
    return ineligible("invalid-interval");
  }

  const decodedState = decodeState(input.state);
  if (Option.isNone(decodedState)) {
    return ineligible("invalid-state");
  }
  const state = decodedState.value;
  if (state.intervalMilliseconds !== requestedInterval) {
    return ineligible("interval-mismatch");
  }

  if (input.nowEpochMs < state.nextDueAtEpochMs) {
    return {
      _tag: "NotDue",
      state,
      dueSlot: state.nextDueSlot,
      dueAtEpochMs: state.nextDueAtEpochMs,
    };
  }

  const elapsedSlots = Math.floor(
    (input.nowEpochMs - state.nextDueAtEpochMs) /
      state.intervalMilliseconds,
  );
  const dueSlot =
    BigInt(state.nextDueSlot) + BigInt(elapsedSlots);
  const scheduledForEpochMs =
    state.nextDueAtEpochMs +
    elapsedSlots * state.intervalMilliseconds;
  const nextDueAtEpochMs =
    scheduledForEpochMs + state.intervalMilliseconds;

  if (
    !Number.isSafeInteger(scheduledForEpochMs) ||
    !Number.isSafeInteger(nextDueAtEpochMs)
  ) {
    return ineligible("schedule-overflow");
  }

  const dueSlotId = asSlotId(dueSlot);
  const nextState: IntervalTimerState = {
    version: 1,
    scheduleId: state.scheduleId,
    intervalMilliseconds: state.intervalMilliseconds,
    catchUpPolicy: state.catchUpPolicy,
    nextDueAtEpochMs: nextDueAtEpochMs as EpochMilliseconds,
    nextDueSlot: asSlotId(dueSlot + 1n),
    lastFiredSlot: dueSlotId,
  };

  return {
    _tag: "Firing",
    identity: {
      homeStationId: home,
      timerKey: input.timerKey,
      scheduleId: state.scheduleId,
      claimSlot: state.nextDueSlot,
    },
    catchUpPolicy: state.catchUpPolicy,
    dueSlot: dueSlotId,
    scheduledForEpochMs:
      scheduledForEpochMs as EpochMilliseconds,
    observedAtEpochMs: input.nowEpochMs,
    coalescedMissedSlots: asSlotCount(BigInt(elapsedSlots)),
    nextState,
  };
};
