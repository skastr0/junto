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
 * Writes are `AutomationOp`s riding remote's `resourceCommandSchema` (02):
 * an edit replaces the whole definition and is refused `stale` when its base
 * moved; a toggle carries no base, so it never goes stale. The author never
 * travels in an op. Reads are the IPC payloads at the end of this file.
 *
 * Stand-in: `Anchor` belongs to mail-threads.ts (plan 03). Until it lands it
 * is declared below, shaped exactly as the plan writes it.
 */
import { Schema } from "effect";
import { isValidCronExpression } from "./cron-expression";
import { InstallationId } from "./installation-id";
import { ARTIFACT_MAX_TITLE_LENGTH } from "./artifact";
import { ArtifactLabel, ArtifactLabels, artifactLabelsMatch } from "./artifact-labels";
import { ArtifactMention, MentionRef, PageMention, TaskMention } from "./mention";
import { NodeId } from "./physics/schema";
import { HostId } from "./remote-hosts";
import type { AutomationAuthor as ReachAuthor } from "./region-reach";
import { RefusalReason, type Refusal } from "./resource-command";
import { TASK_STATES } from "./task-model";
import { AGENT_SIGNAL_MAX_DETAIL_LENGTH, AGENT_SIGNAL_MAX_TEXT_LENGTH } from "./wire/agent-signals";
import { AUTOMATION_SIGNALS_ENABLED, CODE_STEPS_ENABLED } from "./features";
import { ContentRef } from "./wire/content-ref";
import { ItemId } from "./work-ids";

// ── Stand-in (plan 03) ─────────────────────────────────────────────────────

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

const TaskState = Schema.Literals(TASK_STATES);

// ── Ids and bounds ─────────────────────────────────────────────────────────

/** An item on its Automations node, minted by the CLI process on create (02). */
export const AutomationId = ItemId;
export type AutomationId = ItemId;

export const FiringId = ItemId;
export type FiringId = ItemId;

/** The head of an automation's definition: 1 on create, one more per edit. */
export const AutomationVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("AutomationVersion"),
);
export type AutomationVersion = typeof AutomationVersion.Type;

/** The poll floor: no automation polls more than once a minute. */
export const POLL_MIN_EVERY_MS = 60_000;
/** The highest `maxPerHour` an automation may set: a loop through a seat is caught only by limits. */
export const MAX_PER_HOUR_CEILING = 60;
export const AUTOMATION_NAME_MAX_CHARS = 120;
export const AUTOMATION_TEXT_MAX_CHARS = 8_000;
export const AUTOMATION_STEPS_MAX = 16;
/** The artifacts a raised signal shows the operator, opened from it (0.11/07 N2). */
export const AUTOMATION_SIGNAL_SHOWS_MAX = 8;
/** The most words a signal's artifact reply may be asked for. */
export const AUTOMATION_SIGNAL_MIN_WORDS_MAX = 100_000;
/** How far after its firing a work signal may fall due: a year. */
export const AUTOMATION_SIGNAL_DUE_MAX_MS = 366 * 24 * 60 * 60_000;
/** A region secret by the variable name it declares, as a process environment takes it. */
const SecretName = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)));

/** A code step's bounds (Code steps): its run time, its source as staged, and what it answers. */
export const AUTOMATION_CODE_TIMEOUT_MIN_MS = 1_000;
export const AUTOMATION_CODE_TIMEOUT_MAX_MS = 900_000;
export const AUTOMATION_CODE_TIMEOUT_DEFAULT_MS = 60_000;
export const AUTOMATION_CODE_SOURCE_MAX_BYTES = 256 * 1024;
export const AUTOMATION_CODE_OUTPUT_MAX_BYTES = 65_536;
export const AUTOMATION_CODE_FIELDS_MAX = 64;
export const AUTOMATION_CODE_VALUE_MAX_CHARS = 8_000;
export const AUTOMATION_CODE_MESSAGE_MAX_CHARS = 500;
export const AUTOMATION_CODE_TAIL_MAX_CHARS = 4_096;
/** An output field, read later as `{{code.<field>}}`. */
export const AUTOMATION_CODE_FIELD = /^[a-z][a-z0-9_]{0,63}$/;

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

