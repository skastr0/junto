import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import { AutomationRepository, makeAutomationRepositoryLive } from "../src/main/junto/automation/repository";
import { makeAutomationRunner, type RunnerPorts } from "../src/main/junto/automation/runner";
import { AUTOMATION_STATE_SCHEMA_SQL } from "../src/main/junto/automation/state-schema";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import {
  type Action,
  type Automation,
  AutomationId,
  AutomationVersion,
  FiringId,
} from "../src/shared/automation";
import type { NodeKind } from "../src/shared/model/kinds";
import { asNodeId } from "../src/shared/physics/schema";
import type { ReachCanvas, ReachNode } from "../src/shared/region-reach";

const AUTO = Schema.decodeUnknownSync(AutomationId)("01M5ESKJFC1A88R1MH1NEZWJ2Q");
const CANVAS = "factory";
const at = (iso: string) => Date.parse(iso);

const node = (id: string, kind: NodeKind, x: number, y: number, width = 50, height = 50): ReachNode => ({
  id: asNodeId(id),
  kind,
  x,
  y,
  width,
  height,
});

// Region A holds the automation node, seat-a and seat-a2; region B, a sibling, holds seat-b.
const canvas: ReachCanvas = {
  nodes: new Map(
    [
      node("A", "region", 0, 0, 400, 400),
      node("B", "region", 500, 0, 400, 400),
      node("automations-1", "artifacts", 10, 10),
      node("seat-a", "agent", 100, 100),
      node("seat-a2", "agent", 200, 100),
      node("seat-b", "agent", 600, 100),
    ].map((n) => [n.id, n]),
  ),
};

const mail = (to: string): Action => ({ kind: "mail", to: { kind: "seat", nodeId: asNodeId(to) }, text: "Go." });

const automation = (over: Partial<Automation> = {}): Automation => ({
  automationId: AUTO,
  nodeId: asNodeId("automations-1"),
  author: { kind: "seat", seat: asNodeId("seat-a") },
  version: AutomationVersion.make(1),
  name: "Standup",
  enabled: true,
  trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" },
  then: [mail("seat-a2")],
  limits: { minIntervalMs: 0, maxPerHour: 60 },
  ...over,
});

const harness = async (seed: Automation) => {
  const database = new DatabaseSync(":memory:");
  database.exec(AUTOMATION_STATE_SCHEMA_SQL);
  const sql = Layer.effect(SqlClient.SqlClient, makeSqliteClient(database)).pipe(Layer.provide(Reactivity.layer));
  const runtime = ManagedRuntime.make(makeAutomationRepositoryLive().pipe(Layer.provideMerge(sql)));
  const clock = { now: at("2026-10-21T08:00:00Z") };
  const performed: Array<{ readonly to: string; readonly index: number }> = [];
  let minted = 0;
  const ports: RunnerPorts = {
    canvas: () => canvas,
    holds: () => true,
    perform: (_canvas, _automation, action, index) =>
      Effect.sync(() => {
        performed.push({ to: action.kind === "mail" ? action.to.nodeId : action.kind, index });
        return { index, ruling: "applied" as const };
      }),
    mintFiringId: () => FiringId.make(`01M5ESKJFC1A88R1MH1NEZ${String(minted++).padStart(4, "0")}`),
    now: () => clock.now,
  };
  const runner = makeAutomationRunner(ports);
  const go = <A, E>(effect: Effect.Effect<A, E, AutomationRepository>) => runtime.runPromise(effect);
  await go(Effect.flatMap(AutomationRepository, (r) => r.applyFacts(CANVAS, [{ fact: "automation.created", automation: seed, at: 0 }])));
  const history = () => go(Effect.flatMap(AutomationRepository, (r) => r.firings(CANVAS, { automationId: AUTO })));
  const close = async () => {
    await runtime.dispose();
    database.close();
  };
  return { runner, go, clock, performed, history, close };
};

