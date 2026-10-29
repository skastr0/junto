import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { ActorSeatId } from "../src/shared/actor-seat";
import {
  type AutomationDefinition,
  AutomationId,
  type AutomationOp,
  AutomationVersion,
} from "../src/shared/automation";
import {
  applyAutomationFact,
  type AutomationFact,
  type AutomationState,
  automationsOnNode,
  emptyAutomationState,
  ruleAutomationCommand,
  type AutomationEnv,
} from "../src/shared/automation-domain";
import { AUTOMATION_SIGNALS_ENABLED } from "../src/shared/features";
import { asNodeId, type NodeId } from "../src/shared/physics/schema";
import type { ResourceActor, ResourceCommand } from "../src/shared/resource-command";
import { OpId } from "../src/shared/work-ids";

const ID = Schema.decodeUnknownSync(AutomationId)("01M5ESKJFC1A88R1MH1NEZWJ2Q");
const OP = Schema.decodeUnknownSync(OpId)("01M5ESMJNGY0103BZJ3NYHP5GG");
const NODE = asNodeId("automations-1");
const A = asNodeId("agent-a");
const SIBLING = asNodeId("agent-sibling");

const seat = (name: string): ResourceActor => ({
  kind: "seat",
  seatId: `seat_${name.padEnd(64, "0")}` as ActorSeatId,
  nodeId: asNodeId(name),
});
const operator: ResourceActor = { kind: "operator" };

const definition = (to: NodeId = A, over: Partial<AutomationDefinition> = {}): AutomationDefinition => ({
  name: "Standup",
  trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" },
  when: [{ kind: "seat", seat: { kind: "seat", nodeId: to }, becomes: "idle", holds: true }],
  then: [{ kind: "mail", to: { kind: "seat", nodeId: to }, text: "Plan?" }],
  limits: { minIntervalMs: 60_000, maxPerHour: 12 },
  ...over,
});

/** The operator reaches everything below; overseer agent-a only itself. agent-plain is no overseer. */
const env: AutomationEnv = {
  targetsOf: (_node, author) => new Set(author.kind === "operator" ? [A, SIBLING] : [A]),
  isOverseer: (seat) => seat === A,
};

const command = (op: AutomationOp, actor: ResourceActor = seat("agent-a"), itemId: AutomationId | undefined = ID): ResourceCommand<AutomationOp> => ({
  opId: OP,
  canvasName: "factory",
  actor,
  target: { kind: "automation", nodeId: NODE, ...(itemId === undefined ? {} : { itemId }) },
  basis: null,
  after: [],
  op,
});

const rule = (state: AutomationState, op: AutomationOp, actor?: ResourceActor) =>
  ruleAutomationCommand(state, command(op, actor), 1_000, env);

const ruled = (state: AutomationState, op: AutomationOp, actor?: ResourceActor): AutomationState => {
  const verdict = rule(state, op, actor);
  if (verdict.kind !== "apply") throw new Error(verdict.refusal.message);
  return verdict.facts.reduce<AutomationState>((next, fact: AutomationFact) => applyAutomationFact(next, fact), state);
};

const created = () => ruled(emptyAutomationState(), { kind: "create", automationId: ID, enabled: true, definition: definition() });

describe("who writes", () => {
  it("refuses a seat that is not an overseer, for every verb", () => {
    const plain = seat("agent-plain");
    expect(rule(emptyAutomationState(), { kind: "create", automationId: ID, enabled: true, definition: definition() }, plain)).toMatchObject({
      kind: "refuse",
      refusal: { reason: "not_permitted" },
    });
    for (const op of [{ kind: "set-enabled", enabled: false }, { kind: "archive" }, { kind: "run" }] as const) {
      expect(rule(created(), op, plain), op.kind).toMatchObject({ kind: "refuse", refusal: { reason: "not_permitted" } });
    }
  });
});

describe("create", () => {
  it("stores version 1 with the ruled actor as author", () => {
    const [automation] = automationsOnNode(created(), NODE);
    expect(automation).toMatchObject({ version: 1, author: { kind: "seat", seat: A }, nodeId: NODE });
  });

  it("refuses a target outside the author's reach", () => {
    const verdict = rule(emptyAutomationState(), { kind: "create", automationId: ID, enabled: true, definition: definition(SIBLING) });
    expect(verdict).toMatchObject({ kind: "refuse", refusal: { reason: "not_in_reach" } });
    expect(rule(emptyAutomationState(), { kind: "create", automationId: ID, enabled: true, definition: definition(SIBLING) }, operator).kind).toBe(
      "apply",
    );
  });

  it("refuses a webhook, a duplicate id and an automation author", () => {
    const hook = definition(A, { trigger: { kind: "webhook", endpointId: "ep" } });
    expect(rule(emptyAutomationState(), { kind: "create", automationId: ID, enabled: true, definition: hook })).toMatchObject({
      refusal: { reason: "not_available" },
    });
    expect(rule(created(), { kind: "create", automationId: ID, enabled: true, definition: definition() })).toMatchObject({
      refusal: { reason: "invalid_input" },
    });
    const robot: ResourceActor = { kind: "automation", nodeId: NODE, automationId: ID };
    expect(rule(emptyAutomationState(), { kind: "create", automationId: ID, enabled: true, definition: definition() }, robot)).toMatchObject({
      refusal: { reason: "invalid_input" },
    });
  });
});