export const CodeLanguage = Schema.Literals(["typescript", "shell"]);
export type CodeLanguage = typeof CodeLanguage.Type;

const CodeField = Schema.String.pipe(Schema.check(Schema.isPattern(AUTOMATION_CODE_FIELD)));
const CodeValue = Schema.Union([
  Schema.String.pipe(Schema.check(Schema.isMaxLength(AUTOMATION_CODE_VALUE_MAX_CHARS))),
  Schema.Finite,
  Schema.Boolean,
]);
/** What a code step answered with continue: each field becomes `{{code.<field>}}` for the steps after it. */
export const CodeOutput = Schema.Record(CodeField, CodeValue).pipe(
  Schema.check(Schema.makeFilter((output) => Object.keys(output).length <= AUTOMATION_CODE_FIELDS_MAX)),
);
export type CodeOutput = typeof CodeOutput.Type;

const Cron = Schema.String.pipe(Schema.check(Schema.makeFilter((cron) => isValidCronExpression(cron))));
const Timezone = Schema.String.pipe(Schema.check(Schema.makeFilter((timezone) => isKnownTimezone(timezone))));

// ── Vocabularies ───────────────────────────────────────────────────────────

/** A seat state as the runner sees it: pty's held states, never raw (seat-state-trigger.ts). */
export const SeatBecomes = Schema.Literals(["idle", "working", "attention", "gone"]);
export type SeatBecomes = typeof SeatBecomes.Type;

/** `labelled`: an artifact gains a label, created with it included; a label removed fires nothing. */
export const ArtifactEvent = Schema.Literals(["edited", "commented", "labelled"]);
export type ArtifactEvent = typeof ArtifactEvent.Type;