describe("tick", () => {
  it("starts a new automation's cursor at first sight, then fires its next slot once", async () => {
    const h = await harness(automation());
    try {
      await h.go(h.runner.tick(CANVAS));
      expect(await h.history()).toEqual([]);
      h.clock.now = at("2026-10-21T09:00:10Z");
      await h.go(h.runner.tick(CANVAS));
      await h.go(h.runner.tick(CANVAS));
      const firings = await h.history();
      expect(firings).toHaveLength(1);
      expect(firings[0]).toMatchObject({
        cause: { kind: "schedule", slot: at("2026-10-21T09:00:00Z"), missed: 0 },
        outcome: { kind: "fired", actions: [{ index: 0, ruling: "applied" }] },
      });
      expect(h.performed).toEqual([{ to: "seat-a2", index: 0 }]);
    } finally {
      await h.close();
    }
  });

  it("fires a lid-closed schedule once for its latest slot", async () => {
    const h = await harness(automation());
    try {
      await h.go(h.runner.tick(CANVAS));
      h.clock.now = at("2026-10-24T10:00:00Z");
      await h.go(h.runner.tick(CANVAS));
      const firings = await h.history();
      expect(firings.map((f) => f.cause)).toEqual([{ kind: "schedule", slot: at("2026-10-24T09:00:00Z"), missed: 3 }]);
      expect(h.performed).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it("passes a disabled automation's slot with no record, and never fires it later", async () => {
    const h = await harness(automation({ enabled: false }));
    try {
      await h.go(h.runner.tick(CANVAS));
      h.clock.now = at("2026-10-21T09:00:10Z");
      await h.go(h.runner.tick(CANVAS));
      expect(await h.history()).toEqual([]);
      expect(h.performed).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("skips out of reach when a seat author names a sibling region's seat", async () => {
    const h = await harness(automation({ then: [mail("seat-b")] }));
    try {
      await h.go(h.runner.tick(CANVAS));
      h.clock.now = at("2026-10-21T09:00:10Z");
      await h.go(h.runner.tick(CANVAS));
      expect((await h.history()).map((f) => f.outcome)).toEqual([{ kind: "skipped", reason: "out_of_reach" }]);
      expect(h.performed).toEqual([]);
    } finally {
      await h.close();
    }
  });
});

describe("onChange", () => {
  const onIdle = automation({
    trigger: { kind: "change", on: { kind: "seat", seat: { kind: "seat", nodeId: asNodeId("seat-a") }, becomes: "idle" } },
    limits: { minIntervalMs: 0, maxPerHour: 1 },
  });
  const idle = (key: string) => ({ kind: "seat", key, seat: asNodeId("seat-a"), becomes: "idle" }) as const;

  it("fires on a matching transition once per key, then skips at the hourly cap", async () => {
    const h = await harness(onIdle);
    try {
      await h.go(h.runner.onChange(CANVAS, idle("seat-a:1")));
      await h.go(h.runner.onChange(CANVAS, idle("seat-a:1")));
      await h.go(h.runner.onChange(CANVAS, { ...idle("seat-a:1"), becomes: "working" }));
      await h.go(h.runner.onChange(CANVAS, idle("seat-a:2")));
      const firings = await h.history();
      expect(firings.map((f) => f.outcome.kind)).toEqual(["skipped", "fired"]);
      expect(firings[0]?.outcome).toEqual({ kind: "skipped", reason: "max_per_hour" });
      expect(h.performed).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it("never fires on a fact an automation wrote", async () => {
    const tasks = automation({ trigger: { kind: "change", on: { kind: "task", task: { node: asNodeId("seat-a2") }, becomes: "done" } } });
    const h = await harness(tasks);
    try {
      const done = {
        kind: "task",
        key: "fact-1",
        nodeId: asNodeId("seat-a2"),
        taskId: AUTO,
        becomes: "done",
        byAutomation: true,
      } as const;
      await h.go(h.runner.onChange(CANVAS, done));
      expect(await h.history()).toEqual([]);
      await h.go(h.runner.onChange(CANVAS, { ...done, key: "fact-2", byAutomation: false }));
      expect(await h.history()).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it("hears a from-less signal only from seats in its targets", async () => {
    const blocked = automation({ trigger: { kind: "change", on: { kind: "signal", signal: "blocked" } } });
    const h = await harness(blocked);
    try {
      await h.go(h.runner.onChange(CANVAS, { kind: "signal", key: "s-1", seat: asNodeId("seat-b"), signal: "blocked" }));
      expect(await h.history()).toEqual([]);
      await h.go(h.runner.onChange(CANVAS, { kind: "signal", key: "s-2", seat: asNodeId("seat-a2"), signal: "blocked" }));
      expect(await h.history()).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
});

describe("an interrupted firing", () => {
  it("stays claimed when an action dies before settle, and counts against the limits", async () => {
    const h = await harness(automation({ limits: { minIntervalMs: 0, maxPerHour: 1 } }));
    try {
      const dying = makeAutomationRunner({
        canvas: () => canvas,
        holds: () => true,
        perform: () => Effect.die("crash"),
        mintFiringId: () => FiringId.make("01M5ESKJFC1A88R1MH1NEZ9999"),
        now: () => h.clock.now,
      });
      await expect(h.go(dying.onRun(CANVAS, AUTO))).rejects.toBeDefined();
      expect((await h.history()).map((f) => f.outcome)).toEqual([{ kind: "claimed" }]);
      const next = await h.go(h.runner.onRun(CANVAS, AUTO));
      expect(next?.outcome).toEqual({ kind: "skipped", reason: "max_per_hour" });
    } finally {
      await h.close();
    }
  });
});

describe("onRun", () => {
  it("fires a disabled automation by hand, recorded as run", async () => {
    const h = await harness(automation({ enabled: false }));
    try {
      const firing = await h.go(h.runner.onRun(CANVAS, AUTO));
      expect(firing).toMatchObject({ cause: { kind: "run" }, outcome: { kind: "fired" } });
      expect(h.performed).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
});
