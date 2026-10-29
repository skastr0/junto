/**
 * The automation resource domain (02, 07): `rule` and `apply` over the
 * automation contract, for the ruler on the editing machine and the pending
 * overlay on the writing machine. Every write invariant lives here; storage,
 * transport and firing are the caller's.
 *
 * - Only the operator and overseers write automations, as with the canvas
 *   (operator ruling, plan 07); every other seat reads only. An automation
 *   never writes automations, so none can make or change another (loop
 *   safety). The author is the ruled actor, never written.
 * - A definition may name only nodes among `automationTargets` for its node
 *   and author, checked here at write time and again at fire time. An
 *   overseer's edit must also fit its own targets, so no edit widens anyone.
 * - An edit replaces the whole definition against its base; a moved head
 *   refuses it `stale` with the head. It never touches `enabled`: a toggle
 *   carries no base and is the only way on or off.
 * - 0.10 refuses webhook triggers `not_available`.
 */
import { Schema } from "effect";
import {
  Automation,
  stepIdRefusal,
  type AutomationAuthor,
  AutomationDefinition,
  CodeRuling,
  AutomationId,
  type AutomationOp,
  AutomationVersion,
  targetNodeIds,
  triggerRefusal,
  actionKindRefusal,
  actionRefusal,
  firedTargetRefusal,
  valueRefusal,
} from "./automation";
import { NodeId } from "./physics/schema";
import { HostId } from "./remote-hosts";
import type { InstallationId } from "./installation-id";
import type { DomainVerdict, Refusal, ResourceActor, ResourceCommand, ResourceDomain } from "./resource-command";

/** One automation as the ruler holds it. */
export interface AutomationEntry {
  readonly automation: Automation;
  readonly archived: boolean;
  readonly updatedAt: number;
}

export type AutomationState = ReadonlyMap<AutomationId, AutomationEntry>;

export const emptyAutomationState = (): AutomationState => new Map();

export const FIRST_AUTOMATION_VERSION = AutomationVersion.make(1);

// ── Facts ──────────────────────────────────────────────────────────────────

const At = Schema.Number;

export const AutomationFact = Schema.Union([
  Schema.Struct({ fact: Schema.Literal("automation.created"), automation: Automation, at: At }),
  Schema.Struct({
    fact: Schema.Literal("automation.edited"),
    automationId: AutomationId,
    version: AutomationVersion,
    definition: AutomationDefinition,
    /** The ruling its code stands on after this edit (`codeRulingAfter`); absent when it has no code step. */
    codeRuling: Schema.optionalKey(CodeRuling),
    at: At,
  }),
  Schema.Struct({ fact: Schema.Literal("automation.enabled"), automationId: AutomationId, enabled: Schema.Boolean, at: At }),
  Schema.Struct({ fact: Schema.Literal("automation.moved"), automationId: AutomationId, machine: HostId, at: At }),
  Schema.Struct({ fact: Schema.Literal("automation.archived"), automationId: AutomationId, at: At }),
  /** `junto automation run`: the runner records one firing with cause `run`. */
  Schema.Struct({ fact: Schema.Literal("automation.run"), automationId: AutomationId, nodeId: NodeId, at: At }),
]);
export type AutomationFact = typeof AutomationFact.Type;

// ── Rule ───────────────────────────────────────────────────────────────────

/**
 * The nodes a definition on `nodeId` by `author` may name: region-reach's
 * `automationTargets` over the ruling canvas, as ids.
 */
export type TargetsOf = (nodeId: NodeId, author: AutomationAuthor) => ReadonlySet<NodeId>;

/** What the domain reads from the ruling canvas. */
export type AutomationEnv = {
  readonly targetsOf: TargetsOf;
  /** A seat with the overseer toggle on: it writes automations with the operator's authority. */
  readonly isOverseer: (seat: NodeId) => boolean;
  /** The ruling machine's short name: a create that names no machine runs here. Absent, it names none. */
  readonly rulingMachine?: HostId;
  /** The ruling installation, stamped on the code a ruling sets. */
  readonly rulingInstallation?: InstallationId;
};

const refuse = (refusal: Refusal): DomainVerdict<AutomationFact> => ({ kind: "refuse", refusal });
const apply = (fact: AutomationFact): DomainVerdict<AutomationFact> => ({ kind: "apply", facts: [fact] });

const READ_HEAD = "Read the head with junto automation show, then edit against it";

/** The author a ruled actor writes as; undefined for an automation. */
export const authorOf = (actor: ResourceActor): AutomationAuthor | undefined => {
  switch (actor.kind) {
    case "operator":
      return { kind: "operator" };
    case "seat":
      return { kind: "seat", seat: actor.nodeId };
    case "automation":
      return undefined;
    default:
      return actor satisfies never;
  }
};