/** What an automation's signal asks of the operator (0.11/07): read it, or produce something. */
export const SignalKind = Schema.Literals(["notice", "work"]);
export type SignalKind = typeof SignalKind.Type;

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
    becomes: TaskState,
  };

  const Watch = Schema.Union([
    Schema.Struct(seatWatch),
    Schema.Struct(taskWatch),
    /**
     * `{node}`: any artifact in that Artifacts node, as a task watch's `{node}`
     * is any task on a board. `label`: with `labelled`, the label gained (one
     * under it counts); otherwise only an artifact carrying it.
     */
    Schema.Struct({
      kind: Schema.Literal("artifact"),
      artifact: Schema.Union([ref, Schema.Struct({ node })]),
      event: ArtifactEvent,
      label: Schema.optionalKey(ArtifactLabel),
    }),
    /**
     * Without `from`, any seat's signal: the runner matches it only from seats
     * among `automationTargets(canvas, node, author)` at fire time, never a
     * sibling region's.
     */
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
    /**
     * Reserved: decodes so the shape is fixed, refused in 0.10 (`triggerRefusal`).
     * The endpoint secret is a machine secret on the editing machine (Rule 9,
     * docs/machines.md): `ownerInstallation` names that machine, and a move of
     * editing re-mints the secret.
     */
    Schema.Struct({
      kind: Schema.Literal("webhook"),
      endpointId: Text(128),
      ownerInstallation: Schema.optionalKey(InstallationId),
    }),
  ]);

  /** An artifact an action writes: one it names, or `{fired: true}`, the artifact whose change fired it. */
  const ArtifactTarget = Schema.Union([ref, Schema.Struct({ fired: Schema.Literal(true) })]);

  const Action = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("mail"), to: ref, text: Body }),
    /** Mail delivered as a prompt (`junto msg send --prompt`): the seat is asked to act. `to` must be a seat (`actionRefusal`). */
    Schema.Struct({ kind: Schema.Literal("prompt"), to: ref, text: Body }),
    Schema.Struct({ kind: Schema.Literal("create-task"), node, title: Name, assign: Schema.optionalKey(ref) }),
    Schema.Struct({ kind: Schema.Literal("assign-task"), task: ref, to: ref }),
    Schema.Struct({ kind: Schema.Literal("comment"), on: commentable, anchor: Schema.optionalKey(Anchor), text: Body }),
    /** A document in an Artifacts node; its title and body may name values. Absent body: an empty document. */
    Schema.Struct({
      kind: Schema.Literal("create-artifact"),
      node,
      title: Name,
      body: Schema.optionalKey(Body),
      labels: Schema.optionalKey(ArtifactLabels),
    }),
    /** Text at the end of a document, as written, against the head it reads; the text may name values. */
    Schema.Struct({ kind: Schema.Literal("append-artifact"), to: ArtifactTarget, text: Body }),
    /** Labels added to and removed from an artifact's set; at least one, never one label in both. */
    Schema.Struct({
      kind: Schema.Literal("label-artifact"),
      to: ArtifactTarget,
      add: Schema.optionalKey(ArtifactLabels),
      remove: Schema.optionalKey(ArtifactLabels),
    }),
    /**
     * A program run on the automation's machine (Code steps). Its source is
     * staged content, never text in the row, so a change of code is a new
     * ref. It continues the firing with an output, stops it, or fails it;
     * a stop or a failure runs no later step.
     */
    Schema.Struct({
      kind: Schema.Literal("code"),
      language: CodeLanguage,
      source: ContentRef,
      timeoutMs: Schema.optionalKey(Bounded(AUTOMATION_CODE_TIMEOUT_MIN_MS, AUTOMATION_CODE_TIMEOUT_MAX_MS)),
    }),
    /**
     * Start or stop a seat (0.11/05 S4). On the seat's own machine it is
     * judged and done there; on another machine a `seat.control` row asks
     * that machine, held as mail is until a path exists. A closed verb on a
     * seat the operator drew — never general execution.
     */
    Schema.Struct({ kind: Schema.Literal("seat-control"), seat: ref, op: Schema.Literals(["start", "stop"]) }),
    /**
     * A signal in the needs-you feed, raised by the automation (0.11/07 N2):
     * `notice` to read and clear, `work` for the operator to produce. Its
     * title and detail may name values; `show` names artifacts it opens.
     */
    Schema.Struct({
      kind: Schema.Literal("signal"),
      signal: SignalKind,
      title: Text(AGENT_SIGNAL_MAX_TEXT_LENGTH),
      detail: Schema.optionalKey(Text(AGENT_SIGNAL_MAX_DETAIL_LENGTH)),
      show: Schema.optionalKey(Schema.Array(ref).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(AUTOMATION_SIGNAL_SHOWS_MAX)))),
      /**
       * What the operator answers in, N1's forms: text; an artifact in an
       * Artifacts node, titled from the signal unless named, with at least
       * `minWords`; a region secret by name; proof.
       */
      form: Schema.optionalKey(
        Schema.Union([
          Schema.Struct({ kind: Schema.Literal("text") }),
          Schema.Struct({
            kind: Schema.Literal("artifact"),
            node,
            // The document's title, so an artifact's length, not the signal's.
            title: Schema.optionalKey(Text(ARTIFACT_MAX_TITLE_LENGTH)),
            labels: Schema.optionalKey(ArtifactLabels),
            minWords: Schema.optionalKey(Bounded(1, AUTOMATION_SIGNAL_MIN_WORDS_MAX)),
          }),
          Schema.Struct({ kind: Schema.Literal("secret"), name: SecretName }),
          Schema.Struct({ kind: Schema.Literal("proof") }),
        ]),
      ),
      /** Work only: due this long after the firing, and whether it is urgent. */
      work: Schema.optionalKey(
        Schema.Struct({
          dueInMs: Schema.optionalKey(Bounded(1, AUTOMATION_SIGNAL_DUE_MAX_MS)),
          urgent: Schema.optionalKey(Schema.Boolean),
        }),
      ),
    }),
  ]);

  /**
   * Everything an edit replaces. Identity, author, version and `enabled` sit
   * beside it: on and off is its own baseless op, so no edit can re-enable
   * an automation someone just turned off.
   */
  const Definition = Schema.Struct({
    name: Name,
    trigger: Trigger,
    when: Schema.optionalKey(Schema.Array(Condition).pipe(Schema.check(Schema.isMaxLength(AUTOMATION_STEPS_MAX)))),
    then: Schema.Array(Action).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(AUTOMATION_STEPS_MAX))),
    limits: AutomationLimits,
  });

  return { Watch, Condition, Trigger, ArtifactTarget, Action, Definition } as const;
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
export const ArtifactTarget = stored.ArtifactTarget;
export type ArtifactTarget = typeof ArtifactTarget.Type;
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

