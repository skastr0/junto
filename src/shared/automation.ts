/**
 * Automation model (plan 0.10/07): one Automations node holds automations, and
 * the editing machine's runner fires them. This file is the contract: the
 * definition, its triggers, conditions and actions, its limits, and the
 * firing record that history lists. Pure: effect only, no I/O.
 *
 * What the types refuse:
 * - a poll faster than POLL_MIN_EVERY_MS, a schedule that is not a five-field
 *   cron, a timezone the runtime does not know;
 * - a condition on an event (an artifact edit, a signal raised): a `when`
 *   holds a state checked at fire time, so only seat and task states qualify;
 * - limits outside their bounds: a cap reached skips and records, never
 *   disables, so every automation carries both caps;
 * - a firing whose outcome is neither fired nor skipped-with-a-reason.
 *
 * Targets are checked by the runner, not here: every ref `refsOf` returns must
 * be in `automationTargets(canvas, automation.nodeId, automation.author)`
 * (region-reach.ts), rechecked at fire time. `author` is stored for
 * that recheck: downward and within the author's reach, unless the author is
 * the operator.
 *
 * Stand-ins: `MentionRef` and `ThreadSubject` belong to mention.ts and
 * mail-threads.ts (plan 03), `TaskPhase` to task.ts (plan 04). Until those
 * land they are declared below, shaped exactly as the plans write them, and
 * the imports switch over when they do.
 */
import { Schema } from "effect";
import { isValidCronExpression } from "./cron-expression";
import { NodeId } from "./physics/schema";
import type { AutomationAuthor as ReachAuthor } from "./region-reach";

// ── Stand-ins (plans 03 and 04) ────────────────────────────────────────────

const ItemId = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(256)));

/** Stand-in for mention.ts `MentionRef` (plan 03). */
const MentionRef = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("seat"), nodeId: NodeId }),
  Schema.Struct({ kind: Schema.Literal("task"), nodeId: NodeId, taskId: ItemId }),
  Schema.Struct({ kind: Schema.Literal("artifact"), nodeId: NodeId, artifactId: ItemId }),
  Schema.Struct({ kind: Schema.Literal("page"), nodeId: NodeId }),
]);
type MentionRef = typeof MentionRef.Type;

const Px = Schema.Number.pipe(Schema.check(Schema.isFinite()));
const Anchor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("whole") }),
  Schema.Struct({ kind: Schema.Literal("box"), x: Px, y: Px, w: Px, h: Px, url: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("cells"), range: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("text"), quote: Schema.String, offset: Schema.optionalKey(Schema.Number) }),
  Schema.Struct({ kind: Schema.Literal("lines"), file: Schema.String, from: Schema.Number, to: Schema.Number }),
]);

/** Stand-in for mail-threads.ts `ThreadSubject` (plan 03). */
const ThreadSubject = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("mailbox"), seat: NodeId }),
  Schema.Struct({ kind: Schema.Literal("task"), nodeId: NodeId, taskId: ItemId }),
  Schema.Struct({
    kind: Schema.Literal("artifact"),
    nodeId: NodeId,
    artifactId: ItemId,
    anchor: Schema.optionalKey(Anchor),
  }),
  Schema.Struct({ kind: Schema.Literal("page"), nodeId: NodeId, anchor: Schema.optionalKey(Anchor) }),
]);

/** Stand-in for task.ts task states (plan 04 "States"). */
const TaskPhase = Schema.Literals([
  "backlog",
  "assigned",
  "working",
  "input-required",
  "in-review",
  "done",
  "canceled",
  "archived",
]);

// ── Ids and bounds ─────────────────────────────────────────────────────────

export const AutomationId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(128)),
  Schema.brand("AutomationId"),
);
export type AutomationId = typeof AutomationId.Type;

export const FiringId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(128)),
  Schema.brand("FiringId"),
);
export type FiringId = typeof FiringId.Type;

/** The poll floor: no automation polls more than once a minute. */
export const POLL_MIN_EVERY_MS = 60_000;
/** The highest `maxPerHour` an automation may set. */
export const MAX_PER_HOUR_CEILING = 60;
export const AUTOMATION_NAME_MAX_CHARS = 120;
export const AUTOMATION_TEXT_MAX_CHARS = 4_000;
export const AUTOMATION_TITLE_MAX_CHARS = 200;
export const AUTOMATION_MAX_ACTIONS = 16;
export const AUTOMATION_MAX_CONDITIONS = 16;

const Int = (minimum: number, maximum: number) =>
  Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isBetween({ minimum, maximum })));

const EpochMs = Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0)));

const Text = (max: number) =>
  Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(max)));

const isKnownTimezone = (timezone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
};

const Cron = Schema.String.pipe(Schema.check(Schema.makeFilter((cron) => isValidCronExpression(cron))));
const Timezone = Schema.String.pipe(Schema.check(Schema.makeFilter((timezone) => isKnownTimezone(timezone))));

