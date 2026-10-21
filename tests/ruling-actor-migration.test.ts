/**
 * State migration 26 -> 27 puts the actor on resource rulings. Proven on both
 * shipped fixtures brought to version 26 by the real steps: every other row
 * survives as it was, the rulings table comes back with its actor columns, a
 * ruling held before the step is kept as the operator's, and `writeRuling`
 * fills the actor from the command.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Reactivity } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it } from "vitest";
import { migrateMachineNames } from "../src/main/junto/state/migrate-machine-names";
import {
  CURRENT_STATE_SCHEMA_IDENTITY,
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V26_IDENTITY,
  STATE_SCHEMA_V27_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import { rulingActorOf, writeRuling } from "../src/main/junto/work/resource-rulings";
import { RESOURCE_RULINGS_STATE_SCHEMA_SQL } from "../src/main/junto/work/resource-rulings-schema";
import type { InstallationId } from "../src/shared/installation-id";
import { asNodeId } from "../src/shared/physics/schema";
import type { ResourceActor } from "../src/shared/resource-command";
import { ItemId, OpId } from "../src/shared/work-ids";
import { STATE_SCHEMA_V26_SQL, STATE_SCHEMA_V27_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-ruling-actor-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v13/${fixture}`, import.meta.url)), path);
  const database = new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
};

const snapshot = (database: DatabaseSync) =>
  Object.fromEntries(
    (
      database
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'state_schema_identity'
            ORDER BY name`,
        )
        .all() as unknown as ReadonlyArray<{ readonly name: SQLOutputValue }>
    ).map(({ name }) => [String(name), database.prepare(`SELECT * FROM "${String(name)}" ORDER BY 1, 2`).all()]),
  );

/** The real steps, with the name first boot would give fixed so the proof does not depend on where it runs. */
const named = <T extends { readonly toVersion: number; readonly migrate: (database: DatabaseSync) => void }>(step: T): T =>
  step.toVersion === 21 ? { ...step, migrate: (database: DatabaseSync) => migrateMachineNames(database, "macbook") } : step;

const planTo = (version: number, currentSchemaSql: string) => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version).map(named),
});

const OP = "01J0000000000000000000000B";
const columns = (database: DatabaseSync) =>
  (database.prepare("SELECT name FROM pragma_table_info('resource_rulings') ORDER BY cid").all() as unknown as ReadonlyArray<{ name: string }>).map(
    ({ name }) => name,
  );