/** Who wrote an automation's code, and which installation ruled it. Absent `installation`: a ruler that named none, whose code no machine runs. */
export const CodeRuling = Schema.Struct({
  author: AutomationAuthor,
  installation: Schema.optionalKey(InstallationId),
});
export type CodeRuling = typeof CodeRuling.Type;

// The stored author is exactly what `automationTargets` takes, both ways.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const authorIsReachAuthor: Same<AutomationAuthor, ReachAuthor> = true;
void authorIsReachAuthor;

export const Automation = Schema.Struct({
  automationId: AutomationId,
  nodeId: NodeId,
  author: AutomationAuthor,
  version: AutomationVersion,
  enabled: Schema.Boolean,
  /**
   * The machine that runs it, by its real short name, as a seat names its
   * machine (machines.md Rule 3): it fires the schedules, hears the changes and
   * performs the actions. Beside the definition, like `enabled`: a move is its
   * own op. Absent on an automation from before 0.11, which runs on the
   * canvas's editing machine (`runsOn`).
   */
  machine: Schema.optionalKey(HostId),
  /**
   * The ruling that last set a code step's source (security doctrine, Code
   * steps, check 3): its actor and the installation that ruled it, stamped by
   * the ruler, never taken from the op. An edit that leaves the code alone
   * keeps it; absent with no code step.
   */
  codeRuling: Schema.optionalKey(CodeRuling),
  ...stored.Definition.fields,
});
export type Automation = typeof Automation.Type;
export type AutomationWire = typeof Automation.Encoded;

export const decodeAutomation = Schema.decodeUnknownResult(Automation, { onExcessProperty: "error" });

// ── Writes ─────────────────────────────────────────────────────────────────

/**
 * The automation domain's ops, the `op` of a `ResourceCommand` whose target
 * is `{ kind: "automation", nodeId, itemId }`. Closed: a new verb is a new
 * member, and every ruling match breaks until it is handled.
 *
 * - `create` mints the item at version 1, on or off; main sets the author
 *   from the ruled actor.
 * - `edit` replaces the whole definition and never touches `enabled`; a moved
 *   head refuses it `stale` with `expected` the head.
 * - `set-enabled` carries no base: a toggle never goes stale, and never makes
 *   an edit stale.
 * - `set-machine` moves it to another machine, baseless like `set-enabled`.
 * - `run` is `junto automation run`: one firing now, recorded with cause run.
 */
export const AutomationOp = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("create"),
    automationId: AutomationId,
    enabled: Schema.Boolean,
    /** Absent: the machine that rules the create, the canvas's editing machine. */
    machine: Schema.optionalKey(HostId),
    definition: AutomationDefinition,
  }),
  Schema.Struct({ kind: Schema.Literal("edit"), baseVersion: AutomationVersion, definition: AutomationDefinition }),
  Schema.Struct({ kind: Schema.Literal("set-enabled"), enabled: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("set-machine"), machine: HostId }),
  Schema.Struct({ kind: Schema.Literal("archive") }),
  Schema.Struct({ kind: Schema.Literal("run") }),
]);
export type AutomationOp = typeof AutomationOp.Type;

/**
 * The machine an automation runs on: the one it names, or for one from
 * before 0.11 that names none, the canvas's editing machine.
 */
export const runsOn = (automation: Pick<Automation, "machine">, editingMachine: HostId): HostId =>
  automation.machine ?? editingMachine;
export type AutomationOpKind = AutomationOp["kind"];

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
      return ["kind" in watch.artifact ? watch.artifact.nodeId : watch.artifact.node];
    case "signal":
      return watch.from === undefined ? [] : [watch.from.nodeId];
    default:
      return watch satisfies never;
  }
};

const actionNodes = (action: Action): ReadonlyArray<NodeId> => {
  switch (action.kind) {
    case "mail":
    case "prompt":
      return [action.to.nodeId];
    case "create-task":
      return action.assign === undefined ? [action.node] : [action.node, action.assign.nodeId];
    case "assign-task":
      return [action.task.nodeId, action.to.nodeId];
    case "seat-control":
      return [action.seat.nodeId];
    case "signal":
      return [...(action.show ?? []).map((shown) => shown.nodeId), ...(action.form?.kind === "artifact" ? [action.form.node] : [])];
    case "comment":
      return [action.on.nodeId];
    case "create-artifact":
      return [action.node];
    case "append-artifact":
    case "label-artifact":
      return "fired" in action.to ? [] : [action.to.nodeId];
    case "code":
      return [];
    default:
      return action satisfies never;
  }
};

