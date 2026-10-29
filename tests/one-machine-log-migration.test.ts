// vitest-lane: alone
/**
 * State migration 14 -> 15 drops the tables that carried tasks between
 * machines and rebuilds the work log without its links to them. Proven with
 * rows in the log and in the tables that go: every fact survives with its
 * identity, hash and body, every other table is untouched, and the engine
 * opens the result.
 *
 * The version-14 database is made at version 14 (a fresh database takes the
 * witness schema whole), not by replaying a shipped fixture: it lives in
 * memory, so no path is shared with any other test, and rows seeded before the
 * step stand in for what a shipped database holds. The engine case alone opens
 * a shipped version-13 database, since the whole replay to the head is what it
 * proves; that case runs in its own lane.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V14_IDENTITY,
  STATE_SCHEMA_V15_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import {
  ONE_MACHINE_LOG_REMOVED_TABLES,
  ONE_MACHINE_LOG_RETIRED_FACT_COLUMNS,
} from "../src/main/junto/work/migrate-one-machine-log";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { STATE_SCHEMA_V14_SQL, STATE_SCHEMA_V15_SQL } from "./fixtures/state-v13/schema";

const fixture = { fileName: "command-center-v13.db", sha256: "c31b3097c2c2c56130d9b5e3d9fce4dd1bc289e40e58feab2623801cf0e2072d" } as const;

type Row = Readonly<Record<string, SQLOutputValue>>;

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const copyOf = async (fileName: string): Promise<string> => {
  const source = fileURLToPath(new URL(`./fixtures/state-v13/${fileName}`, import.meta.url));
  dir = await mkdtemp(join(tmpdir(), "junto-one-machine-log-"));
  const path = join(dir, "junto.db");
  await copyFile(source, path);
  return path;
};

/** A version-14 database, fresh and in memory. */
const openAt14 = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:", { allowExtension: false, enableForeignKeyConstraints: true });
  expect(migrateStateSchema(database, versionFourteenPlan)).toMatchObject({ schemaVersion: 14, ...STATE_SCHEMA_V14_IDENTITY });
  return database;
};

const COMMAND_SHA = "a".repeat(64);
const CLAIMED_SHA = "b".repeat(64);
const DISPOSITION_SHA = "c".repeat(64);
const CANVAS_FACT_SHA = "d".repeat(64);
const HISTORICAL_SHA = "e".repeat(64);

/**
 * What a shipped log holds: a command from another machine, the fact it was
 * applied as (on a command basis) and its disposition, a fact on a canvas
 * basis, and a historical fact after it.
 */
const seedLog = (database: DatabaseSync): void => {
  database.exec(`
    INSERT INTO station_known_installations (installation_id, registered_at) VALUES
      ('command-center-v1', '2026-07-28T12:00:00.000Z'), ('remote-v1', '2026-07-28T12:00:00.000Z');
    INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at, seq) VALUES ('factory', 'canvas-1', 'now', 'now', 3);
    INSERT INTO work_event_sequences (event_home, entity_home, last_seq) VALUES
      ('command-center-v1', 'remote-v1', '1'), ('remote-v1', 'remote-v1', '4');
  `);
  const event = database.prepare(`
    INSERT INTO work_events (event_home, entity_home, seq, protocol, record_type, item_kind, item_id, item_canvas_name,
      item_node_id, operation, content_sha256, origin_at, received_at)
    VALUES (?, 'remote-v1', ?, 'junto/work/v1', ?, 'task', 'task-v1-remote', 'factory', 'tasks', ?, ?, ?, '2026-07-28T12:00:05.000Z')
  `);
  event.run("command-center-v1", "1", "command", "task.claim", COMMAND_SHA, "2026-07-28T12:00:00.000Z");
  event.run("remote-v1", "1", "fact", "task.claim", CLAIMED_SHA, "2026-07-28T12:00:01.000Z");
  event.run("remote-v1", "2", "disposition", "task.claim", DISPOSITION_SHA, "2026-07-28T12:00:02.000Z");
  event.run("remote-v1", "3", "fact", "task.transition", CANVAS_FACT_SHA, "2026-07-28T12:00:03.000Z");
  event.run("remote-v1", "4", "fact", "task.transition", HISTORICAL_SHA, "2026-07-28T12:00:04.000Z");
  database.prepare(`
    INSERT INTO work_commands (event_home, entity_home, seq, action_json)
    VALUES ('command-center-v1', 'remote-v1', '1', '{"operation":"task.claim","targetHome":"remote-v1"}')
  `).run();
  const fact = database.prepare(`
    INSERT INTO work_facts (event_home, entity_home, seq, predecessor_event_home, predecessor_entity_home, predecessor_seq,
      result_json, basis_kind, basis_canvas_name, basis_canvas_seq,
      basis_command_event_home, basis_command_entity_home, basis_command_seq, basis_command_sha256)
    VALUES ('remote-v1', 'remote-v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  fact.run("1", null, null, null, '{"operation":"task.claim","state":"working"}', "command", null, null, "command-center-v1", "remote-v1", "1", COMMAND_SHA);
  fact.run("3", "remote-v1", "remote-v1", "1", '{"operation":"task.transition","state":"input-required"}', "canvas", "factory", 3, null, null, null, null);
  fact.run("4", "remote-v1", "remote-v1", "3", '{"operation":"task.transition","state":"completed"}', "historical", null, null, null, null, null, null);
  database.prepare(`
    INSERT INTO work_dispositions (event_home, entity_home, seq, status, command_event_home, command_entity_home, command_seq,
      command_sha256, fact_event_home, fact_entity_home, fact_seq, fact_sha256)
    VALUES ('remote-v1', 'remote-v1', '2', 'applied', 'command-center-v1', 'remote-v1', '1', ?, 'remote-v1', 'remote-v1', '1', ?)
  `).run(COMMAND_SHA, CLAIMED_SHA);
};

const tableNames = (database: DatabaseSync): string[] =>
  (
    database
      .prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'state_schema_identity'
          ORDER BY name`,
      )
      .all() as unknown as ReadonlyArray<{ readonly name: SQLOutputValue }>
  ).map(({ name }) => String(name));