/** Why a definition cannot be stored for this node and author, if it cannot. */
const definitionRefusal = (
  automation: Automation,
  targetsOf: TargetsOf,
  editor: AutomationAuthor = automation.author,
): Refusal | undefined => {
  if (triggerRefusal(automation.trigger) !== undefined) {
    return { reason: "not_available", message: "webhook triggers are not available in this version" };
  }
  for (const action of automation.then) {
    const refused = actionKindRefusal(action.kind) ?? actionRefusal(action);
    if (refused !== undefined) return refused;
  }
  const values = valueRefusal(automation) ?? firedTargetRefusal(automation) ?? stepIdRefusal(automation);
  if (values !== undefined) return values;
  const allowed = targetsOf(automation.nodeId, automation.author);
  const own = editor.kind === "seat" ? targetsOf(automation.nodeId, editor) : allowed;
  const outside = targetNodeIds(automation).filter((id) => !allowed.has(id) || !own.has(id));
  if (outside.length > 0) {
    return {
      reason: "not_in_reach",
      message: `an automation here may not act on ${outside.join(", ")}`,
      next_step: "Name only seats and resources in this node's region and below, within your reach",
    };
  }
  return undefined;
};

/** A whole-definition replace: a field the new definition leaves out (`when`) is gone; `enabled` stays. */
const replaced = (
  automation: Automation,
  definition: AutomationDefinition,
  version: AutomationVersion,
  codeRuling: CodeRuling | undefined,
): Automation => ({
  automationId: automation.automationId,
  nodeId: automation.nodeId,
  author: automation.author,
  version,
  enabled: automation.enabled,
  ...(automation.machine === undefined ? {} : { machine: automation.machine }),
  ...(codeRuling === undefined ? {} : { codeRuling }),
  ...definition,
});

/** Each code step's program, by language and digest. */
const programsOf = (then: AutomationDefinition["then"]): ReadonlySet<string> =>
  new Set(then.flatMap((action) => (action.kind === "code" ? [`${action.language}:${action.source.sha256}`] : [])));

/**
 * The ruling an automation's code stands on once a ruling by `author` on
 * `installation` applies (security doctrine, Code steps, check 3). Code left
 * as it was keeps the ruling that set it, whoever edits the rest; new code
 * is this ruling's. When new code joins code someone else wrote, a seat's
 * name stays, so an operator's edit never vouches for an overseer's program.
 */
export const codeRulingAfter = (
  before: Pick<Automation, "then" | "codeRuling"> | undefined,
  then: AutomationDefinition["then"],
  author: AutomationAuthor,
  installation: InstallationId | undefined,
): CodeRuling | undefined => {
  const programs = programsOf(then);
  if (programs.size === 0) return undefined;
  const held = before === undefined ? new Set<string>() : programsOf(before.then);
  const kept = [...programs].some((program) => held.has(program));
  const added = [...programs].some((program) => !held.has(program));
  const earlier = before?.codeRuling;
  const now: CodeRuling = { author, ...(installation === undefined ? {} : { installation }) };
  if (!added) return earlier ?? now;
  if (!kept || earlier === undefined) return now;
  return author.kind === "seat" ? now : earlier;
};

/** The domain. `now` stamps facts; the ruler passes the editing machine's clock, the overlay its own. */
export const automationDomain = (
  now: () => number,
  env: AutomationEnv,
): ResourceDomain<AutomationState, AutomationOp, AutomationFact> => ({
  kind: "automation",
  rule: (state, command) => ruleAutomationCommand(state, command, now(), env),
  apply: applyAutomationFact,
});