/**
 * Every node the automation names, once, for the fire-time reach recheck. A
 * signal watch without `from` names none: the runner checks the signalling
 * seat itself against the same targets.
 * each must be among `automationTargets(canvas, automation.nodeId, automation.author)`.
 */
export const targetNodeIds = (automation: Automation): ReadonlyArray<NodeId> => {
  const ids = new Set<NodeId>();
  if (automation.trigger.kind === "change") for (const id of watchNodes(automation.trigger.on)) ids.add(id);
  for (const condition of automation.when ?? []) for (const id of watchNodes(condition)) ids.add(id);
  for (const action of automation.then) for (const id of actionNodes(action)) ids.add(id);
  return [...ids];
};

/**
 * What one action may not say, refused when the automation is saved: a
 * prompt to anything but a seat, an artifact write to anything but an
 * artifact, a label change that changes nothing or names one label both ways.
 */
/**
 * Whether this build saves, offers and performs an action kind: code steps
 * and the signal action ship off until their real-app walks pass (0.11).
 */
export const actionKindInBuild = (kind: ActionKind): boolean =>
  kind === "code" ? CODE_STEPS_ENABLED : kind === "signal" ? AUTOMATION_SIGNALS_ENABLED : true;

/** Why this build refuses an action kind, worded for whoever saved it. */
export const ACTION_KIND_OFF: Readonly<Partial<Record<ActionKind, Refusal>>> = {
  code: {
    reason: "not_available",
    message: "code steps are off in this build",
    next_step: "Remove the code step to save; a build with code steps on runs it",
  },
  signal: {
    reason: "not_available",
    message: "signals from automations are off in this build",
    next_step: "Remove the signal step to save, or mail the seat that should raise it",
  },
};

/** The build's refusal of an action kind it does not carry, if it does not. */
export const actionKindRefusal = (kind: ActionKind): Refusal | undefined =>
  actionKindInBuild(kind) ? undefined : ACTION_KIND_OFF[kind];

export const actionRefusal = (action: Action): Refusal | undefined => {
  switch (action.kind) {
    case "prompt":
      return action.to.kind === "seat"
        ? undefined
        : { reason: "invalid_input", message: "a prompt goes to a seat", next_step: "Name a seat as the prompt's to, or send mail instead" };
    case "seat-control":
      return action.seat.kind === "seat"
        ? undefined
        : { reason: "invalid_input", message: "a seat-control names a seat", next_step: "Name an agent seat as the seat" };
    case "signal":
      if (!(action.show ?? []).every((shown) => shown.kind === "artifact")) {
        return { reason: "invalid_input", message: "a signal shows artifacts", next_step: "Name only artifacts for the signal to show" };
      }
      if (action.signal === "work") return undefined;
      // A notice is read and cleared: nothing answers a form, nothing falls due.
      if (action.form !== undefined) {
        return { reason: "invalid_input", message: "only a work signal asks for an answer", next_step: "Make it a work signal, or drop its form" };
      }
      return action.work !== undefined
        ? { reason: "invalid_input", message: "only a work signal falls due", next_step: "Make it a work signal, or drop its due time" }
        : undefined;
    case "append-artifact":
    case "label-artifact": {
      if (!("fired" in action.to) && action.to.kind !== "artifact") {
        return { reason: "invalid_input", message: `${action.kind} writes to an artifact`, next_step: "Name an artifact, or the artifact that fired" };
      }
      if (action.kind === "append-artifact") return undefined;
      const add = action.add ?? [];
      const remove = action.remove ?? [];
      if (add.length === 0 && remove.length === 0) {
        return { reason: "invalid_input", message: "label-artifact adds or removes at least one label" };
      }
      const both = add.find((label) => remove.includes(label));
      return both === undefined
        ? undefined
        : { reason: "invalid_input", message: `label ${both} is both added and removed`, next_step: "Name each label once, to add or to remove" };
    }
    default:
      return undefined;
  }
};

