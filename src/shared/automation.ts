/**
 * Automation model (plan 0.10/07): one Automations node holds automations, and
 * the editing machine's runner fires them. This file is the contract: the
 * definition, its triggers, conditions and actions, its limits, and the
 * firing record that history lists. Pure: effect only, no I/O.
 *
 * One shape, two forms. `automationShape(ref, commentable, node)` takes the
 * schema of a target: the stored form uses `MentionRef` and `NodeId`; the
 * CLI's input form passes target text (`@name`, `#42`, a `junto://` ref) that
 * main resolves. Nothing else differs, so a field added to one is added to
 * both.
 *
 * What the types refuse:
 * - a poll faster than POLL_MIN_EVERY_MS, a schedule that is not a five-field
 *   cron, a timezone the runtime does not know;
 * - a condition on an event (an artifact edit, a signal raised): a `when`
 *   holds a state checked at fire time, so only seat and task states qualify;
 * - a comment on a seat: comments go on tasks, artifacts and pages;
 * - limits outside their bounds: a cap reached skips and records, never
 *   disables, so every automation carries both caps;
 * - a firing whose outcome is neither fired nor skipped with a reason.
 *
 * Targets are checked by the runner, not here: every node `targetNodeIds`
 * returns must be in `automationTargets(canvas, automation.nodeId,
 * automation.author)` (region-reach.ts), rechecked at fire time. `author` is
 * stored for that recheck and set by main from the caller, never written.
 *
 * Stand-ins: `Anchor` belongs to mail-threads.ts (plan 03) and the task
 * states to task.ts (plan 04). Until those land they are declared below,
 * shaped exactly as the plans write them, and switch over when they do.
 */
import { Schema } from "effect";
import { isValidCronExpression } from "./cron-expression";
import { ArtifactMention, MentionRef, PageMention, TaskMention } from "./mention";
import { NodeId } from "./physics/schema";
import type { AutomationAuthor as ReachAuthor } from "./region-reach";
import { ItemId } from "./work-ids";

// ── Stand-ins (plans 03 and 04) ────────────────────────────────────────────

/** Stand-in for mail-threads.ts `Anchor` (plan 03). */
const Anchor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("whole") }),
  Schema.Struct({
    kind: Schema.Literal("box"),
    x: Schema.Finite,
    y: Schema.Finite,
    w: Schema.Finite,
    h: Schema.Finite,
    url: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("cells"), range: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("text"), quote: Schema.String, offset: Schema.optionalKey(Schema.Int) }),
  Schema.Struct({ kind: Schema.Literal("lines"), file: Schema.String, from: Schema.Int, to: Schema.Int }),
]);

/** Stand-in for task.ts task states (plan 04 "States"). */
export const AutomationTaskState = Schema.Literals([
  "backlog",
  "assigned",
  "working",
  "input-required",
  "in-review",
  "done",
  "canceled",
  "archived",
]);
export type AutomationTaskState = typeof AutomationTaskState.Type;

// ── Ids and bounds ─────────────────────────────────────────────────────────

/** An item on its Automations node, minted by the CLI process on create (02). */
export const AutomationId = ItemId;
export type AutomationId = ItemId;

export const FiringId = ItemId;
export type FiringId = ItemId;

/** The poll floor: no automation polls more than once a minute. */
export const POLL_MIN_EVERY_MS = 60_000;
/** The highest `maxPerHour` an automation may set: a loop through a seat is caught only by limits. */
export const MAX_PER_HOUR_CEILING = 60;
export const AUTOMATION_NAME_MAX_CHARS = 120;
export const AUTOMATION_TEXT_MAX_CHARS = 8_000;
export const AUTOMATION_STEPS_MAX = 16;

const Bounded = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }));
const EpochMs = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Text = (max: number) => Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(max)));
const Name = Text(AUTOMATION_NAME_MAX_CHARS);
const Body = Text(AUTOMATION_TEXT_MAX_CHARS);

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

// ── Vocabularies ───────────────────────────────────────────────────────────

/** A seat state as the runner sees it: pty's held states, never raw (seat-state-trigger.ts). */
export const SeatBecomes = Schema.Literals(["idle", "working", "attention", "gone"]);
export type SeatBecomes = typeof SeatBecomes.Type;

