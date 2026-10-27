import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import { AUTOMATION_RULING_CURSORS_SQL, AUTOMATION_STATE_SCHEMA_SQL } from "../src/main/junto/automation/state-schema";
import { RESOURCE_RULINGS_STATE_SCHEMA_SQL } from "../src/main/junto/work/resource-rulings-schema";
import { AutomationRepository, FIRINGS_KEPT, makeAutomationRepositoryLive } from "../src/main/junto/automation/repository";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import { type Automation, AutomationId, type Firing, FiringId, AutomationVersion } from "../src/shared/automation";
import { asNodeId } from "../src/shared/physics/schema";

const id = Schema.decodeUnknownSync(AutomationId);
const firingId = Schema.decodeUnknownSync(FiringId);
const AUTO = id("01M5ESKJFC1A88R1MH1NEZWJ2Q");
const NODE = asNodeId("automations-1");

const automation: Automation = {
  automationId: AUTO,
  nodeId: NODE,
  author: { kind: "operator" },
  version: AutomationVersion.make(1),
  name: "Standup",
  enabled: true,
  trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" },
  then: [{ kind: "mail", to: { kind: "seat", nodeId: asNodeId("agent-a") }, text: "Plan?" }],
  limits: { minIntervalMs: 60_000, maxPerHour: 12 },
};

const run = async <A, E>(program: Effect.Effect<A, E, AutomationRepository | SqlClient.SqlClient>): Promise<A> => {
  const database = new DatabaseSync(":memory:");
  database.exec(AUTOMATION_STATE_SCHEMA_SQL);
  database.exec(AUTOMATION_RULING_CURSORS_SQL);
  database.exec(RESOURCE_RULINGS_STATE_SCHEMA_SQL);
  // Only the columns the ruling read joins on; the real tables carry more.
  database.exec(`
    CREATE TABLE installation (singleton INTEGER PRIMARY KEY, installation_id TEXT NOT NULL);
    INSERT INTO installation VALUES (1, 'mini');
    CREATE TABLE work_events (event_home TEXT, entity_home TEXT, seq TEXT, item_kind TEXT, item_id TEXT, item_canvas_name TEXT);
  `);
  const sql = Layer.effect(SqlClient.SqlClient, makeSqliteClient(database)).pipe(Layer.provide(Reactivity.layer));
  const runtime = ManagedRuntime.make(makeAutomationRepositoryLive().pipe(Layer.provideMerge(sql)));
  try {
    return await runtime.runPromise(program);
  } finally {
    await runtime.dispose();
    database.close();
  }
};

const firing = (ulid: string, at: number, cause: Firing["cause"], fired = true): Firing => ({
  firingId: firingId(ulid),
  automationId: AUTO,
  at,
  cause,
  outcome: fired ? { kind: "fired", actions: [] } : { kind: "skipped", reason: "condition_unmet" },
});