/** `{fired: true}` names the artifact whose change fired the automation, so only an artifact trigger carries one. */
export const firedTargetRefusal = (definition: Pick<AutomationDefinition, "trigger" | "then">): Refusal | undefined => {
  const artifactTrigger = definition.trigger.kind === "change" && definition.trigger.on.kind === "artifact";
  const firedWrite = definition.then.some(
    (action) => (action.kind === "append-artifact" || action.kind === "label-artifact") && "fired" in action.to,
  );
  return firedWrite && !artifactTrigger
    ? {
        reason: "invalid_input",
        message: "only an artifact trigger has an artifact that fired",
        next_step: "Name the artifact to write, or trigger on an artifact",
      }
    : undefined;
};

/** Whether an artifact's labels pass a watch's label: carried for an edit or a comment, gained for `labelled`. */
export const artifactWatchLabelMatches = (
  watch: Extract<Watch, { readonly kind: "artifact" }>,
  labels: ReadonlyArray<ArtifactLabel>,
  gained: ReadonlyArray<ArtifactLabel>,
): boolean => {
  if (watch.event === "labelled") return watch.label === undefined ? gained.length > 0 : artifactLabelsMatch(gained, [watch.label]);
  return watch.label === undefined || artifactLabelsMatch(labels, [watch.label]);
};

// ── Values ─────────────────────────────────────────────────────────────────

/**
 * What an action's text may name of the thing that fired it, written
 * `{{task.title}}` (0.11/05). Closed, and each trigger carries its own:
 * `fired.at` every trigger, the rest a change trigger of that kind. Main
 * resolves them at firing time; a value is inserted as text and never read
 * again, so a title holding `{{x}}` stays `{{x}}`.
 */
export const AUTOMATION_VALUES = {
  task: ["task.title", "task.state", "task.link", "task.assignee", "board.title"],
  artifact: ["artifact.title", "artifact.link", "artifact.labels", "artifacts.title"],
  seat: ["seat.name", "seat.state"],
  signal: ["signal.kind", "signal.from", "signal.text"],
  every: ["fired.at"],
} as const;

export const AutomationValue = Schema.Literals([
  ...AUTOMATION_VALUES.task,
  ...AUTOMATION_VALUES.artifact,
  ...AUTOMATION_VALUES.seat,
  ...AUTOMATION_VALUES.signal,
  ...AUTOMATION_VALUES.every,
]);
export type AutomationValue = typeof AutomationValue.Type;

/** What `automationValuesOf` reads of a trigger, so a stored trigger and an editor draft both pass. */
export type TriggerForValues =
  | { readonly kind: "change"; readonly on: { readonly kind: Watch["kind"] } }
  | { readonly kind: "schedule" | "poll" | "webhook" };

/** The values a trigger carries, in the order an Insert value list shows them. */
export const automationValuesOf = <T extends TriggerForValues>(trigger: T): ReadonlyArray<AutomationValue> =>
  trigger.kind === "change" ? [...AUTOMATION_VALUES[trigger.on.kind], ...AUTOMATION_VALUES.every] : AUTOMATION_VALUES.every;

/** `{{word.word}}`, or `{{code.<field>}}`, no spaces: anything else in braces is plain text. */
const VALUE_TOKEN = /\{\{([a-z]+\.[a-z][a-z0-9_]*)\}\}/g;

/** An earlier code step's output field, as an action's text names it. */
export type CodeValueName = `code.${string}`;
export const isCodeValueName = (name: string): name is CodeValueName =>
  name.startsWith("code.") && AUTOMATION_CODE_FIELD.test(name.slice("code.".length));

/** Every name a value token may say: the trigger's values and the code steps' fields. */
export type ValueName = AutomationValue | CodeValueName;
const isValueName = (name: string): name is ValueName => Schema.is(AutomationValue)(name) || isCodeValueName(name);

/** Each value name a text writes, in order, repeats kept. */
export const valueNamesIn = (text: string): ReadonlyArray<string> => [...text.matchAll(VALUE_TOKEN)].map((match) => match[1]!);