export const ArtifactEvent = Schema.Literals(["edited", "commented"]);
export type ArtifactEvent = typeof ArtifactEvent.Type;

export const WatchedSignal = Schema.Literals(["escalate", "blocked", "feedback"]);
export type WatchedSignal = typeof WatchedSignal.Type;

export const AutomationLimits = Schema.Struct({
  minIntervalMs: Bounded(0, 24 * 60 * 60_000),
  maxPerHour: Bounded(1, MAX_PER_HOUR_CEILING),
});
export type AutomationLimits = typeof AutomationLimits.Type;

export const DEFAULT_AUTOMATION_LIMITS: AutomationLimits = { minIntervalMs: 60_000, maxPerHour: 12 };

// ── The shape, over its targets ────────────────────────────────────────────

/**
 * `ref` names a seat, task, artifact or page; `commentable` a task, artifact
 * or page; `node` a canvas node (where a task is created, which tasks node a
 * task watch covers).
 */
export const automationShape = <Ref extends Schema.Top, Commentable extends Schema.Top, Node extends Schema.Top>(
  ref: Ref,
  commentable: Commentable,
  node: Node,
) => {
  const seatWatch = { kind: Schema.Literal("seat"), seat: ref, becomes: SeatBecomes };
  const taskWatch = {
    kind: Schema.Literal("task"),
    task: Schema.Union([ref, Schema.Struct({ node })]),
    becomes: AutomationTaskState,
  };

  const Watch = Schema.Union([
    Schema.Struct(seatWatch),
    Schema.Struct(taskWatch),
    Schema.Struct({ kind: Schema.Literal("artifact"), artifact: ref, event: ArtifactEvent }),
    Schema.Struct({ kind: Schema.Literal("signal"), from: Schema.optionalKey(ref), signal: WatchedSignal }),
  ]);

  /** A state that must hold when the automation fires. Events only trigger: they leave no state to check. */
  const Condition = Schema.Union([
    Schema.Struct({ ...seatWatch, holds: Schema.Literal(true) }),
    Schema.Struct({ ...taskWatch, holds: Schema.Literal(true) }),
  ]);

  const Trigger = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("schedule"), cron: Cron, timezone: Timezone }),
    Schema.Struct({ kind: Schema.Literal("poll"), everyMs: Bounded(POLL_MIN_EVERY_MS, 7 * 24 * 60 * 60_000) }),
    Schema.Struct({ kind: Schema.Literal("change"), on: Watch }),
    /** Reserved: decodes so the shape is fixed, refused in 0.10 (`triggerRefusal`). */
    Schema.Struct({ kind: Schema.Literal("webhook"), endpointId: Text(128) }),
  ]);

  const Action = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("mail"), to: ref, text: Body }),
    Schema.Struct({ kind: Schema.Literal("create-task"), node, title: Name, assign: Schema.optionalKey(ref) }),
    Schema.Struct({ kind: Schema.Literal("assign-task"), task: ref, to: ref }),
    Schema.Struct({ kind: Schema.Literal("comment"), on: commentable, anchor: Schema.optionalKey(Anchor), text: Body }),
  ]);

  /** Everything a writer says; identity, author and version sit beside it. */
  const Definition = Schema.Struct({
    name: Name,
    enabled: Schema.Boolean,
    trigger: Trigger,
    when: Schema.optionalKey(Schema.Array(Condition).pipe(Schema.check(Schema.isMaxLength(AUTOMATION_STEPS_MAX)))),
    then: Schema.Array(Action).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(AUTOMATION_STEPS_MAX))),
    limits: AutomationLimits,
  });

  return { Watch, Condition, Trigger, Action, Definition } as const;
};

// ── The stored form ────────────────────────────────────────────────────────

const stored = automationShape(MentionRef, Schema.Union([TaskMention, ArtifactMention, PageMention]), NodeId);

export const Watch = stored.Watch;
export type Watch = typeof Watch.Type;
export const Condition = stored.Condition;
export type Condition = typeof Condition.Type;
export const Trigger = stored.Trigger;
export type Trigger = typeof Trigger.Type;
export type TriggerKind = Trigger["kind"];
export const Action = stored.Action;
export type Action = typeof Action.Type;
export type ActionKind = Action["kind"];
export const AutomationDefinition = stored.Definition;
export type AutomationDefinition = typeof AutomationDefinition.Type;

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
  author: AutomationAuthor,
  ...stored.Definition.fields,
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

