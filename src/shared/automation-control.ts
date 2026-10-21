/**
 * `junto automation` wire contract (plan 07, cli track L4): the input each
 * verb takes, the result it returns, and the pure steps main runs on a
 * definition before it becomes a resource command.
 *
 * A seat writes targets as text: `@name`, `#42` or a `junto://` ref. Main
 * resolves each through one resolver into the stored form, so the CLI stays a
 * thin socket client and never decides what a name means. Pure: effect only.
 */
import { Schema } from "effect";
import type { WorkErrorBody } from "./work-control";
import {
  AutomationId,
  AutomationLimits,
  AutomationVersion,
  automationShape,
  type Action,
  type AutomationDefinition,
  type Condition,
  type MentionRef,
  type Trigger,
  type Watch,
} from "./automation-standin";

// ---------------------------------------------------------------------------
// Ids

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Stand-in for cli-protocol's opId (L1): a bare ULID minted by the CLI
 * process, resent with `--op-id` on a retry so the command applies once.
 */
export const OpId = Schema.String.pipe(Schema.check(Schema.isPattern(ULID)), Schema.brand("OpId"));
export type OpId = typeof OpId.Type;

// ---------------------------------------------------------------------------
// Target text

/** A seat, task, artifact or page as a seat writes it. */
export const TargetText = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(4_096),
    Schema.isPattern(/^(@\S.*|#\S+|junto:\/\/\S+)$/u),
  ),
).annotate({
  description: "@name, #<task number>, or a junto:// ref",
});
export type TargetText = typeof TargetText.Type;

/** A canvas node as a seat writes it: its id, its name, or a `junto://` ref. */
export const NodeText = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
);
export type NodeText = typeof NodeText.Type;

const input = automationShape(TargetText, NodeText);

export const TriggerInput = input.Trigger;
export type TriggerInput = typeof TriggerInput.Type;
export const WatchInput = input.Watch;
export type WatchInput = typeof WatchInput.Type;
export const ConditionInput = input.Condition;
export type ConditionInput = typeof ConditionInput.Type;
export const ActionInput = input.Action;
export type ActionInput = typeof ActionInput.Type;
export const DefinitionInput = input.Definition;
export type DefinitionInput = typeof DefinitionInput.Type;

/** Applied when a create names none. */
export const DEFAULT_AUTOMATION_LIMITS: AutomationLimits = {
  minIntervalMs: 60_000,
  maxPerHour: 12,
};

// ---------------------------------------------------------------------------
// Verb inputs. `*CliArgs` is what a seat writes; the bare name is the wire,
// where the CLI has filled in the ids it mints.

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** The Automations node: its id, its name, or a `junto://` ref. */
const AutomationsNode = NodeText.annotate({
  description: "The Automations node: its id, its name, or a junto:// ref",
});
/** One automation on that node: its id or its exact name. */
const AutomationName = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
).annotate({ description: "The automation's id or its exact name" });

export const AutomationListArgs = Schema.Struct({
  target: Schema.optionalKey(AutomationsNode),
}).annotate(strict);
export type AutomationListArgs = typeof AutomationListArgs.Type;

export const AutomationShowArgs = Schema.Struct({
  target: AutomationsNode,
  automation: AutomationName,
}).annotate(strict);
export type AutomationShowArgs = typeof AutomationShowArgs.Type;

const createFields = {
  target: AutomationsNode,
  name: DefinitionInput.fields.name,
  trigger: DefinitionInput.fields.trigger,
  when: DefinitionInput.fields.when,
  then: DefinitionInput.fields.then,
};

export const AutomationCreateCliArgs = Schema.Struct({
  ...createFields,
  enabled: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Created off unless true; `junto automation enable` turns it on",
  }),
  limits: Schema.optionalKey(AutomationLimits),
}).annotate(strict);
export type AutomationCreateCliArgs = typeof AutomationCreateCliArgs.Type;

export const AutomationCreateArgs = Schema.Struct({
  ...createFields,
  opId: OpId,
  automationId: AutomationId,
  enabled: Schema.Boolean,
  limits: AutomationLimits,
}).annotate(strict);
export type AutomationCreateArgs = typeof AutomationCreateArgs.Type;