describe("state migration 26 -> 27 (the actor on resource rulings)", () => {
  it("freezes the witness the step starts from and names the head", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V26_SQL)).toEqual(STATE_SCHEMA_V26_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V27_SQL)).toEqual(STATE_SCHEMA_V27_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(STATE_SCHEMA_V27_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(expectedStateSchemaIdentity(STATE_SCHEMA_SQL));
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "rebuilds the rulings table on %s and leaves every other row as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, planTo(26, STATE_SCHEMA_V26_SQL));
        const before = snapshot(database);
        expect((before.work_events as unknown[]).length).toBeGreaterThan(0);

        const result = migrateStateSchema(database, planTo(27, STATE_SCHEMA_V27_SQL));
        expect(result).toMatchObject({ previousVersion: 26, schemaVersion: 27 });
        expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V27_IDENTITY);
        expect(snapshot(database)).toEqual(before);
        expect(columns(database)).toEqual(["canvas_name", "writer", "op_id", "kind", "ruling_json", "actor_kind", "actor_node_id"]);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        database.close();
      }
    },
  );

  it("carries a ruling from before the step over as the operator's, with no node id", async () => {
    const database = await openCopy("command-center-v13.db");
    try {
      migrateStateSchema(database, planTo(26, STATE_SCHEMA_V26_SQL));
      const json = JSON.stringify({ kind: "applied", taskId: OP });
      database
        .prepare(`INSERT INTO resource_rulings (canvas_name, writer, op_id, kind, ruling_json) VALUES ('factory', 'mini', ?, 'applied', ?)`)
        .run(OP, json);
      migrateStateSchema(database, planTo(27, STATE_SCHEMA_V27_SQL));
      expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V27_IDENTITY);
      expect(database.prepare("SELECT * FROM resource_rulings").all()).toEqual([
        { canvas_name: "factory", writer: "mini", op_id: OP, kind: "applied", ruling_json: json, actor_kind: "operator", actor_node_id: null },
      ]);
    } finally {
      database.close();
    }
  });

  it("holds a seat to its node id, and the operator and an automation to none", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(RESOURCE_RULINGS_STATE_SCHEMA_SQL);
      const insert = database.prepare(
        `INSERT INTO resource_rulings (canvas_name, writer, op_id, kind, ruling_json, actor_kind, actor_node_id)
         VALUES ('factory', 'mini', ?, 'applied', '{}', ?, ?)`,
      );
      const ids = ["01J0000000000000000000000C", "01J0000000000000000000000D", "01J0000000000000000000000E"];
      insert.run(ids[0]!, "seat", "agent-1");
      insert.run(ids[1]!, "operator", null);
      insert.run(ids[2]!, "automation", null);
      expect(() => insert.run("01J0000000000000000000000F", "seat", null)).toThrow();
      expect(() => insert.run("01J0000000000000000000000G", "operator", "agent-1")).toThrow();
      expect(() => insert.run("01J0000000000000000000000H", "automation", "automations-1")).toThrow();
      expect(() => insert.run("01J0000000000000000000000J", "phone", null)).toThrow();
      expect(() => insert.run("01J0000000000000000000000K", "seat", "")).toThrow();
    } finally {
      database.close();
    }
  });
});

describe("writeRuling, the one insert into resource_rulings", () => {
  const seat: ResourceActor = { kind: "seat", seatId: "seat-1" as never, nodeId: asNodeId("agent-1") };
  const automation: ResourceActor = { kind: "automation", nodeId: asNodeId("automations-1"), automationId: ItemId.make("01J0000000000000000000000Z") };

  it("takes the actor columns from the command's actor, exhaustively", () => {
    expect(rulingActorOf(seat)).toEqual({ actorKind: "seat", actorNodeId: "agent-1" });
    expect(rulingActorOf({ kind: "operator" })).toEqual({ actorKind: "operator", actorNodeId: null });
    expect(rulingActorOf(automation)).toEqual({ actorKind: "automation", actorNodeId: null });
  });

  it("writes the record as ruling_json, its kind as the kind column, and the actor beside it", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(RESOURCE_RULINGS_STATE_SCHEMA_SQL);
    const client = Layer.effect(SqlClient.SqlClient, makeSqliteClient(database)).pipe(Layer.provide(Reactivity.layer));
    const runtime = ManagedRuntime.make(client);
    try {
      const writer = "mini" as InstallationId;
      const applied = OpId.make("01J0000000000000000000000C");
      const refused = OpId.make("01J0000000000000000000000D");
      const error = { type: "Stale", message: "moved", details: { reason: "stale", retryable: true } } as const;
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* writeRuling(sql, { canvas: "factory", writer, command: { opId: applied, actor: seat }, record: { kind: "applied", taskId: applied } });
          yield* writeRuling(sql, { canvas: "factory", writer, command: { opId: refused, actor: { kind: "operator" } }, record: { kind: "refused", error, root: refused } });
        }),
      );
      expect(database.prepare("SELECT op_id, kind, ruling_json, actor_kind, actor_node_id FROM resource_rulings ORDER BY op_id").all()).toEqual([
        { op_id: applied, kind: "applied", ruling_json: JSON.stringify({ kind: "applied", taskId: applied }), actor_kind: "seat", actor_node_id: "agent-1" },
        { op_id: refused, kind: "refused", ruling_json: JSON.stringify({ kind: "refused", error, root: refused }), actor_kind: "operator", actor_node_id: null },
      ]);
    } finally {
      await runtime.dispose();
      database.close();
    }
  });
});
