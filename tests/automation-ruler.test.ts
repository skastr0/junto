import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import { AutomationRepository, makeAutomationRepositoryLive } from "../src/main/junto/automation/repository";
import { submitAutomationCommand } from "../src/main/junto/automation/ruler";
import { AUTOMATION_STATE_SCHEMA_SQL } from "../src/main/junto/automation/state-schema";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import { RESOURCE_RULINGS_STATE_SCHEMA_SQL } from "../src/main/junto/work/resource-rulings-schema";
import { writeRuling } from "../src/main/junto/work/resource-rulings";
import type { RecordRulingInput } from "../src/main/junto/work/repository";
import { RulingRecorder } from "../src/main/junto/work/ruling-recorder";
import { AutomationId, type AutomationDefinition, type AutomationOp } from "../src/shared/automation";
import type { AutomationEnv } from "../src/shared/automation-domain";
import type { InstallationId } from "../src/shared/installation-id";
import { asNodeId } from "../src/shared/physics/schema";
import type { ResourceActor, ResourceCommand, RulingContext } from "../src/shared/resource-command";
import { OpId } from "../src/shared/work-ids";

const ID = Schema.decodeUnknownSync(AutomationId)("01M5ESKJFC1A88R1MH1NEZWJ2Q");
const opId = Schema.decodeUnknownSync(OpId);
const NODE = asNodeId("automations-1");
const A = asNodeId("agent-a");
const WRITER = "mini" as InstallationId;
const operator: ResourceActor = { kind: "operator" };

const definition: AutomationDefinition = {
  name: "Standup",
  trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" },
  then: [{ kind: "mail", to: { kind: "seat", nodeId: A }, text: "Plan?" }],
  limits: { minIntervalMs: 60_000, maxPerHour: 12 },
};

const env: AutomationEnv = { targetsOf: () => new Set([A]), isOverseer: () => false };
const context: RulingContext = { inReach: () => true };

const command = (op: AutomationOp, id: string, actor: ResourceActor = operator): ResourceCommand<AutomationOp> => ({
  opId: opId(id),
  canvasName: "factory",
  actor,
  target: { kind: "automation", nodeId: NODE, ...(op.kind === "create" ? {} : { itemId: ID }) },
  basis: null,
  after: [],
  op,
});

const harness = () => {
  const database = new DatabaseSync(":memory:");
  database.exec(AUTOMATION_STATE_SCHEMA_SQL);
  database.exec(RESOURCE_RULINGS_STATE_SCHEMA_SQL);
  const recorded: Array<RecordRulingInput> = [];
  const sql = Layer.effect(SqlClient.SqlClient, makeSqliteClient(database)).pipe(Layer.provide(Reactivity.layer));
  // The real recorder writes the row and the exchange fact; this one writes the row.
  const recorder = Layer.effect(
    RulingRecorder,
    Effect.gen(function* () {
      const client = yield* SqlClient.SqlClient;
      return RulingRecorder.of({
        record: (input) =>
          writeRuling(client, { canvas: input.canvasName, writer: input.writer, command: input.command, record: input.record }).pipe(
            Effect.tap(() => Effect.sync(() => recorded.push(input))),
            Effect.asVoid,
            Effect.orDie,
          ),
      });
    }),
  );
  const runtime = ManagedRuntime.make(Layer.mergeAll(makeAutomationRepositoryLive(), recorder).pipe(Layer.provideMerge(sql)));
  const submit = (c: ResourceCommand<AutomationOp>) =>
    runtime.runPromise(submitAutomationCommand(WRITER, c, context, env));
  const list = () => runtime.runPromise(Effect.flatMap(AutomationRepository, (r) => r.list("factory", NODE)));
  const close = async () => {
    await runtime.dispose();
    database.close();
  };
  return { submit, list, recorded, close };
};

describe("submitAutomationCommand", () => {
  it("applies a create, stores the head and records one ruling", async () => {
    const h = harness();
    try {
      const outcome = await h.submit(command({ kind: "create", automationId: ID, enabled: true, definition }, "01M5ESMJNGY0103BZJ3NYHP5G1"));
      expect(outcome).toMatchObject({ kind: "applied", automation: { automationId: ID, author: { kind: "operator" }, enabled: true } });
      expect((await h.list()).map((a) => a.name)).toEqual(["Standup"]);
      expect(h.recorded).toHaveLength(1);
      expect(h.recorded[0]).toMatchObject({ kind: "automation", record: { kind: "applied", automationId: ID } });
    } finally {
      await h.close();
    }
  });

  it("answers a replay from the stored ruling and writes nothing", async () => {
    const h = harness();
    try {
      const create = command({ kind: "create", automationId: ID, enabled: true, definition }, "01M5ESMJNGY0103BZJ3NYHP5G1");
      await h.submit(create);
      const again = await h.submit(create);
      expect(again).toMatchObject({ kind: "applied", facts: [] });
      expect(h.recorded).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it("records a refusal and keeps nothing", async () => {
    const h = harness();
    try {
      const plain: ResourceActor = { kind: "seat", seatId: "seat-plain" as never, nodeId: asNodeId("agent-plain") };
      const refused = await h.submit(command({ kind: "create", automationId: ID, enabled: true, definition }, "01M5ESMJNGY0103BZJ3NYHP5G2", plain));
      expect(refused).toMatchObject({ kind: "refused", error: { details: { reason: "not_permitted" } } });
      expect(await h.list()).toEqual([]);
      expect(h.recorded[0]).toMatchObject({ record: { kind: "refused" } });
      // The replay is the same refusal.
      expect(await h.submit(command({ kind: "create", automationId: ID, enabled: true, definition }, "01M5ESMJNGY0103BZJ3NYHP5G2", plain))).toMatchObject({
        kind: "refused",
      });
      expect(h.recorded).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it("disables and archives an automation it holds", async () => {
    const h = harness();
    try {
      await h.submit(command({ kind: "create", automationId: ID, enabled: true, definition }, "01M5ESMJNGY0103BZJ3NYHP5G1"));
      const off = await h.submit(command({ kind: "set-enabled", enabled: false }, "01M5ESMJNGY0103BZJ3NYHP5G3"));
      expect(off).toMatchObject({ kind: "applied", automation: { enabled: false }, archived: false });
      const gone = await h.submit(command({ kind: "archive" }, "01M5ESMJNGY0103BZJ3NYHP5G4"));
      expect(gone).toMatchObject({ kind: "applied", archived: true });
      expect(await h.list()).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