describe("edit", () => {
  it("replaces the whole definition and bumps the version", () => {
    const { when, ...rest } = definition();
    const next = ruled(created(), { kind: "edit", baseVersion: AutomationVersion.make(1), definition: { ...rest, name: "Renamed" } });
    const [automation] = automationsOnNode(next, NODE);
    expect(automation).toMatchObject({ version: 2, name: "Renamed" });
    expect(when).toHaveLength(1);
    expect("when" in automation!).toBe(false);
  });

  it("refuses a moved base stale, with the head", () => {
    const verdict = rule(created(), { kind: "edit", baseVersion: AutomationVersion.make(2), definition: definition() });
    expect(verdict).toMatchObject({ kind: "refuse", refusal: { reason: "stale", expected: 1 } });
  });

  it("keeps the creator as author: the operator editing a seat's automation cannot widen it", () => {
    const widened = rule(created(), { kind: "edit", baseVersion: AutomationVersion.make(1), definition: definition(SIBLING) }, operator);
    expect(widened).toMatchObject({ kind: "refuse", refusal: { reason: "not_in_reach" } });
  });
});

describe("edit by another writer", () => {
  // agent-a reaches only agent-a; the operator reaches agent-a and the sibling.
  const operatorMade = () => ruled(emptyAutomationState(), { kind: "create", automationId: ID, enabled: true, definition: definition(SIBLING) }, operator);

  it("refuses a child-region seat that edits an operator automation to act outside its own reach", () => {
    const verdict = rule(operatorMade(), { kind: "edit", baseVersion: AutomationVersion.make(1), definition: definition(SIBLING, { name: "Mine" }) });
    expect(verdict).toMatchObject({ kind: "refuse", refusal: { reason: "not_in_reach" } });
  });

  it("lets that seat edit it inside its own reach, and the author stays the operator", () => {
    const next = ruled(operatorMade(), { kind: "edit", baseVersion: AutomationVersion.make(1), definition: definition(A) });
    expect(automationsOnNode(next, NODE)[0]).toMatchObject({ author: { kind: "operator" }, version: 2 });
  });

  it("keeps an operator's disable through a seat's edit based before it", () => {
    const off = ruled(operatorMade(), { kind: "set-enabled", enabled: false }, operator);
    const edited = ruled(off, { kind: "edit", baseVersion: AutomationVersion.make(1), definition: definition(A) });
    expect(automationsOnNode(edited, NODE)[0]).toMatchObject({ enabled: false, version: 2 });
  });
});

describe("toggle, archive, run", () => {
  it("never re-enables through an edit based before the toggle", () => {
    const off = ruled(created(), { kind: "set-enabled", enabled: false });
    const edited = ruled(off, { kind: "edit", baseVersion: AutomationVersion.make(1), definition: definition() });
    expect(automationsOnNode(edited, NODE)[0]).toMatchObject({ enabled: false, version: 2 });
  });

  it("toggles with no base, so a toggle never goes stale", () => {
    const edited = ruled(created(), { kind: "edit", baseVersion: AutomationVersion.make(1), definition: definition() });
    const off = ruled(edited, { kind: "set-enabled", enabled: false });
    expect(automationsOnNode(off, NODE)[0]).toMatchObject({ enabled: false, version: 2 });
  });

  it("archives out of the list, then refuses every change", () => {
    const archived = ruled(created(), { kind: "archive" });
    expect(automationsOnNode(archived, NODE)).toEqual([]);
    expect(rule(archived, { kind: "set-enabled", enabled: true })).toMatchObject({ refusal: { reason: "invalid_transition" } });
    expect(rule(archived, { kind: "run" })).toMatchObject({ refusal: { reason: "invalid_transition" } });
  });

  it("runs as one fact that changes no state", () => {
    const state = created();
    const verdict = rule(state, { kind: "run" });
    expect(verdict).toMatchObject({ kind: "apply", facts: [{ fact: "automation.run", automationId: ID, nodeId: NODE }] });
    expect(ruled(state, { kind: "run" })).toEqual(state);
  });

  it("refuses an unknown automation", () => {
    expect(rule(emptyAutomationState(), { kind: "run" })).toMatchObject({ refusal: { reason: "unknown_target" } });
  });
});

