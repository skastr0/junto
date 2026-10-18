/**
 * State migration 21 -> 22 adds the seat commits store (expand only). Proven
 * on both shipped fixtures brought to version 21 by the real steps: every row
 * already held survives, the new table starts empty, and the head names it.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateMachineNames } from "../src/main/junto/state/migrate-machine-names";
import {
  CURRENT_STATE_SCHEMA_IDENTITY,
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V21_IDENTITY,
  STATE_SCHEMA_V22_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { STATE_SCHEMA_V21_SQL } from "./fixtures/state-v1/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-seat-commits-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v1/${fixture}`, import.meta.url)), path);
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
    ).map(({ name }) => [String(name), database.prepare(`SELECT * FROM "${String(name)}"`).all()]),
  );

/** The real steps, with the name first boot would give fixed so the proof does not depend on where it runs. */
const named = <T extends { readonly toVersion: number; readonly migrate: (database: DatabaseSync) => void }>(step: T): T =>
  step.toVersion === 21 ? { ...step, migrate: (database: DatabaseSync) => migrateMachineNames(database, "macbook") } : step;

const versionTwentyOnePlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 21,
  currentSchemaSql: STATE_SCHEMA_V21_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 21).map(named),
};

const headPlan = { ...STATE_SCHEMA_MIGRATION_PLAN, migrations: STATE_SCHEMA_MIGRATIONS.map(named) };

describe("state migration 21 -> 22 (which seat made each commit)", () => {
  it("freezes the witness the step starts from and names the head", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V21_SQL)).toEqual(STATE_SCHEMA_V21_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(STATE_SCHEMA_V22_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(expectedStateSchemaIdentity(STATE_SCHEMA_SQL));
  });

  it.each(["command-center-v1.db", "remote-v1.db"])(
    "adds the table to %s and leaves every row already held as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, versionTwentyOnePlan);
        const before = snapshot(database);

        const result = migrateStateSchema(database, headPlan);
        expect(result).toMatchObject({ previousVersion: 21, schemaVersion: 22 });
        expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V22_IDENTITY);
        const { seat_commits: commits, ...rest } = snapshot(database);
        expect(rest).toEqual(before);
        expect(commits).toEqual([]);

        const insert = database.prepare(
          `INSERT INTO seat_commits(repo, sha, canvas_name, seat_id, session_id, observed_at)
           VALUES ('/work/repo', ?, 'factory', 'agent-1', ?, 1)`,
        );
        insert.run("a".repeat(40), "session-1");
        insert.run("b".repeat(64), null);
        // One seat per commit, and only a full lowercase hex sha.
        expect(() => insert.run("a".repeat(40), "session-2")).toThrow();
        expect(() => insert.run("A".repeat(40), null)).toThrow();
        expect(() => insert.run("abc123", null)).toThrow();
      } finally {
        database.close();
      }
    },
  );
});
