/**
 * Stand-in for canvas's 0.10 automation contract (`src/shared/automation.ts`,
 * plan 07, track C5). `junto automation` builds against this file only; when
 * the real contract lands the imports switch over and this file goes. Pure:
 * effect only.
 *
 * One shape, two forms. Every place a definition names a seat, task, artifact
 * or page is a type parameter: the input form a seat writes carries target
 * text (`@name`, `#42`, a `junto://` ref), and main resolves each into the
 * stored form. Nothing else differs between the two, so a field added to one
 * is added to both.
 */
import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Ids

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Minted by the CLI process on create and kept by the ruling (02). */
export const AutomationId = Schema.String.pipe(
  Schema.check(Schema.isPattern(ULID)),
  Schema.brand("AutomationId"),
);
export type AutomationId = typeof AutomationId.Type;

/** The head an edit was written against; a stale one is refused `Stale`. */
export const AutomationVersion = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  Schema.brand("AutomationVersion"),
);
export type AutomationVersion = typeof AutomationVersion.Type;

// ---------------------------------------------------------------------------
// Closed vocabularies

/** Plan 04 task states. */
export const AUTOMATION_TASK_STATES = [
  "backlog",
  "assigned",
  "working",
  "input-required",
  "in-review",
  "done",
  "canceled",
  "archived",
] as const;
export const AutomationTaskState = Schema.Literals(AUTOMATION_TASK_STATES);
export type AutomationTaskState = typeof AutomationTaskState.Type;

export const SeatBecomes = Schema.Literals(["idle", "working", "attention", "gone"]);
export type SeatBecomes = typeof SeatBecomes.Type;

export const ArtifactEvent = Schema.Literals(["edited", "commented"]);
export type ArtifactEvent = typeof ArtifactEvent.Type;

export const WatchedSignal = Schema.Literals(["escalate", "blocked", "feedback"]);
export type WatchedSignal = typeof WatchedSignal.Type;

export const TRIGGER_KINDS = ["schedule", "poll", "change", "webhook"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export const ACTION_KINDS = ["mail", "create-task", "assign-task", "comment"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** Plan 03 anchors on a comment's subject. */
export const Anchor = Schema.Union([
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
  Schema.Struct({
    kind: Schema.Literal("text"),
    quote: Schema.String,
    offset: Schema.optionalKey(Schema.Int),
  }),
  Schema.Struct({
    kind: Schema.Literal("lines"),
    file: Schema.String,
    from: Schema.Int,
    to: Schema.Int,
  }),
]);
export type Anchor = typeof Anchor.Type;

// ---------------------------------------------------------------------------
// Bounds

/** A poll never runs faster than once a minute (07). */
export const POLL_FLOOR_MS = 60_000;
export const AUTOMATION_NAME_MAX = 120;
export const AUTOMATION_TEXT_MAX = 8_000;
export const AUTOMATION_STEPS_MAX = 16;

const Name = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(AUTOMATION_NAME_MAX)),
);
const Text = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(AUTOMATION_TEXT_MAX)),
);
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const AutomationLimits = Schema.Struct({
  minIntervalMs: NonNegativeInt,
  maxPerHour: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3_600 })),
});
export type AutomationLimits = typeof AutomationLimits.Type;

// ---------------------------------------------------------------------------
// The shape, over its targets

/**
 * `ref` names a seat, task, artifact or page; `node` names a canvas node
 * (where a task is created, which tasks node a task watch covers).
 */