describe("the machine an automation runs on", () => {
  const createOp = (machine?: string): AutomationOp => ({
    kind: "create",
    automationId: ID,
    enabled: true,
    ...(machine === undefined ? {} : { machine: machine as never }),
    definition: definition(),
  });
  const onMacbook = (op: AutomationOp) => ruleAutomationCommand(emptyAutomationState(), command(op), 1_000, { ...env, rulingMachine: "macbook" as never });

  it("is the one a create names, else the machine that rules it", () => {
    expect(onMacbook(createOp("mini"))).toMatchObject({ kind: "apply", facts: [{ automation: { machine: "mini" } }] });
    expect(onMacbook(createOp())).toMatchObject({ kind: "apply", facts: [{ automation: { machine: "macbook" } }] });
  });

  it("moves with its own op, which keeps the definition, its version and enabled", () => {
    const moved = ruled(created(), { kind: "set-machine", machine: "mini" as never });
    const [automation] = automationsOnNode(moved, NODE);
    expect(automation).toMatchObject({ machine: "mini", version: 1, enabled: true, name: "Standup" });
    // An edit after the move keeps the machine.
    const edited = ruled(moved, { kind: "edit", baseVersion: automation!.version, definition: definition(A, { name: "Later" }) });
    expect(automationsOnNode(edited, NODE)[0]).toMatchObject({ machine: "mini", version: 2, name: "Later" });
  });
});

describe.runIf(AUTOMATION_SIGNALS_ENABLED)("signal steps that send their answer somewhere (0.11/09 H1)", () => {
  const LISTENER = Schema.decodeUnknownSync(AutomationId)("01M5ESKJFC1A88R1MH1NEZWJ2R");
  const reach: AutomationEnv = { ...env, targetsOf: () => new Set([A, SIBLING, NODE]), rulingMachine: "macbook" as never };
  const rules = (state: AutomationState, op: AutomationOp, itemId: AutomationId) =>
    ruleAutomationCommand(state, command(op, operator, itemId), 1_000, reach);
  const ask = (id?: string) =>
    ({ kind: "signal", ...(id === undefined ? {} : { id }), signal: "escalate", title: "Review?", answerTo: { kind: "seat", to: { kind: "seat", nodeId: A } } }) as const;

  it("are named at save when they have no id, by their place, never taking another step's", () => {
    const verdict = rules(emptyAutomationState(), {
      kind: "create",
      automationId: ID,
      enabled: true,
      definition: definition(A, { when: [], then: [ask(), { kind: "signal", signal: "notice", title: "Read" }, ask("step-1"), ask()] }),
    }, ID);
    expect(verdict.kind === "apply" && verdict.facts[0]!.fact === "automation.created" && verdict.facts[0]!.automation.then.map((one) => ("id" in one ? one.id : undefined)))
      .toEqual(["step-1-2", undefined, "step-1", "step-4"]);
    const state = verdict.kind === "apply" ? verdict.facts.reduce<AutomationState>((next, fact) => applyAutomationFact(next, fact), emptyAutomationState()) : emptyAutomationState();
    const edited = rules(state, { kind: "edit", baseVersion: AutomationVersion.make(1), definition: definition(A, { when: [], then: [ask()] }) }, ID);
    expect(edited).toMatchObject({ kind: "apply", facts: [{ fact: "automation.edited", definition: { then: [{ id: "step-1" }] } }] });
  });

  it("refuse an answered watch naming an automation on another Automations node, saying why", () => {
    expect(rules(emptyAutomationState(), {
      kind: "create",
      automationId: LISTENER,
      enabled: true,
      definition: definition(A, {
        name: "Write review",
        when: [],
        trigger: { kind: "change", on: { kind: "answered", automation: { node: asNodeId("automations-2"), automationId: ID } } },
        then: [{ kind: "mail", to: { kind: "seat", nodeId: A }, text: "{{answer.text}}" }],
      }),
    }, LISTENER)).toEqual({
      kind: "refuse",
      refusal: {
        reason: "invalid_input",
        message: "an answered watch listens to an automation on its own Automations node",
        next_step: "Make this automation on the node that holds the one raising the signal",
      },
    });
  });

  it("take a listener on any machine: the step and its values ride the signal", () => {
    const raiser = rules(emptyAutomationState(), {
      kind: "create", automationId: ID, enabled: true, machine: "mini" as never, definition: definition(A, { when: [], then: [ask("ask")] }),
    }, ID);
    const state = raiser.kind === "apply" ? raiser.facts.reduce<AutomationState>((next, fact) => applyAutomationFact(next, fact), emptyAutomationState()) : emptyAutomationState();
    expect(rules(state, {
      kind: "create",
      automationId: LISTENER,
      enabled: true,
      definition: definition(A, {
        name: "Write review",
        when: [],
        trigger: { kind: "change", on: { kind: "answered", automation: { node: NODE, automationId: ID }, step: "ask" } },
        then: [{ kind: "mail", to: { kind: "seat", nodeId: A }, text: "Review {{raised.fired.at|date:YYYY-MM-DD}}" }],
      }),
    }, LISTENER)).toMatchObject({ kind: "apply", facts: [{ automation: { machine: "macbook" } }] });
  });
});