export const ruleAutomationCommand = (
  state: AutomationState,
  command: ResourceCommand<AutomationOp>,
  at: number,
  env: AutomationEnv,
): DomainVerdict<AutomationFact> => {
  const { target, op } = command;
  const { targetsOf } = env;
  if (target.kind !== "automation") {
    return refuse({ reason: "invalid_input", message: `an automation command targets an automation, not a ${target.kind}` });
  }
  const author = authorOf(command.actor);
  if (author === undefined) {
    return refuse({ reason: "invalid_input", message: "an automation cannot write automations" });
  }
  if (author.kind === "seat" && !env.isOverseer(author.seat)) {
    return refuse({
      reason: "not_permitted",
      message: "only the operator and overseers write automations; seats read them",
      next_step: "Ask the operator, or read it with junto automation show",
    });
  }

  if (op.kind === "create") {
    if (target.itemId !== undefined && target.itemId !== op.automationId) {
      return refuse({ reason: "invalid_input", message: "target.itemId and the created automationId differ" });
    }
    if (state.has(op.automationId)) {
      return refuse({ reason: "invalid_input", message: `automation ${op.automationId} already exists` });
    }
    const codeRuling = codeRulingAfter(undefined, op.definition.then, author, env.rulingInstallation);
    const automation: Automation = {
      automationId: op.automationId,
      nodeId: target.nodeId,
      author,
      version: FIRST_AUTOMATION_VERSION,
      enabled: op.enabled,
      ...((op.machine ?? env.rulingMachine) === undefined ? {} : { machine: op.machine ?? env.rulingMachine }),
      ...(codeRuling === undefined ? {} : { codeRuling }),
      ...op.definition,
    };
    const refusal = definitionRefusal(automation, targetsOf);
    return refusal === undefined ? apply({ fact: "automation.created", automation, at }) : refuse(refusal);
  }

  const automationId = target.itemId;
  if (automationId === undefined) {
    return refuse({ reason: "invalid_input", message: "an automation command names its automation as target.itemId" });
  }
  const entry = state.get(automationId);
  if (entry === undefined || entry.automation.nodeId !== target.nodeId) {
    return refuse({ reason: "unknown_target", message: `no automation ${automationId} on ${target.nodeId}` });
  }
  if (entry.archived) {
    return refuse({ reason: "invalid_transition", message: `automation ${automationId} is archived` });
  }
  const head = entry.automation.version;

  switch (op.kind) {
    case "edit": {
      if (op.baseVersion !== head) {
        return refuse({
          reason: "stale",
          message: `automation ${automationId} is at version ${head}, not ${op.baseVersion}`,
          expected: head,
          next_step: READ_HEAD,
        });
      }
      // The creator stays the author, and a seat's edit must also fit its own
      // targets: the definition sits inside both, so an edit widens no one.
      const codeRuling = codeRulingAfter(entry.automation, op.definition.then, author, env.rulingInstallation);
      const edited = replaced(entry.automation, op.definition, AutomationVersion.make(head + 1), codeRuling);
      const refusal = definitionRefusal(edited, targetsOf, author);
      if (refusal !== undefined) return refuse(refusal);
      return apply({
        fact: "automation.edited",
        automationId,
        version: edited.version,
        definition: op.definition,
        ...(codeRuling === undefined ? {} : { codeRuling }),
        at,
      });
    }
    case "set-enabled":
      return apply({ fact: "automation.enabled", automationId, enabled: op.enabled, at });
    case "set-machine":
      return apply({ fact: "automation.moved", automationId, machine: op.machine, at });
    case "archive":
      return apply({ fact: "automation.archived", automationId, at });
    case "run":
      return triggerRefusal(entry.automation.trigger) === undefined
        ? apply({ fact: "automation.run", automationId, nodeId: target.nodeId, at })
        : refuse({ reason: "not_available", message: "webhook triggers are not available in this version" });
    default:
      return op satisfies never;
  }
};

// ── Apply ──────────────────────────────────────────────────────────────────

const withEntry = (
  state: AutomationState,
  automationId: AutomationId,
  change: (entry: AutomationEntry) => AutomationEntry,
): AutomationState => {
  const entry = state.get(automationId);
  return entry === undefined ? state : new Map(state).set(automationId, change(entry));
};

/** Fold one ruled fact into state. A fact for an unknown automation changes nothing. */
export const applyAutomationFact = (state: AutomationState, fact: AutomationFact): AutomationState => {
  switch (fact.fact) {
    // Every machine folds the same rulings (machines.md Rule 2), and one may
    // arrive twice: a create of one that exists, or an edit at or below its
    // version, changes nothing.
    case "automation.created":
      return state.has(fact.automation.automationId)
        ? state
        : new Map(state).set(fact.automation.automationId, {
            automation: fact.automation,
            archived: false,
            updatedAt: fact.at,
          });
    case "automation.edited":
      return withEntry(state, fact.automationId, (entry) =>
        fact.version <= entry.automation.version
          ? entry
          : {
              ...entry,
              automation: replaced(entry.automation, fact.definition, fact.version, fact.codeRuling),
              updatedAt: fact.at,
            });
    case "automation.moved":
      return withEntry(state, fact.automationId, (entry) => ({
        ...entry,
        automation: { ...entry.automation, machine: fact.machine },
        updatedAt: fact.at,
      }));
    case "automation.enabled":
      return withEntry(state, fact.automationId, (entry) => ({
        ...entry,
        automation: { ...entry.automation, enabled: fact.enabled },
        updatedAt: fact.at,
      }));
    case "automation.archived":
      return withEntry(state, fact.automationId, (entry) => ({ ...entry, archived: true, updatedAt: fact.at }));
    case "automation.run":
      return state;
    default:
      return fact satisfies never;
  }
};

/** The live automations on one node, newest change first. */
export const automationsOnNode = (state: AutomationState, nodeId: NodeId): ReadonlyArray<Automation> =>
  [...state.values()]
    .filter((entry) => !entry.archived && entry.automation.nodeId === nodeId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((entry) => entry.automation);
