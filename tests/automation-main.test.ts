import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import { AutomationVersion, type Automation, type AutomationOp } from "../src/shared/automation";
import { ActorSeatId } from "../src/shared/actor-seat";
import { asNodeId, type Canvas, type Node } from "../src/shared/model";
import type { ResourceCommand } from "../src/shared/resource-command";
import type { WorkErrorBody } from "../src/shared/work-control";
import { ItemId } from "../src/shared/work-ids";
import {
  handleAutomationRead,
  handleAutomationWrite,
  liveAutomationPorts,
  type AutomationCaller,
  type AutomationPorts,
  type AutomationWriter,
} from "../src/main/junto/work/automation-control";
import { automationTargetResolver } from "../src/main/junto/work/automation-targets";
import { emptyAutomationState, ruleAutomationCommand } from "../src/shared/automation-domain";
import { automationTargets } from "../src/shared/region-reach";

const at = (id: string, kind: string, x: number, y: number, extra: Record<string, unknown> = {}, width = 50, height = 50) =>
  ({ id: asNodeId(id), kind, x, y, width, height, ...extra }) as unknown as Node;

// Junto region J holds the seat SJ and region CLI; CLI holds seats S1 and S2,
// the tasks node TC and the Automations node AU (a note stands in for the kind
// canvas C5 adds). Sibling region P holds seat SP.
const nodes = [
  at("J", "region", 0, 0, { label: "Junto" }, 2000, 1000),
  at("SJ", "agent", 1500, 900, { label: "lead", agentKey: "lead" }),
  at("CLI", "region", 10, 10, { label: "CLI" }, 800, 800),
  at("S1", "agent", 20, 20, { label: "cli-lead", agentKey: "a" }),
  at("S2", "agent", 100, 20, { label: "cli-external", agentKey: "b" }),
  at("TC", "task", 200, 20, { name: "CLI tasks" }),
  at("AU", "note", 300, 20, { text: "Automations" }),
  at("P", "region", 1000, 10, { label: "Product" }, 400, 400),
  at("SP", "agent", 1010, 20, { label: "product-feed", agentKey: "c" }),
];
const canvas = { nodes: new Map(nodes.map((node) => [node.id, node])), wires: new Map() } as unknown as Canvas;

const OP = "01M5ESM1XHCJ7JYJDBC37MREBZ";
const NEW = "01M5ESMQ2ZT55QZ073EWPH10SG";
const EXISTING = ItemId.make("01M5ETAKR8YSPP5Y22H4KH2YMW");

const caller = (nodeId: string): AutomationCaller => ({
  canvas,
  canvasName: "factory",
  actor: { kind: "seat", seatId: ActorSeatId.make(`seat_${"a".repeat(64)}`), nodeId: asNodeId(nodeId) },
});

/** An overseer seat writes as itself; the domain checks its toggle when it rules. */
const writer = (nodeId: string): AutomationWriter => caller(nodeId);

const stored: Automation = {
  automationId: EXISTING,
  nodeId: asNodeId("AU"),
  author: { kind: "seat", seat: asNodeId("S1") },
  name: "nightly review",
  enabled: false,
  trigger: { kind: "poll", everyMs: 60_000 },
  then: [{ kind: "mail", to: { kind: "seat", nodeId: asNodeId("S1") }, text: "hi" }],
  limits: { minIntervalMs: 0, maxPerHour: 1 },
  version: AutomationVersion.make(1),
};

const fakePorts = (submitted: Array<ResourceCommand<AutomationOp>>): AutomationPorts => ({
  nodes: (c) => [...c.nodes.values()].filter((node) => node.id === "AU"),
  automations: () => Effect.succeed([stored]),
  firings: () => Effect.succeed([]),
  submit: (command) => {
    submitted.push(command);
    return Effect.succeed({ disposition: "applied", opId: command.opId, automationId: command.target.itemId!, version: AutomationVersion.make(2) });
  },
});

const run = (op: Parameters<typeof handleAutomationWrite>[0], args: unknown, who = "S2", ports?: AutomationPorts) =>
  Effect.runSyncExit(handleAutomationWrite(op, args, writer(who), ports ?? fakePorts([])));

const read = (op: Parameters<typeof handleAutomationRead>[0], args: unknown, who = "S2", ports?: AutomationPorts) =>
  Effect.runSyncExit(handleAutomationRead(op, args, caller(who), ports ?? fakePorts([])));

const failure = (exit: Exit.Exit<unknown, WorkErrorBody>): WorkErrorBody => {
  if (Exit.isSuccess(exit)) throw new Error("expected a refusal");
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  if (error === undefined || error._tag !== "Fail") throw new Error(String(exit.cause));
  return error.error;
};

