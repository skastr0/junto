import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import type { AutomationCommandOp, AutomationView } from "../src/shared/automation-control";
import { ActorSeatId } from "../src/shared/actor-seat";
import { asNodeId, type Canvas, type Node } from "../src/shared/model";
import type { ResourceCommand } from "../src/shared/resource-command";
import type { WorkErrorBody } from "../src/shared/work-control";
import { ItemId } from "../src/shared/work-ids";
import {
  handleAutomationOp,
  liveAutomationPorts,
  type AutomationCaller,
  type AutomationPorts,
} from "../src/main/junto/work/automation-control";
import { automationTargetResolver } from "../src/main/junto/work/automation-targets";

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

const stored: AutomationView = {
  automationId: EXISTING,
  nodeId: asNodeId("AU"),
  author: { kind: "seat", seat: asNodeId("S1") },
  name: "nightly review",
  enabled: false,
  trigger: { kind: "poll", everyMs: 60_000 },
  then: [{ kind: "mail", to: { kind: "seat", nodeId: asNodeId("S1") }, text: "hi" }],
  limits: { minIntervalMs: 0, maxPerHour: 1 },
  version: "v1" as AutomationView["version"],
};

const fakePorts = (submitted: Array<ResourceCommand<AutomationCommandOp>>): AutomationPorts => ({
  nodes: (c) => [...c.nodes.values()].filter((node) => node.id === "AU"),
  automations: () => Effect.succeed([stored]),
  firings: () => Effect.succeed([]),
  submit: (command) => {
    submitted.push(command);
    return Effect.succeed({ disposition: "queued", opId: command.opId, automationId: command.target.itemId! });
  },
});

const run = (op: Parameters<typeof handleAutomationOp>[0], args: unknown, who = "S2", ports?: AutomationPorts) =>
  Effect.runSyncExit(handleAutomationOp(op, args, caller(who), ports ?? fakePorts([])));

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
    const submitted: Array<ResourceCommand<AutomationCommandOp>> = [];
    const exit = Effect.runSyncExit(handleAutomationOp("automation.create", create, caller("S2"), fakePorts(submitted)));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(submitted).toHaveLength(1);
    const [command] = submitted;
    expect(command!.target).toEqual({ kind: "automation", nodeId: "AU", itemId: NEW });
    expect(command!.actor).toMatchObject({ kind: "seat", nodeId: "S2" });
    expect(command!.op).toEqual({
      kind: "create",
      definition: {
        name: "remind",
        enabled: true,
        trigger: create.trigger,
        then: [
          { kind: "mail", to: { kind: "seat", nodeId: "S1" }, text: "standup" },
          { kind: "create-task", node: "TC", title: "notes", assign: { kind: "seat", nodeId: "S2" } },
        ],
        limits: create.limits,
      },
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

  it("refuses an Automations node out of the caller's reach", () => {
    expect(failure(run("automation.create", create, "SP"))).toMatchObject({ type: "ScopeError", details: { path: "target" } });
  });

  it("finds an automation by name or id for edit, enable and run", () => {
    const submitted: Array<ResourceCommand<AutomationCommandOp>> = [];
    const ports = fakePorts(submitted);
    Effect.runSync(handleAutomationOp("automation.edit", {
      target: "AU", automation: "nightly review", opId: OP, baseVersion: "v1", change: { name: "weekly", when: [] },
    }, caller("S2"), ports));
    Effect.runSync(handleAutomationOp("automation.run", { target: "Automations", automation: EXISTING, opId: OP }, caller("S2"), ports));
    expect(submitted.map((command) => command.op)).toEqual([
      { kind: "edit", baseVersion: "v1", change: { name: "weekly", when: [] } },
      { kind: "run" },
    ]);
    expect(submitted.every((command) => command.target.itemId === EXISTING)).toBe(true);
    expect(failure(run("automation.enable", { target: "AU", automation: "nope", opId: OP }))).toMatchObject({
      type: "UnknownTarget",
      details: { hint: "automations: nightly review" },
    });
  });

  it("lists every Automations node in reach when none is named", () => {
    expect(Effect.runSync(handleAutomationOp("automation.list", {}, caller("S2"), fakePorts([])))).toEqual({ automations: [stored] });
    expect(Effect.runSync(handleAutomationOp("automation.list", {}, caller("SP"), fakePorts([])))).toEqual({ automations: [] });
  });

  it("refuses an edit without its base version, and one that changes nothing", () => {
    const edit = { target: "AU", automation: "nightly review", opId: OP, change: { name: "x" } };
    expect(failure(run("automation.edit", edit))).toMatchObject({ type: "InputError", details: { path: "args" } });
    expect(failure(run("automation.edit", { ...edit, baseVersion: "v1", change: {} }))).toMatchObject({
      type: "InputError",
      details: { path: "change" },
    });
  });
});

describe("before the Automations kind lands", () => {
  it("lists nothing and names no node", () => {
    expect(Effect.runSync(handleAutomationOp("automation.list", {}, caller("S2"), liveAutomationPorts))).toEqual({ automations: [] });
    expect(failure(run("automation.show", { target: "Automations", automation: "x" }, "S2", liveAutomationPorts))).toMatchObject({
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