// ── Watches, triggers and conditions ───────────────────────────────────────

/** A seat state as the runner sees it: pty's held states, never raw (plan 07 Runner). */
export const SeatBecomes = Schema.Literals(["idle", "working", "attention", "gone"]);
export type SeatBecomes = typeof SeatBecomes.Type;

export const AutomationSignal = Schema.Literals(["escalate", "blocked", "feedback"]);
export type AutomationSignal = typeof AutomationSignal.Type;

const seatWatch = { kind: Schema.Literal("seat"), seat: MentionRef, becomes: SeatBecomes };
const taskWatch = {
  kind: Schema.Literal("task"),
  task: Schema.Union([MentionRef, Schema.Struct({ node: NodeId })]),
  becomes: TaskPhase,
};
const artifactWatch = {
  kind: Schema.Literal("artifact"),
  artifact: MentionRef,
  event: Schema.Literals(["edited", "commented"]),
};
const signalWatch = { kind: Schema.Literal("signal"), from: Schema.optionalKey(MentionRef), signal: AutomationSignal };

export const Watch = Schema.Union([
  Schema.Struct(seatWatch),
  Schema.Struct(taskWatch),
  Schema.Struct(artifactWatch),
  Schema.Struct(signalWatch),
]);
export type Watch = typeof Watch.Type;

/**
 * A state that must hold when the automation fires. Events (an artifact edit,
 * a signal raised) only trigger; they have no state to check later.
 */
export const Condition = Schema.Union([
  Schema.Struct({ ...seatWatch, holds: Schema.Literal(true) }),
  Schema.Struct({ ...taskWatch, holds: Schema.Literal(true) }),
]);
export type Condition = typeof Condition.Type;

export const Trigger = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("schedule"), cron: Cron, timezone: Timezone }),
  Schema.Struct({ kind: Schema.Literal("poll"), everyMs: Int(POLL_MIN_EVERY_MS, 7 * 24 * 60 * 60_000) }),
  Schema.Struct({ kind: Schema.Literal("change"), on: Watch }),
  /** Reserved: decodes so the shape is fixed, refused in 0.10 (`triggerRefusal`). */
  Schema.Struct({ kind: Schema.Literal("webhook"), endpointId: Text(128) }),
]);
export type Trigger = typeof Trigger.Type;
export type TriggerKind = Trigger["kind"];

// ── Actions ────────────────────────────────────────────────────────────────

export const Action = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("mail"), to: MentionRef, text: Text(AUTOMATION_TEXT_MAX_CHARS) }),
  Schema.Struct({
    kind: Schema.Literal("create-task"),
    node: NodeId,
    title: Text(AUTOMATION_TITLE_MAX_CHARS),
    assign: Schema.optionalKey(MentionRef),
  }),
  Schema.Struct({ kind: Schema.Literal("assign-task"), task: MentionRef, to: MentionRef }),
  Schema.Struct({ kind: Schema.Literal("comment"), on: ThreadSubject, text: Text(AUTOMATION_TEXT_MAX_CHARS) }),
]);
export type Action = typeof Action.Type;
export type ActionKind = Action["kind"];

// ── The automation ─────────────────────────────────────────────────────────

export const AutomationLimits = Schema.Struct({
  minIntervalMs: Int(0, 24 * 60 * 60_000),
  maxPerHour: Int(1, MAX_PER_HOUR_CEILING),
});
export type AutomationLimits = typeof AutomationLimits.Type;

export const DEFAULT_AUTOMATION_LIMITS: AutomationLimits = { minIntervalMs: 60_000, maxPerHour: 12 };

/** Who wrote it: the operator gets everything below the node, a seat only its reach. */
export const AutomationAuthor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("operator") }),
  Schema.Struct({ kind: Schema.Literal("seat"), seat: NodeId }),
]);
export type AutomationAuthor = typeof AutomationAuthor.Type;

// The stored author is exactly what `automationTargets` takes, both ways.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const authorIsReachAuthor: Same<AutomationAuthor, ReachAuthor> = true;
void authorIsReachAuthor;

export const Automation = Schema.Struct({
  automationId: AutomationId,
  nodeId: NodeId,
  name: Text(AUTOMATION_NAME_MAX_CHARS),
  enabled: Schema.Boolean,
  author: AutomationAuthor,
  trigger: Trigger,
  when: Schema.optionalKey(
    Schema.Array(Condition).pipe(Schema.check(Schema.isMaxLength(AUTOMATION_MAX_CONDITIONS))),
  ),
  then: Schema.Array(Action).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(AUTOMATION_MAX_ACTIONS)),
  ),
  limits: AutomationLimits,
});
export type Automation = typeof Automation.Type;
export type AutomationWire = typeof Automation.Encoded;

export const decodeAutomation = Schema.decodeUnknownResult(Automation, { onExcessProperty: "error" });