export const automationShape = <Ref extends Schema.Top, Node extends Schema.Top>(
  ref: Ref,
  node: Node,
) => {
  const watchMembers = [
    Schema.Struct({ kind: Schema.Literal("seat"), seat: ref, becomes: SeatBecomes }),
    Schema.Struct({
      kind: Schema.Literal("task"),
      task: Schema.Union([ref, Schema.Struct({ node })]),
      becomes: AutomationTaskState,
    }),
    Schema.Struct({ kind: Schema.Literal("artifact"), artifact: ref, event: ArtifactEvent }),
    Schema.Struct({
      kind: Schema.Literal("signal"),
      from: Schema.optionalKey(ref),
      signal: WatchedSignal,
    }),
  ] as const;
  const Watch = Schema.Union(watchMembers);

  /** A watch read as a state when the automation fires: all must hold. */
  const Condition = Schema.Union(
    [
      Schema.Struct({ ...watchMembers[0].fields, holds: Schema.Literal(true) }),
      Schema.Struct({ ...watchMembers[1].fields, holds: Schema.Literal(true) }),
      Schema.Struct({ ...watchMembers[2].fields, holds: Schema.Literal(true) }),
      Schema.Struct({ ...watchMembers[3].fields, holds: Schema.Literal(true) }),
    ],
  );

  const Trigger = Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("schedule"),
      cron: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
      timezone: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    }),
    Schema.Struct({
      kind: Schema.Literal("poll"),
      everyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(POLL_FLOOR_MS)),
    }),
    Schema.Struct({ kind: Schema.Literal("change"), on: Watch }),
    // Reserved: 0.10 refuses it with `not_available` (07).
    Schema.Struct({ kind: Schema.Literal("webhook"), endpointId: Schema.String }),
  ]);

  const Action = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("mail"), to: ref, text: Text }),
    Schema.Struct({
      kind: Schema.Literal("create-task"),
      node,
      title: Name,
      assign: Schema.optionalKey(ref),
    }),
    Schema.Struct({ kind: Schema.Literal("assign-task"), task: ref, to: ref }),
    Schema.Struct({
      kind: Schema.Literal("comment"),
      on: ref,
      anchor: Schema.optionalKey(Anchor),
      text: Text,
    }),
  ]);

  /** Everything a definition says; identity and version sit beside it. */
  const Definition = Schema.Struct({
    name: Name,
    enabled: Schema.Boolean,
    trigger: Trigger,
    when: Schema.optionalKey(
      Schema.Array(Condition).pipe(Schema.check(Schema.isMaxLength(AUTOMATION_STEPS_MAX))),
    ),
    then: Schema.Array(Action).pipe(
      Schema.check(Schema.isMinLength(1), Schema.isMaxLength(AUTOMATION_STEPS_MAX)),
    ),
    limits: AutomationLimits,
  });

  return { Trigger, Watch, Condition, Action, Definition } as const;
};

// ---------------------------------------------------------------------------
// The stored form

/** Stand-in for plan 03's `MentionRef` (`src/shared/mention.ts`, product-feed). */
export const MentionRef = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("seat"), nodeId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("task"), nodeId: Schema.String, taskId: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("artifact"),
    nodeId: Schema.String,
    artifactId: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("page"), nodeId: Schema.String }),
]);
export type MentionRef = typeof MentionRef.Type;

const stored = automationShape(MentionRef, Schema.String);

export const Trigger = stored.Trigger;
export type Trigger = typeof Trigger.Type;
export const Watch = stored.Watch;
export type Watch = typeof Watch.Type;
export const Condition = stored.Condition;
export type Condition = typeof Condition.Type;
export const Action = stored.Action;
export type Action = typeof Action.Type;

export const AutomationDefinition = stored.Definition;
export type AutomationDefinition = typeof AutomationDefinition.Type;

export const Automation = Schema.Struct({
  automationId: AutomationId,
  nodeId: Schema.String,
  ...stored.Definition.fields,
});
export type Automation = typeof Automation.Type;

// ---------------------------------------------------------------------------
// Firing history (07 "Every firing is recorded")

/** Why a firing did nothing. A cap reached skips; it never disables. */
export const SKIP_REASONS = [
  "disabled",
  "condition_unmet",
  "min_interval",
  "max_per_hour",
  "missed_slot",
  "out_of_reach",
] as const;
export const SkipReason = Schema.Literals(SKIP_REASONS);
export type SkipReason = typeof SkipReason.Type;

export const FiringCause = Schema.Literals(["trigger", "run"]);
export type FiringCause = typeof FiringCause.Type;

export const AutomationFiring = Schema.Struct({
  firingId: Schema.String,
  automationId: AutomationId,
  at: Schema.Int,
  cause: FiringCause,
  outcome: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("fired"),
      actions: Schema.Array(
        Schema.Struct({
          index: Schema.Int,
          kind: Schema.Literals(ACTION_KINDS),
          ruling: Schema.Literals(["applied", "queued", "refused"]),
          reason: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
    Schema.Struct({ kind: Schema.Literal("skipped"), reason: SkipReason }),
  ]),
});
export type AutomationFiring = typeof AutomationFiring.Type;