const create = {
  target: "Automations",
  opId: OP,
  automationId: NEW,
  name: "remind",
  enabled: true,
  limits: { minIntervalMs: 0, maxPerHour: 2 },
  trigger: { kind: "schedule", cron: "0 9 * * 1-5", timezone: "UTC" },
  then: [
    { kind: "mail", to: "@cli-lead", text: "standup" },
    { kind: "create-task", node: "CLI tasks", title: "notes", assign: "@cli-external" },
  ],
};

describe("automation verbs in main", () => {
  it("turns a create into one resource command with every target resolved", () => {
    const submitted: Array<ResourceCommand<AutomationOp>> = [];
    const exit = Effect.runSyncExit(handleAutomationWrite("automation.create", create, writer("S2"), fakePorts(submitted)));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(submitted).toHaveLength(1);
    const [command] = submitted;
    expect(command!.target).toEqual({ kind: "automation", nodeId: "AU", itemId: NEW });
    expect(command!.actor).toMatchObject({ kind: "seat", nodeId: "S2" });
    expect(command!.op).toEqual({
      kind: "create",
      automationId: NEW,
      enabled: true,
      definition: {
        name: "remind",
        trigger: create.trigger,
        then: [
          { kind: "mail", to: { kind: "seat", nodeId: "S1" }, text: "standup" },
          { kind: "create-task", node: "TC", title: "notes", assign: { kind: "seat", nodeId: "S2" } },
        ],
        limits: create.limits,
      },
    });
  });

  it("is applied for an overseer and refused not_permitted for any other seat when the domain rules it", () => {
    const submitted: Array<ResourceCommand<AutomationOp>> = [];
    Effect.runSync(handleAutomationWrite("automation.create", create, writer("S2"), fakePorts(submitted)));
    const env = (overseer: boolean) => ({
      targetsOf: (nodeId: Parameters<typeof automationTargets>[1], author: Parameters<typeof automationTargets>[2]) =>
        new Set(automationTargets(canvas, nodeId, author).map((target) => target.id)),
      isOverseer: () => overseer,
    });
    expect(ruleAutomationCommand(emptyAutomationState(), submitted[0]!, 0, env(true))).toMatchObject({ kind: "apply" });
    expect(ruleAutomationCommand(emptyAutomationState(), submitted[0]!, 0, env(false))).toMatchObject({
      kind: "refuse",
      refusal: { reason: "not_permitted" },
    });
  });

  it("refuses a webhook trigger as not available, before any target", () => {
    const webhook = { ...create, trigger: { kind: "webhook", endpointId: "gh" }, then: [{ kind: "mail", to: "@nobody", text: "x" }] };
    expect(failure(run("automation.create", webhook))).toMatchObject({
      type: "InputError",
      details: { reason: "not_available", path: "trigger.kind" },
    });
  });

  it("refuses a target above the automation's node, and a sibling's seat", () => {
    const above = { ...create, then: [{ kind: "mail", to: "@lead", text: "x" }] };
    expect(failure(run("automation.create", above))).toMatchObject({ type: "UnknownTarget", details: { path: "then[0].to" } });
    const sibling = { ...create, then: [{ kind: "mail", to: "junto://canvas/factory?node=SP", text: "x" }] };
    expect(failure(run("automation.create", sibling))).toMatchObject({ type: "ScopeError", details: { reason: "out_of_reach" } });
  });

  it("refuses a task number until numbers are minted", () => {
    const numbered = { ...create, then: [{ kind: "assign-task", task: "#42", to: "@cli-lead" }] };
    expect(failure(run("automation.create", numbered))).toMatchObject({ details: { reason: "not_available", path: "then[0].task" } });
  });

  it("refuses a seat a read of an Automations node out of its reach", () => {
    expect(failure(read("automation.show", { target: "Automations", automation: "nightly review" }, "SP"))).toMatchObject({
      type: "ScopeError",
      details: { path: "target" },
    });
  });

  it("keeps an overseer's targets inside its own reach", () => {
    expect(failure(run("automation.create", create, "SP"))).toMatchObject({ type: "UnknownTarget", details: { path: "then[0].to" } });
  });

  it("stores an edit as the whole definition, merged onto the head it names", () => {
    const submitted: Array<ResourceCommand<AutomationOp>> = [];
    Effect.runSync(handleAutomationWrite("automation.edit", {
      target: "AU", automation: "nightly review", opId: OP, baseVersion: 1, change: { name: "weekly", when: [] },
    }, writer("S2"), fakePorts(submitted)));
    expect(submitted[0]!.op).toEqual({
      kind: "edit",
      baseVersion: 1,
      definition: { name: "weekly", trigger: stored.trigger, then: stored.then, limits: stored.limits },
    });
  });

  it("refuses an edit written on an older head as Stale, naming the head", () => {
    const edit = { target: "AU", automation: "nightly review", opId: OP, baseVersion: 2, change: { name: "x" } };
    expect(failure(run("automation.edit", edit))).toMatchObject({ type: "Stale", details: { expected: 1, retryable: true } });
  });

  it("turns enable, disable, archive and run into the domain's ops on the named automation", () => {
    const submitted: Array<ResourceCommand<AutomationOp>> = [];
    const ports = fakePorts(submitted);
    for (const op of ["automation.enable", "automation.disable", "automation.archive", "automation.run"] as const) {
      Effect.runSync(handleAutomationWrite(op, { target: "Automations", automation: EXISTING, opId: OP }, writer("S2"), ports));
    }
    expect(submitted.map((command) => command.op)).toEqual([
      { kind: "set-enabled", enabled: true },
      { kind: "set-enabled", enabled: false },
      { kind: "archive" },
      { kind: "run" },
    ]);
    expect(submitted.every((command) => command.target.itemId === EXISTING)).toBe(true);
    expect(failure(run("automation.enable", { target: "AU", automation: "nope", opId: OP }))).toMatchObject({
      type: "UnknownTarget",
      details: { hint: "automations: nightly review" },
    });
  });

  it("lists every Automations node in reach when none is named", () => {
    expect(Effect.runSync(handleAutomationRead("automation.list", {}, caller("S2"), fakePorts([])))).toEqual({ automations: [stored] });
    expect(Effect.runSync(handleAutomationRead("automation.list", {}, caller("SP"), fakePorts([])))).toEqual({ automations: [] });
  });

  it("refuses an edit without its base version, and one that changes nothing", () => {
    const edit = { target: "AU", automation: "nightly review", opId: OP, change: { name: "x" } };
    expect(failure(run("automation.edit", edit))).toMatchObject({ type: "InputError", details: { path: "args" } });
    expect(failure(run("automation.edit", { ...edit, baseVersion: 1, change: {} }))).toMatchObject({
      type: "InputError",
      details: { path: "change" },
    });
  });
});