/** Each field present replaces the stored one; `when: []` clears the conditions. */
export const AutomationChange = Schema.Struct({
  name: Schema.optionalKey(DefinitionInput.fields.name),
  trigger: Schema.optionalKey(DefinitionInput.fields.trigger),
  when: DefinitionInput.fields.when,
  then: Schema.optionalKey(DefinitionInput.fields.then),
  limits: Schema.optionalKey(AutomationLimits),
}).annotate(strict);
export type AutomationChange = typeof AutomationChange.Type;

const editFields = {
  target: AutomationsNode,
  automation: AutomationName,
  baseVersion: AutomationVersion.annotate({
    description: "The version this edit was written against, from show; a stale one is refused",
  }),
  change: AutomationChange,
};

export const AutomationEditCliArgs = Schema.Struct(editFields).annotate(strict);
export type AutomationEditCliArgs = typeof AutomationEditCliArgs.Type;

export const AutomationEditArgs = Schema.Struct({ ...editFields, opId: OpId }).annotate(strict);
export type AutomationEditArgs = typeof AutomationEditArgs.Type;

const oneFields = { target: AutomationsNode, automation: AutomationName };

/** enable, disable and run name one automation. */
export const AutomationOneCliArgs = Schema.Struct(oneFields).annotate(strict);
export type AutomationOneCliArgs = typeof AutomationOneCliArgs.Type;

export const AutomationOneArgs = Schema.Struct({ ...oneFields, opId: OpId }).annotate(strict);
export type AutomationOneArgs = typeof AutomationOneArgs.Type;

export const AUTOMATION_HISTORY_LIMIT_MAX = 200;

export const AutomationHistoryArgs = Schema.Struct({
  target: AutomationsNode,
  automation: Schema.optionalKey(AutomationName),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: AUTOMATION_HISTORY_LIMIT_MAX })),
  ),
  /** A firingId from an earlier page: lists firings older than it. */
  before: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMinLength(1)))),
}).annotate(strict);
export type AutomationHistoryArgs = typeof AutomationHistoryArgs.Type;

// ---------------------------------------------------------------------------
// Ops and results

export const AUTOMATION_OPS = [
  "automation.list",
  "automation.show",
  "automation.create",
  "automation.edit",
  "automation.enable",
  "automation.disable",
  "automation.run",
  "automation.history",
] as const;
export type AutomationOp = (typeof AUTOMATION_OPS)[number];

export const AUTOMATION_WRITE_OPS = [
  "automation.create",
  "automation.edit",
  "automation.enable",
  "automation.disable",
  "automation.run",
] as const satisfies ReadonlyArray<AutomationOp>;
export type AutomationWriteOp = (typeof AUTOMATION_WRITE_OPS)[number];

export const isAutomationWriteOp = (op: string): op is AutomationWriteOp =>
  (AUTOMATION_WRITE_OPS as ReadonlyArray<string>).includes(op);

/**
 * How a write ended. `applied`: the editing machine ruled it and the new
 * version is readable here. `queued`: the editing machine is away; the
 * command waits and `junto op show <opId>` reads its ruling later. A refusal
 * is never a result: it comes back as the typed error.
 */
export type AutomationWriteResult =
  | {
      readonly disposition: "applied";
      readonly opId: OpId;
      readonly automationId: AutomationId;
      readonly version: AutomationVersion;
    }
  | {
      readonly disposition: "queued";
      readonly opId: OpId;
      readonly automationId: AutomationId;
    };

export type AutomationDisposition = AutomationWriteResult["disposition"];

// ---------------------------------------------------------------------------
// Pure steps main runs on a definition

/** 0.10 builds no webhook relay; its trigger is reserved and refused (07). */
export const reservedTriggerRefusal = (trigger: TriggerInput): WorkErrorBody | undefined =>
  trigger.kind === "webhook"
    ? {
        type: "InputError",
        message: "webhook triggers are designed for and not built in this Junto release",
        details: {
          path: "trigger.kind",
          reason: "not_available",
          received: "webhook",
          retryable: false,
          next_step: "use a schedule, poll or change trigger",
        },
      }
    : undefined;

/** What a target position must resolve to. */
export type TargetWant =
  | "seat"
  | "task"
  | "artifact"
  | "page"
  /** A comment's subject: a task, an artifact or a page. */
  | "subject";