/** 0.10 refuses webhook triggers; everything else is available. */
export const triggerRefusal = (trigger: Trigger): "not_available" | undefined => {
  switch (trigger.kind) {
    case "schedule":
    case "poll":
    case "change":
      return undefined;
    case "webhook":
      return "not_available";
    default:
      return trigger satisfies never;
  }
};

const watchRefs = (watch: Watch | Condition): ReadonlyArray<MentionRef> => {
  switch (watch.kind) {
    case "seat":
      return [watch.seat];
    case "task":
      return "kind" in watch.task ? [watch.task] : [];
    case "artifact":
      return [watch.artifact];
    case "signal":
      return watch.from === undefined ? [] : [watch.from];
    default:
      return watch satisfies never;
  }
};

const actionRefs = (action: Action): ReadonlyArray<MentionRef> => {
  switch (action.kind) {
    case "mail":
      return [action.to];
    case "create-task":
      return action.assign === undefined ? [] : [action.assign];
    case "assign-task":
      return [action.task, action.to];
    case "comment":
      return [];
    default:
      return action satisfies never;
  }
};

/**
 * Every node the automation names, for the fire-time reach recheck: each must
 * be among `automationTargets(canvas, automation.nodeId, automation.author)`.
 */
export const targetNodeIds = (automation: Automation): ReadonlyArray<NodeId> => {
  const ids = new Set<NodeId>();
  if (automation.trigger.kind === "change") {
    for (const ref of watchRefs(automation.trigger.on)) ids.add(ref.nodeId);
    if (automation.trigger.on.kind === "task" && !("kind" in automation.trigger.on.task)) {
      ids.add(automation.trigger.on.task.node);
    }
  }
  for (const condition of automation.when ?? []) {
    for (const ref of watchRefs(condition)) ids.add(ref.nodeId);
    if (condition.kind === "task" && !("kind" in condition.task)) ids.add(condition.task.node);
  }
  for (const action of automation.then) {
    for (const ref of actionRefs(action)) ids.add(ref.nodeId);
    if (action.kind === "create-task") ids.add(action.node);
    if (action.kind === "comment") ids.add(action.on.kind === "mailbox" ? action.on.seat : action.on.nodeId);
  }
  return [...ids];
};

// ── Firings ────────────────────────────────────────────────────────────────

/**
 * Why the runner considered firing. `run` is `junto automation run`. A missed
 * schedule or poll fires once for its latest slot; `missed` counts the earlier
 * slots it coalesced, which never fire.
 */
export const FiringCause = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("schedule"), slot: EpochMs, missed: Int(0, Number.MAX_SAFE_INTEGER) }),
  Schema.Struct({ kind: Schema.Literal("poll"), slot: EpochMs, missed: Int(0, Number.MAX_SAFE_INTEGER) }),
  /** `key` dedupes a transition: seat and epoch for a seat watch, fact id otherwise. */
  Schema.Struct({ kind: Schema.Literal("change"), key: Text(256) }),
  Schema.Struct({ kind: Schema.Literal("run") }),
]);
export type FiringCause = typeof FiringCause.Type;

/** Why a considered firing did not fire. */
export const SkipReason = Schema.Literals([
  "disabled",
  "condition-unmet",
  "min-interval",
  "max-per-hour",
  "out-of-reach",
  "not-available",
]);
export type SkipReason = typeof SkipReason.Type;

/** One action's ruling, by its index in `then`. */
export const ActionRuling = Schema.Union([
  Schema.Struct({ index: Int(0, AUTOMATION_MAX_ACTIONS - 1), ruled: Schema.Literal("applied") }),
  Schema.Struct({ index: Int(0, AUTOMATION_MAX_ACTIONS - 1), ruled: Schema.Literal("refused"), code: Text(64) }),
]);
export type ActionRuling = typeof ActionRuling.Type;

export const FiringOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("fired"), actions: Schema.Array(ActionRuling) }),
  Schema.Struct({ kind: Schema.Literal("skipped"), reason: SkipReason }),
]);
export type FiringOutcome = typeof FiringOutcome.Type;

export const Firing = Schema.Struct({
  firingId: FiringId,
  automationId: AutomationId,
  at: EpochMs,
  cause: FiringCause,
  outcome: FiringOutcome,
});
export type Firing = typeof Firing.Type;

const HOUR_MS = 60 * 60_000;

/**
 * The limit a firing at `now` would break, given the times this automation
 * last fired (skips do not count). Undefined when both limits allow it.
 */
export const limitSkip = (
  limits: AutomationLimits,
  firedAt: ReadonlyArray<number>,
  now: number,
): "min-interval" | "max-per-hour" | undefined => {
  let latest = Number.NEGATIVE_INFINITY;
  let inHour = 0;
  for (const at of firedAt) {
    if (at > latest) latest = at;
    if (at > now - HOUR_MS && at <= now) inHour += 1;
  }
  if (now - latest < limits.minIntervalMs) return "min-interval";
  if (inHour >= limits.maxPerHour) return "max-per-hour";
  return undefined;
};