describe("before the Automations kind lands", () => {
  it("lists nothing and names no node", () => {
    expect(Effect.runSync(handleAutomationRead("automation.list", {}, caller("S2"), liveAutomationPorts))).toEqual({ automations: [] });
    expect(failure(read("automation.show", { target: "Automations", automation: "x" }, "S2", liveAutomationPorts))).toMatchObject({
      type: "UnknownTarget",
      details: { hint: "this canvas has no Automations node" },
    });
  });
});

describe("automationTargetResolver", () => {
  const resolver = automationTargetResolver(canvas, asNodeId("AU"), { kind: "seat", seat: asNodeId("S2") });

  it("names a seat by its exact name and offers the ones it could mean", () => {
    expect(resolver.ref("@cli-lead", "seat", "p")).toEqual({ kind: "seat", nodeId: "S1" });
    expect(resolver.ref("@cli", "seat", "p")).toMatchObject({
      type: "UnknownTarget",
      details: { hint: "seats it can name: cli-lead, cli-external" },
    });
  });

  it("names why a page is refused", () => {
    const withPage = { ...canvas, nodes: new Map([...canvas.nodes, [asNodeId("PG"), at("PG", "page", 400, 20, { url: "https://x.dev" })]]) } as Canvas;
    const pages = automationTargetResolver(withPage, asNodeId("AU"), { kind: "seat", seat: asNodeId("S2") });
    expect(pages.ref("junto://canvas/factory?node=PG", "subject", "p")).toMatchObject({ details: { reason: "not_available", received: "page" } });
  });

  it("refuses a seat where a task is wanted", () => {
    expect(resolver.ref("@cli-lead", "task", "p")).toMatchObject({ type: "InputError", details: { received: "seat" } });
  });

  it("names a tasks node by name, id or link, and nothing out of reach", () => {
    expect(resolver.node("CLI tasks", "p")).toBe("TC");
    expect(resolver.node("TC", "p")).toBe("TC");
    expect(resolver.node("junto://canvas/factory?node=TC", "p")).toBe("TC");
    expect(resolver.node("Elsewhere", "p")).toMatchObject({ type: "UnknownTarget" });
  });
});