const rowsOf = (database: DatabaseSync, table: string): Row[] =>
  (database.prepare(`SELECT * FROM "${table}"`).all() as unknown as Row[])
    .map((row) => ({ ...row }))
    .sort((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : 1);

const versionFourteenPlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 14,
  currentSchemaSql: STATE_SCHEMA_V14_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 14),
};

const versionFifteenPlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 15,
  currentSchemaSql: STATE_SCHEMA_V15_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 15),
};

/** What step 14 -> 15 must leave of one version-14 fact row. */
const survivingFact = (row: Row): Row => {
  const kept = Object.fromEntries(
    Object.entries(row).filter(([column]) => !(ONE_MACHINE_LOG_RETIRED_FACT_COLUMNS as ReadonlyArray<string>).includes(column)),
  );
  return row.basis_kind === "canvas"
    ? kept
    : { ...kept, basis_kind: "historical", basis_canvas_name: null, basis_canvas_seq: null };
};

describe("state migration 14 -> 15 (the work log of one machine)", () => {
  it("freezes the witnesses the step starts from and ends at", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V14_SQL)).toEqual(STATE_SCHEMA_V14_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V15_SQL)).toEqual(STATE_SCHEMA_V15_IDENTITY);
  });

  it("keeps every fact and drops only the dead tables", () => {
    const database = openAt14();
    try {
      seedLog(database);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 14 });
      const tablesBefore = tableNames(database);
      const before = new Map(tablesBefore.map((table) => [table, rowsOf(database, table)]));
      const facts = before.get("work_facts")!;
      expect(facts.map((row) => row.basis_kind).sort()).toEqual(["canvas", "command", "historical"]);
      expect(before.get("work_events")).toHaveLength(5);
      expect(before.get("work_commands")).toHaveLength(1);
      expect(before.get("work_dispositions")).toHaveLength(1);
      for (const table of ONE_MACHINE_LOG_REMOVED_TABLES) expect(tablesBefore).toContain(table);

      const result = migrateStateSchema(database, versionFifteenPlan);
      expect(result).toMatchObject({ previousVersion: 14, schemaVersion: 15 });
      expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V15_IDENTITY);
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      const removed = new Set<string>(ONE_MACHINE_LOG_REMOVED_TABLES);
      expect(tableNames(database)).toEqual(tablesBefore.filter((table) => !removed.has(table)));

      expect(rowsOf(database, "work_facts")).toEqual(
        facts.map(survivingFact).sort((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : 1),
      );
      const factKeys = new Set(facts.map((row) => `${row.event_home}\u0000${row.entity_home}\u0000${row.seq}`));
      expect(rowsOf(database, "work_events")).toEqual(
        before
          .get("work_events")!
          .filter((row) => factKeys.has(`${row.event_home}\u0000${row.entity_home}\u0000${row.seq}`)),
      );
      for (const table of tablesBefore) {
        if (removed.has(table) || table === "work_facts" || table === "work_events") continue;
        expect(rowsOf(database, table), table).toEqual(before.get(table));
      }

      // The schema no longer refuses a fact minted at another canvas seq: the
      // check stays where a fact is minted.
      expect(
        database.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'work_fact_authorial_basis_resolves'").get(),
      ).toEqual({ n: 0 });
      expect(migrateStateSchema(database, versionFifteenPlan)).toMatchObject({ previousVersion: 15, initialized: false });
    } finally {
      database.close();
    }
  });

  it(`opens ${fixture.fileName} through the engine and reads its facts`, async () => {
    const path = await copyOf(fixture.fileName);
    expect(createHash("sha256").update(await readFile(path)).digest("hex")).toBe(fixture.sha256);
    const runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(path)));
    try {
      const counts = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const version = yield* sql.unsafe<{ user_version: number }>("PRAGMA user_version");
          const facts = yield* sql.unsafe<{ n: number }>("SELECT count(*) AS n FROM work_facts");
          return { version: version[0]!.user_version, facts: facts[0]!.n };
        }),
      );
      expect(counts.version).toBe(CURRENT_STATE_SCHEMA_VERSION);
      expect(counts.facts).toBeGreaterThan(0);
    } finally {
      await runtime.dispose();
    }
  });
});