const watchNodes = (watch: Watch | Condition): ReadonlyArray<NodeId> => {
  switch (watch.kind) {
    case "seat":
      return [watch.seat.nodeId];
    case "task":
      return ["kind" in watch.task ? watch.task.nodeId : watch.task.node];
    case "artifact":
      return [watch.artifact.nodeId];
    case "signal":
      return watch.from === undefined ? [] : [watch.from.nodeId];
    default:
      return watch satisfies never;
  }
};

const actionNodes = (action: Action): ReadonlyArray<NodeId> => {
  switch (action.kind) {
    case "mail":
      return [action.to.nodeId];
    case "create-task":
      return action.assign === undefined ? [action.node] : [action.node, action.assign.nodeId];
    case "assign-task":
      return [action.task.nodeId, action.to.nodeId];
    case "comment":
      return [action.on.nodeId];
    default:
      return action satisfies never;
  }
};

/**
 * Every node the automation names, once, for the fire-time reach recheck:
 * each must be among `automationTargets(canvas, automation.nodeId, automation.author)`.
 */
export const targetNodeIds = (automation: Automation): ReadonlyArray<NodeId> => {
  const ids = new Set<NodeId>();
  if (automation.trigger.kind === "change") for (const id of watchNodes(automation.trigger.on)) ids.add(id);
  for (const condition of automation.when ?? []) for (const id of watchNodes(condition)) ids.add(id);
  for (const action of automation.then) for (const id of actionNodes(action)) ids.add(id);
  return [...ids];
};

// ── Firings ────────────────────────────────────────────────────────────────

/**
 * Why the runner considered firing. `run` is `junto automation run`. A missed
 * schedule or poll fires once for its latest slot; `missed` counts the earlier
 * slots it coalesced, which never fire.
 */
export const FiringCause = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("schedule"), slot: EpochMs, missed: Count }),
  Schema.Struct({ kind: Schema.Literal("poll"), slot: EpochMs, missed: Count }),
  /** `key` dedupes a transition: seat and epoch for a seat watch, fact id otherwise. */
  Schema.Struct({ kind: Schema.Literal("change"), key: Text(256) }),
  Schema.Struct({ kind: Schema.Literal("run") }),
]);
export type FiringCause = typeof FiringCause.Type;

/** Why a considered firing did nothing. A cap reached skips; it never disables. */
export const SKIP_REASONS = [
  "disabled",
  "condition_unmet",
  "min_interval",
  "max_per_hour",
  "out_of_reach",
  "not_available",
] as const;
export const SkipReason = Schema.Literals(SKIP_REASONS);
export type SkipReason = typeof SkipReason.Type;

/** One action's ruling, by its index in `then`. `queued` waits on the editing machine (02). */
export const ActionRuling = Schema.Union([
  Schema.Struct({ index: Bounded(0, AUTOMATION_STEPS_MAX - 1), ruling: Schema.Literal("applied") }),
  Schema.Struct({ index: Bounded(0, AUTOMATION_STEPS_MAX - 1), ruling: Schema.Literal("queued") }),
  Schema.Struct({ index: Bounded(0, AUTOMATION_STEPS_MAX - 1), ruling: Schema.Literal("refused"), code: Text(64) }),
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
 * The limit a firing at `now` would break, given when this automation last
 * fired (skips do not count). Undefined when both limits allow it.
 */
export const limitSkip = (
  limits: AutomationLimits,
  firedAt: ReadonlyArray<number>,
  now: number,
): "min_interval" | "max_per_hour" | undefined => {
  let latest = Number.NEGATIVE_INFINITY;
  let inHour = 0;
  for (const at of firedAt) {
    if (at > latest) latest = at;
    if (at > now - HOUR_MS && at <= now) inHour += 1;
  }
  if (now - latest < limits.minIntervalMs) return "min_interval";
  if (inHour >= limits.maxPerHour) return "max_per_hour";
  return undefined;
};