/** Each value token replaced by what `valueOf` says, in one pass, so a resolved value is never read again. */
export const resolveValues = (text: string, valueOf: (name: ValueName) => string): string =>
  text.replace(VALUE_TOKEN, (token, name: string) => (isValueName(name) ? valueOf(name) : token));

/** The text of an action that may name values, if it has one: a new task's title, or what it writes. */
export const actionText = (action: Action): string | undefined => {
  switch (action.kind) {
    case "mail":
    case "prompt":
    case "comment":
      return action.text;
    case "create-task":
      return action.title;
    case "append-artifact":
      return action.text;
    case "create-artifact":
      return action.body === undefined ? action.title : `${action.title}\n${action.body}`;
    case "signal": {
      const formTitle = action.form?.kind === "artifact" ? action.form.title : undefined;
      return [action.title, action.detail, formTitle].filter((text) => text !== undefined).join("\n");
    }
    case "assign-task":
    case "label-artifact":
    case "code":
    case "seat-control":
      return undefined;
    default:
      return action satisfies never;
  }
};

/**
 * A value an action names that its trigger does not carry, refused when the
 * automation is saved. `{{code.<field>}}` is carried after a code step: what
 * fields it answers is the program's, so a field it never answered stays as
 * written at firing time.
 */
export const valueRefusal = (definition: Pick<AutomationDefinition, "trigger" | "then">): Refusal | undefined => {
  const carried: ReadonlyArray<string> = automationValuesOf(definition.trigger);
  let afterCode = false;
  for (const action of definition.then) {
    const missing = valueNamesIn(actionText(action) ?? "").find((name) => !carried.includes(name) && !(afterCode && isCodeValueName(name)));
    if (action.kind === "code") afterCode = true;
    if (missing !== undefined && isCodeValueName(missing)) {
      return {
        reason: "invalid_input",
        message: `no code step before this one answers {{${missing}}}`,
        next_step: "Put a code step before it, or name only the values its trigger carries",
      };
    }
    if (missing !== undefined) {
      return {
        reason: "invalid_input",
        message: `this trigger carries no {{${missing}}}`,
        next_step: `Name only the values it carries: ${carried.map((name) => `{{${name}}}`).join(", ")}`,
      };
    }
  }
  return undefined;
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

const StepIndex = Bounded(0, AUTOMATION_STEPS_MAX - 1);

/**
 * One action's ruling, by its index in `then`. `queued` waits on the editing
 * machine (02). A code step that ran is `continued` with its output,
 * `stopped`, or `failed`: `timeout`, `too_large`, `output_carries_secret`
 * or the program's own words. On a failure `logTail` is the end of what it
 * wrote, stdout and stderr together, scrubbed of secrets. A code step
 * not admitted to run is `refused` (`not_permitted`, `not_available`).
 */
export const ActionRuling = Schema.Union([
  Schema.Struct({ index: StepIndex, ruling: Schema.Literal("applied") }),
  Schema.Struct({ index: StepIndex, ruling: Schema.Literal("queued") }),
  Schema.Struct({
    index: StepIndex,
    ruling: Schema.Literal("refused"),
    reason: RefusalReason,
    /** The machine the automation moved to while this firing was in flight: its later actions are that machine's. */
    movedTo: Schema.optionalKey(HostId),
  }),
  Schema.Struct({ index: StepIndex, ruling: Schema.Literal("continued"), output: CodeOutput, durationMs: Count }),
  Schema.Struct({
    index: StepIndex,
    ruling: Schema.Literal("stopped"),
    reason: Schema.optionalKey(Text(AUTOMATION_CODE_MESSAGE_MAX_CHARS)),
    durationMs: Count,
  }),
  Schema.Struct({
    index: StepIndex,
    ruling: Schema.Literal("failed"),
    message: Text(AUTOMATION_CODE_MESSAGE_MAX_CHARS),
    exitCode: Schema.optionalKey(Schema.Int),
    logTail: Schema.optionalKey(Text(AUTOMATION_CODE_TAIL_MAX_CHARS)),
    durationMs: Count,
  }),
]);
export type ActionRuling = typeof ActionRuling.Type;

/**
 * `claimed`: the runner holds the firing and is performing its actions. It
 * becomes `fired` once they are ruled. A claimed firing that is no longer in
 * flight was interrupted (a crash between claim and settle): its actions may
 * have run, so it counts as fired for the limits, and history shows it as
 * interrupted.
 */
export const FiringOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("claimed") }),
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
 * fired, claimed firings included (skips do not count). Undefined when both limits allow it. A firing
 * later than `now` (the clock stepped back) skips `min_interval` until the
 * clock catches up: intended, so a clock change never bursts.
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

