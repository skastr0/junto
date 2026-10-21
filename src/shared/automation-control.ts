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
import {
  AutomationId,
  AutomationLimits,
  automationShape,
  triggerRefusal,
  type Action,
  type Automation,
  type AutomationDefinition,
  type Condition,
  type Trigger,
  type Watch,
} from "./automation";
import type { MentionKind, MentionOf, MentionRef } from "./mention";
import type { NodeId } from "./physics/schema";
import type { WorkErrorBody, WorkOpName } from "./work-control";
import { OpId } from "./work-ids";

export { OpId };

// ---------------------------------------------------------------------------
// Versions

/** The head an edit was written against; a stale one is refused `Stale`. */
export const AutomationVersion = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  Schema.brand("AutomationVersion"),
);
export type AutomationVersion = typeof AutomationVersion.Type;

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

const input = automationShape(TargetText, TargetText, NodeText);

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
// Every automation op is a work op the socket carries.
AUTOMATION_OPS satisfies ReadonlyArray<WorkOpName>;

export const AUTOMATION_WRITE_OPS = [
  "automation.create",
  "automation.edit",
  "automation.enable",
  "automation.disable",
  "automation.run",
] as const satisfies ReadonlyArray<AutomationOp>;
export type AutomationWriteOp = (typeof AUTOMATION_WRITE_OPS)[number];

export const isAutomationOp = (op: string): op is AutomationOp =>
  (AUTOMATION_OPS as ReadonlyArray<string>).includes(op);

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

/** An automation as reads return it: the stored record and the version an edit names. */
export type AutomationView = Automation & { readonly version: AutomationVersion };

/** The fields an edit replaces, resolved. */
export type AutomationEdit = Partial<Pick<AutomationDefinition, "name" | "trigger" | "when" | "then" | "limits">>;

/**
 * The automation domain's op on a `ResourceCommand` (02). The command's
 * target names the Automations node and, but for a create's own, the item.
 * Proposed for canvas's automation.ts, whose ruler rules it.
 */
export type AutomationCommandOp =
  | { readonly kind: "create"; readonly enabled: boolean; readonly definition: AutomationDefinition }
  | { readonly kind: "edit"; readonly baseVersion: AutomationVersion; readonly change: AutomationEdit }
  | { readonly kind: "enable" }
  | { readonly kind: "disable" }
  | { readonly kind: "run" };

// ---------------------------------------------------------------------------
// Pure steps main runs on a definition

/** 0.10 builds no webhook relay; its trigger is reserved and refused (07). */
export const reservedTriggerRefusal = (trigger: Trigger): WorkErrorBody | undefined =>
  triggerRefusal(trigger) === "not_available"
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

/** The mention kinds each target position takes. */
export const WANTED_KINDS = {
  seat: ["seat"],
  task: ["task"],
  artifact: ["artifact"],
  page: ["page"],
  subject: ["task", "artifact", "page"],
} as const satisfies { readonly [W in TargetWant]: ReadonlyArray<MentionKind> };

export type Wanted<W extends TargetWant> = MentionOf<(typeof WANTED_KINDS)[W][number]>;

/** The refusal for a target that resolved to the wrong kind of thing. */
export const wrongKindRefusal = (text: string, want: TargetWant, got: string, path: string): WorkErrorBody => ({
  type: "InputError",
  message: `${text} names a ${got}; this field takes ${WANTED_KINDS[want].join(" or ")}`,
  details: { path, expected: WANTED_KINDS[want], received: got, retryable: false },
});

export interface TargetResolver {
  /** Resolve target text to a mention of the wanted kind, or refuse. */
  readonly ref: (text: TargetText, want: TargetWant, path: string) => MentionRef | WorkErrorBody;
  /** Resolve a node named by id, name or ref, or refuse. */
  readonly node: (text: NodeText, path: string) => NodeId | WorkErrorBody;
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
  const ref = <W extends TargetWant>(text: TargetText, want: W, path: string): Wanted<W> => {
    const out = resolver.ref(text, want, path);
    if (isRefusal(out)) throw new Refused(out);
    if (!(WANTED_KINDS[want] as ReadonlyArray<MentionKind>).includes(out.kind)) {
      throw new Refused(wrongKindRefusal(text, want, out.kind, path));
    }
    return out as Wanted<W>;
  };
  const node = (text: NodeText, path: string): NodeId => {
    const out = resolver.node(text, path);
    if (typeof out !== "string") throw new Refused(out);
    return out;
  };

  const taskOf = (task: TargetText | { readonly node: NodeText }, at: string) =>
    typeof task === "string" ? ref(task, "task", `${at}.task`) : { node: node(task.node, `${at}.task.node`) };

  const condition = (c: ConditionInput, at: string): Condition => {
    switch (c.kind) {
      case "seat":
        return { ...c, seat: ref(c.seat, "seat", `${at}.seat`) };
      case "task":
        return { ...c, task: taskOf(c.task, at) };
    }
  };

  const watch = (w: WatchInput, at: string): Watch => {
    switch (w.kind) {
      case "seat":
        return { ...w, seat: ref(w.seat, "seat", `${at}.seat`) };
      case "task":
        return { ...w, task: taskOf(w.task, at) };
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
          : { when: parts.when.map((c, i) => condition(c, `when[${i}]`)) }),
        ...(parts.then === undefined ? {} : { then: parts.then.map((a, i) => action(a, `then[${i}]`)) }),
      },
    };
  } catch (cause) {
    if (cause instanceof Refused) return { ok: false, error: cause.error };
    throw cause;
  }
};

/** The stored definition a create rules on, with every target resolved. On or off travels beside it. */
export const definitionOf = (
  args: AutomationCreateArgs,
  resolved: Required<Pick<ResolvedParts, "trigger" | "then">> & Pick<ResolvedParts, "when">,
): AutomationDefinition => ({
  name: args.name,
  trigger: resolved.trigger,
  ...(resolved.when === undefined ? {} : { when: resolved.when }),
  then: resolved.then,
  limits: args.limits,
});