describe("AutomationRepository", () => {
  it("folds facts into heads and lists the live ones", () => run(Effect.gen(function* () {
    const repository = yield* AutomationRepository;
    yield* repository.applyFacts("factory", [{ fact: "automation.created", automation, at: 10 }]);
    yield* repository.applyFacts("factory", [{ fact: "automation.enabled", automationId: AUTO, enabled: false, at: 20 }]);
    expect(yield* repository.list("factory", NODE)).toEqual([{ ...automation, enabled: false }]);
    expect((yield* repository.loadState("factory")).get(AUTO)).toMatchObject({ archived: false, updatedAt: 20 });
    yield* repository.applyFacts("factory", [{ fact: "automation.archived", automationId: AUTO, at: 30 }]);
    expect(yield* repository.list("factory", NODE)).toEqual([]);
    expect((yield* repository.loadState("factory")).get(AUTO)?.archived).toBe(true);
    expect(yield* repository.list("other", NODE)).toEqual([]);
  })));

  it("keeps a cursor per automation", () => run(Effect.gen(function* () {
    const repository = yield* AutomationRepository;
    expect(yield* repository.cursor("factory", AUTO)).toBeUndefined();
    yield* repository.setCursor("factory", AUTO, 100);
    yield* repository.setCursor("factory", AUTO, 200);
    expect(yield* repository.cursor("factory", AUTO)).toBe(200);
  })));

  it("claims a slot once, even under a new firing id", () => run(Effect.gen(function* () {
    const repository = yield* AutomationRepository;
    const slot = { kind: "schedule", slot: 60_000, missed: 0 } as const;
    expect(yield* repository.claimFiring("factory", firing("01M5ESKJFC1A88R1MH1NEZWJ20", 1, slot))).toEqual({ _tag: "Claimed" });
    expect(yield* repository.claimFiring("factory", firing("01M5ESKJFC1A88R1MH1NEZWJ21", 2, slot))).toEqual({ _tag: "Duplicate" });
    const run1 = firing("01M5ESKJFC1A88R1MH1NEZWJ22", 3, { kind: "run" });
    const run2 = firing("01M5ESKJFC1A88R1MH1NEZWJ23", 4, { kind: "run" });
    expect(yield* repository.claimFiring("factory", run1)).toEqual({ _tag: "Claimed" });
    expect(yield* repository.claimFiring("factory", run2)).toEqual({ _tag: "Claimed" });
    expect((yield* repository.firings("factory", { automationId: AUTO })).map((f) => f.at)).toEqual([4, 3, 1]);
  })));

  it("counts only firings that fired, and settles an outcome", () => run(Effect.gen(function* () {
    const repository = yield* AutomationRepository;
    const fired = firing("01M5ESKJFC1A88R1MH1NEZWJ30", 100, { kind: "change", key: "a:1" });
    yield* repository.claimFiring("factory", fired);
    yield* repository.claimFiring("factory", firing("01M5ESKJFC1A88R1MH1NEZWJ31", 200, { kind: "change", key: "a:2" }, false));
    expect(yield* repository.firedSince("factory", AUTO, 0)).toEqual([100]);
    // A claimed firing may have run its actions, so it counts too.
    yield* repository.claimFiring("factory", { ...firing("01M5ESKJFC1A88R1MH1NEZWJ32", 300, { kind: "change", key: "a:3" }), outcome: { kind: "claimed" } });
    expect([...(yield* repository.firedSince("factory", AUTO, 0))].sort()).toEqual([100, 300]);
    yield* repository.settleFiring("factory", fired, { kind: "fired", actions: [{ index: 0, ruling: "applied" }] });
    const [, , settled] = yield* repository.firings("factory", { automationId: AUTO });
    expect(settled?.outcome).toEqual({ kind: "fired", actions: [{ index: 0, ruling: "applied" }] });
  })));

  it("pages newest first", () => run(Effect.gen(function* () {
    const repository = yield* AutomationRepository;
    const ids = ["01M5ESKJFC1A88R1MH1NEZWJ40", "01M5ESKJFC1A88R1MH1NEZWJ41", "01M5ESKJFC1A88R1MH1NEZWJ42"];
    for (const [index, ulid] of ids.entries()) {
      yield* repository.claimFiring("factory", firing(ulid, index, { kind: "poll", slot: index * 60_000, missed: 0 }));
    }
    const page = yield* repository.firings("factory", { automationId: AUTO, limit: 2 });
    expect(page.map((f) => f.firingId)).toEqual([ids[2], ids[1]]);
    const next = yield* repository.firings("factory", { automationId: AUTO, before: page[1]!.firingId, limit: 2 });
    expect(next.map((f) => f.firingId)).toEqual([ids[0]]);
  })));

  it("fails a firing id collision instead of calling it a Duplicate", () => run(Effect.gen(function* () {
    const repository = yield* AutomationRepository;
    yield* repository.claimFiring("factory", firing("01M5ESKJFC1A88R1MH1NEZWJ50", 1, { kind: "change", key: "a" }));
    const collided = yield* Effect.result(
      repository.claimFiring("factory", firing("01M5ESKJFC1A88R1MH1NEZWJ50", 2, { kind: "change", key: "b" })),
    );
    expect(collided).toMatchObject({ _tag: "Failure", failure: { _tag: "AutomationPersistenceError", operation: "claim-firing" } });
  })));

  it("keeps the newest firings and never prunes the cursor's slot", () => run(Effect.gen(function* () {
    const repository = yield* AutomationRepository;
    const ulid = (n: number) => `01M5ESKJFC1A88R1MH1N${String(n).padStart(6, "0")}`;
    yield* repository.claimFiring("factory", firing(ulid(0), 0, { kind: "schedule", slot: 60_000, missed: 0 }));
    yield* repository.setCursor("factory", AUTO, 60_000);
    for (let n = 1; n <= FIRINGS_KEPT + 1; n += 1) {
      yield* repository.claimFiring("factory", firing(ulid(n), n, { kind: "change", key: `k${n}` }));
    }
    const sql = yield* SqlClient.SqlClient;
    const [[count]] = (yield* sql`SELECT count(*) FROM automation_firings`.values) as unknown as [[number]];
    expect(count).toBe(FIRINGS_KEPT + 1);
    // The cursor's slot survives; the oldest change firing went.
    expect(yield* repository.claimFiring("factory", firing(ulid(9_999_99), 5, { kind: "schedule", slot: 60_000, missed: 0 }))).toEqual({
      _tag: "Duplicate",
    });
    expect(yield* repository.claimFiring("factory", firing(ulid(9_999_98), 5, { kind: "change", key: "k1" }))).toEqual({
      _tag: "Claimed",
    });
  })));

  it("reads task rulings in landing order, and says a page was full even when a row in it does not decode", () => run(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const T = "01M5ESKJFC1A88R1MH1NEZWJ50";
    // Seq 9 lands before seq 10, whatever their op ids say; seq 10's record is missing its node.
    const rulings: ReadonlyArray<readonly [string, string, string, string]> = [
      ["9", "01M5ESKJFC1A88R1MH1NEZWJ62", JSON.stringify({ kind: "applied", taskId: T, node: "tasks-1", became: "working" }), "seat"],
      ["10", "01M5ESKJFC1A88R1MH1NEZWJ61", JSON.stringify({ kind: "applied", taskId: T, became: "done" }), "operator"],
      ["11", "01M5ESKJFC1A88R1MH1NEZWJ63", JSON.stringify({ kind: "applied", taskId: T, node: "tasks-1", became: "backlog" }), "automation"],
    ];
    for (const [seq, opId, json, actor] of rulings) {
      yield* sql`INSERT INTO work_events VALUES ('mini', 'mini', ${seq}, 'ruling', ${opId}, 'factory')`;
      yield* sql.unsafe(
        `INSERT INTO resource_rulings (canvas_name, writer, op_id, kind, ruling_json, actor_kind, actor_node_id) VALUES ('factory', 'mini', ?, 'applied', ?, ?, ${actor === "seat" ? "'agent-a'" : "NULL"})`,
        [opId, json, actor],
      );
    }
    const repository = yield* AutomationRepository;
    const first = yield* repository.taskRulingsSince("factory", "0", 2);
    expect(first.rulings.map((r) => r.became)).toEqual(["working"]);
    expect(first).toMatchObject({ through: "10", more: true });
    const rest = yield* repository.taskRulingsSince("factory", first.through, 2);
    expect(rest).toMatchObject({ through: "11", more: false, rulings: [{ became: "backlog", byAutomation: true }] });
  })));

  it("reads each task a ruling derived as a new task on its own board, before the task it ruled", () => run(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const T = "01M5ESKJFC1A88R1MH1NEZWJ50";
    const D1 = "01M5ESKJFC1A88R1MH1NEZWJ51";
    const D2 = "01M5ESKJFC1A88R1MH1NEZWJ52";
    const record = {
      kind: "applied",
      taskId: T,
      node: "tasks-1",
      became: "done",
      derived: [{ taskId: D1, node: "tasks-2", became: "backlog" }, { taskId: D2, node: "tasks-3", became: "backlog" }],
    };
    yield* sql`INSERT INTO work_events VALUES ('mini', 'mini', '9', 'ruling', '01M5ESKJFC1A88R1MH1NEZWJ62', 'factory')`;
    yield* sql`INSERT INTO resource_rulings (canvas_name, writer, op_id, kind, ruling_json, actor_kind, actor_node_id)
      VALUES ('factory', 'mini', '01M5ESKJFC1A88R1MH1NEZWJ62', 'applied', ${JSON.stringify(record)}, 'seat', 'agent-a')`;
    const repository = yield* AutomationRepository;
    const read = yield* repository.taskRulingsSince("factory", "0", 10);
    expect(read.rulings.map((r) => [r.taskId, r.node, r.became])).toEqual([
      [D1, "tasks-2", "backlog"],
      [D2, "tasks-3", "backlog"],
      [T, "tasks-1", "done"],
    ]);
  })));
});
