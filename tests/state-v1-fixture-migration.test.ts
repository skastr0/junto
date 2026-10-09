/**
 * State migration 14 -> 15 drops the tables that carried tasks between
 * machines and rebuilds the work log without its links to them. Proven on both
 * shipped version-1 databases, brought to version 14 by the real steps, with
 * rows in the log and in the tables that go: every fact survives with its
 * identity, hash and body, every other table is untouched, and the engine
 * opens the result.
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
  CURRENT_STATE_SCHEMA_IDENTITY,
  CURRENT_STATE_SCHEMA_VERSION,
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V14_IDENTITY,
  STATE_SCHEMA_V15_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import {
  ONE_MACHINE_LOG_REMOVED_TABLES,
  ONE_MACHINE_LOG_RETIRED_FACT_COLUMNS,
} from "../src/main/junto/work/migrate-one-machine-log";
import { WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { STATE_SCHEMA_V14_SQL } from "./fixtures/state-v1/schema";

const fixtures = [
  { fileName: "command-center-v1.db", sha256: "ba3fd2b90591bd83f3706b153799c0f325ab47bc10b273be5fdcccd9155a2615" },
  { fileName: "remote-v1.db", sha256: "2d9e0be7c9571292ad872e45b415efa8fbdfa91198ab0a178f1ae31d12c6588a" },
] as const;

type Row = Readonly<Record<string, SQLOutputValue>>;

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const copyOf = async (fileName: string): Promise<string> => {
  const source = fileURLToPath(new URL(`./fixtures/state-v1/${fileName}`, import.meta.url));
  dir = await mkdtemp(join(tmpdir(), "junto-one-machine-log-"));
  const path = join(dir, "junto.db");
  await copyFile(source, path);
  return path;
};

const open = (path: string): DatabaseSync => {
  const database = new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
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
  it("freezes the version-fourteen witness the step starts from and names the head", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V14_SQL)).toEqual(STATE_SCHEMA_V14_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_VERSION).toBe(15);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(STATE_SCHEMA_V15_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(expectedStateSchemaIdentity(STATE_SCHEMA_SQL));
  });

  it.each(fixtures)("keeps every fact of $fileName and drops only the dead tables", async ({ fileName, sha256 }) => {
    const path = await copyOf(fileName);
    expect(createHash("sha256").update(await readFile(path)).digest("hex")).toBe(sha256);
    const database = open(path);
    try {
      migrateStateSchema(database, versionFourteenPlan);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 14 });
      const tablesBefore = tableNames(database);
      const before = new Map(tablesBefore.map((table) => [table, rowsOf(database, table)]));
      const facts = before.get("work_facts")!;
      expect(facts.length).toBeGreaterThan(0);
      for (const table of ONE_MACHINE_LOG_REMOVED_TABLES) expect(tablesBefore).toContain(table);

      const result = migrateStateSchema(database);
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
      expect(migrateStateSchema(database)).toMatchObject({ previousVersion: 15, initialized: false });
    } finally {
      database.close();
    }
  });

  it.each(fixtures)("opens $fileName through the engine and reads its work", async ({ fileName }) => {
    const path = await copyOf(fileName);
    const runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(path)));
    try {
      const counts = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const repository = yield* WorkRepository;
          const version = yield* sql.unsafe<{ user_version: number }>("PRAGMA user_version");
          const facts = yield* sql.unsafe<{ n: number }>("SELECT count(*) AS n FROM work_facts");
          const work = yield* repository.kernelWork("factory");
          return { version: version[0]!.user_version, facts: facts[0]!.n, tasks: work.tasks.size };
        }),
      );
      expect(counts.version).toBe(CURRENT_STATE_SCHEMA_VERSION);
      expect(counts.facts).toBeGreaterThan(0);
      expect(counts.tasks).toBeGreaterThanOrEqual(0);
    } finally {
      await runtime.dispose();
    }
  });
});
