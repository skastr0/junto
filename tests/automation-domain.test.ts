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
      refusal: { reason: "invalid_input" },
    });
    for (const op of [{ kind: "set-enabled", enabled: false }, { kind: "archive" }, { kind: "run" }] as const) {
      expect(rule(created(), op, plain), op.kind).toMatchObject({ kind: "refuse" });
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