export interface TargetResolver {
  /** Resolve target text to a mention of the wanted kind, or refuse. */
  readonly ref: (text: TargetText, want: TargetWant, path: string) => MentionRef | WorkErrorBody;
  /** Resolve a node named by id, name or ref, or refuse. */
  readonly node: (text: NodeText, path: string) => string | WorkErrorBody;
}

class Refused {
  constructor(readonly error: WorkErrorBody) {}
}

const isRefusal = (value: unknown): value is WorkErrorBody =>
  typeof value === "object" && value !== null && "type" in value && "message" in value;

/** The trigger, conditions and actions with every target resolved. */
export interface ResolvedParts {
  readonly trigger?: Trigger;
  readonly when?: ReadonlyArray<Condition>;
  readonly then?: ReadonlyArray<Action>;
}

/**
 * Resolve every target in a trigger, its conditions and its actions. The
 * first refusal wins and names its path, so a seat fixes one field at a time.
 */
export const resolveTargets = (
  parts: {
    readonly trigger?: TriggerInput;
    readonly when?: ReadonlyArray<ConditionInput>;
    readonly then?: ReadonlyArray<ActionInput>;
  },
  resolver: TargetResolver,
): { readonly ok: true; readonly value: ResolvedParts } | { readonly ok: false; readonly error: WorkErrorBody } => {
  const ref = (text: TargetText, want: TargetWant, path: string): MentionRef => {
    const out = resolver.ref(text, want, path);
    if (isRefusal(out)) throw new Refused(out);
    return out;
  };
  const node = (text: NodeText, path: string): string => {
    const out = resolver.node(text, path);
    if (typeof out !== "string") throw new Refused(out);
    return out;
  };

  const watch = (w: WatchInput, at: string): Watch => {
    switch (w.kind) {
      case "seat":
        return { ...w, seat: ref(w.seat, "seat", `${at}.seat`) };
      case "task":
        return {
          ...w,
          task: typeof w.task === "string"
            ? ref(w.task, "task", `${at}.task`)
            : { node: node(w.task.node, `${at}.task.node`) },
        };
      case "artifact":
        return { ...w, artifact: ref(w.artifact, "artifact", `${at}.artifact`) };
      case "signal": {
        const { from, ...rest } = w;
        return from === undefined ? rest : { ...rest, from: ref(from, "seat", `${at}.from`) };
      }
    }
  };

  const trigger = (t: TriggerInput): Trigger =>
    t.kind === "change" ? { ...t, on: watch(t.on, "trigger.on") } : t;

  const action = (a: ActionInput, at: string): Action => {
    switch (a.kind) {
      case "mail":
        return { ...a, to: ref(a.to, "seat", `${at}.to`) };
      case "create-task": {
        const { assign, ...rest } = a;
        const created = { ...rest, node: node(a.node, `${at}.node`) };
        return assign === undefined ? created : { ...created, assign: ref(assign, "seat", `${at}.assign`) };
      }
      case "assign-task":
        return { ...a, task: ref(a.task, "task", `${at}.task`), to: ref(a.to, "seat", `${at}.to`) };
      case "comment":
        return { ...a, on: ref(a.on, "subject", `${at}.on`) };
    }
  };

  try {
    return {
      ok: true,
      value: {
        ...(parts.trigger === undefined ? {} : { trigger: trigger(parts.trigger) }),
        ...(parts.when === undefined
          ? {}
          : { when: parts.when.map((c, i) => ({ ...watch(c, `when[${i}]`), holds: true as const }) as Condition) }),
        ...(parts.then === undefined ? {} : { then: parts.then.map((a, i) => action(a, `then[${i}]`)) }),
      },
    };
  } catch (cause) {
    if (cause instanceof Refused) return { ok: false, error: cause.error };
    throw cause;
  }
};

/** The stored definition a create rules on, with every target resolved. */
export const definitionOf = (
  args: AutomationCreateArgs,
  resolved: Required<Pick<ResolvedParts, "trigger" | "then">> & Pick<ResolvedParts, "when">,
): AutomationDefinition => ({
  name: args.name,
  enabled: args.enabled,
  trigger: resolved.trigger,
  ...(resolved.when === undefined ? {} : { when: resolved.when }),
  then: resolved.then,
  limits: args.limits,
});