// ── Reads (IPC) ────────────────────────────────────────────────────────────

/** The most firings one page returns. */
export const FIRINGS_PAGE_MAX = 100;

/** Every automation on one Automations node. */
export const AutomationListRequest = Schema.Struct({ nodeId: NodeId });
export type AutomationListRequest = typeof AutomationListRequest.Type;
/**
 * What an automation's newest firing came to, for the card: `failed` is a
 * firing that ran and had an action refused or a code step fail. Skipped (a
 * limit) is not failed, and neither is a code step that stopped it.
 */
export const LAST_OUTCOMES = ["claimed", "fired", "failed", "skipped"] as const;
export const LastOutcome = Schema.Literals(LAST_OUTCOMES);
export type LastOutcome = typeof LastOutcome.Type;

export const lastOutcomeOf = (outcome: FiringOutcome): LastOutcome =>
  outcome.kind === "fired" && outcome.actions.some((action) => action.ruling === "refused" || action.ruling === "failed")
    ? "failed"
    : outcome.kind;

/** `lastOutcomes` is keyed by automation id; an automation that never fired has no key. */
export const AutomationListResponse = Schema.Struct({
  automations: Schema.Array(Automation),
  lastOutcomes: Schema.optionalKey(Schema.Record(Schema.String, LastOutcome)),
});
export type AutomationListResponse = typeof AutomationListResponse.Type;

/**
 * One automation's firings, newest first. `before` pages back: only firings
 * older than that one. Without `limit` a page is FIRINGS_PAGE_MAX.
 */
export const AutomationFiringsRequest = Schema.Struct({
  automationId: AutomationId,
  before: Schema.optionalKey(FiringId),
  limit: Schema.optionalKey(Bounded(1, FIRINGS_PAGE_MAX)),
});
export type AutomationFiringsRequest = typeof AutomationFiringsRequest.Type;
export const AutomationFiringsResponse = Schema.Struct({
  firings: Schema.Array(Firing).pipe(Schema.check(Schema.isMaxLength(FIRINGS_PAGE_MAX))),
});
export type AutomationFiringsResponse = typeof AutomationFiringsResponse.Type;

// ── Writes (IPC) ───────────────────────────────────────────────────────────

/** One op on one automation, from the operator's pane. `create` names its own id; every other op targets `automationId`. */
export const AutomationApplyRequest = Schema.Struct({ nodeId: NodeId, automationId: AutomationId, op: AutomationOp });
export type AutomationApplyRequest = typeof AutomationApplyRequest.Type;

/** Applied (the head it left, absent once archived) or refused with its reason; never queued (apply.ts). */
export type AutomationApplyResponse =
  | { readonly kind: "applied"; readonly automation?: Automation }
  | { readonly kind: "refused"; readonly refusal: Refusal };

/**
 * A code step's program put in the content store: the editor puts it on save,
 * then saves the automation naming the ref. Text, never a path.
 */
export const AutomationCodePutRequest = Schema.Struct({
  text: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.makeFilter((text) => new TextEncoder().encode(text).byteLength <= AUTOMATION_CODE_SOURCE_MAX_BYTES)),
  ),
});
export type AutomationCodePutRequest = typeof AutomationCodePutRequest.Type;
export type AutomationCodePutResponse =
  | { readonly kind: "put"; readonly ref: ContentRef }
  | { readonly kind: "refused"; readonly refusal: Refusal };

/** A code step's program read back as text, from this machine's content store. */
export const AutomationCodeReadRequest = Schema.Struct({ ref: ContentRef });
export type AutomationCodeReadRequest = typeof AutomationCodeReadRequest.Type;
export type AutomationCodeReadResponse =
  | { readonly kind: "read"; readonly text: string }
  | { readonly kind: "refused"; readonly refusal: Refusal };

/** Sent to every window after a committed change to a node's automations. */
export type AutomationsChanged = { readonly canvasName: string; readonly nodeId: NodeId };
