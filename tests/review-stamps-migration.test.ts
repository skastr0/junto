/**
 * State migration 32 -> 33 rebuilds `work_review_verdicts` with each
 * verdict's reviewer kind (consolidate). Proven on both shipped fixtures
 * brought to version 32 by the real steps: every verdict comes through as a
 * seat's with its columns as they were, and every other table is untouched.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateMachineNames } from "../src/main/junto/state/migrate-machine-names";
import {
  STATE_SCHEMA_CONSOLIDATE_SAFETY,
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V32_IDENTITY,
  STATE_SCHEMA_V33_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationDatabase,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V32_SQL, STATE_SCHEMA_V33_SQL, stepped } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-review-stamps-migration-"));
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

const SEAT = `seat_${"b".repeat(64)}`;

describe("state migration 32 -> 33 (review stamps)", () => {
  it("freezes the witnesses the step starts from and ends at", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V32_SQL)).toEqual(STATE_SCHEMA_V32_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V33_SQL)).toEqual(STATE_SCHEMA_V33_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "carries every verdict of %s over as a seat's and leaves every other row as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, planTo(32, STATE_SCHEMA_V32_SQL));
        // A crew verdict on a task with seat ids and no node, as the old schema allowed.
        database.prepare(`
          INSERT INTO work_review_verdicts (verdict_id, kind, reviewer_seat_id, reviewer_node_id, author_seat_id,
            subject_kind, subject_task_installation, subject_task_canvas, subject_task_node, subject_task_item,
            subject_epoch, subject_hash, epoch, findings_json, refs_json, posted_at_ms)
          VALUES ('v-old', 'green', ?, NULL, ?, 'task', 'mini', 'factory', 'tasks-1', 'task-1', 0, 'h', 0, '[]', '[]', 1)
        `).run(SEAT, SEAT);
        const before = snapshot(database);

        const result = migrateStateSchema(database, planTo(33, STATE_SCHEMA_V33_SQL));
        expect(result).toMatchObject({ previousVersion: 32, schemaVersion: 33 });
        expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V33_IDENTITY);

        const after = snapshot(database);
        const { work_review_verdicts: verdicts, ...rest } = after;
        const { work_review_verdicts: verdictsBefore, ...restBefore } = before;
        expect(rest).toEqual(restBefore);
        expect(verdicts).toEqual(
          (verdictsBefore as ReadonlyArray<Record<string, unknown>>).map((row) => ({ ...row, reviewer_kind: "seat" })),
        );
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        database.close();
      }
    },
  );

  describe("relaxesNotNull admits a dropped NOT NULL on a named column, and nothing else", () => {
    /** A stand-in 32 -> 33 that rebuilds the verdicts as `rebuild` says. */
    const standIn = (
      rebuild: (database: StateSchemaMigrationDatabase) => void,
      relaxesNotNull?: Readonly<Record<string, ReadonlyArray<string>>>,
    ) => {
      const base = planTo(32, STATE_SCHEMA_V32_SQL);
      return {
        ...base,
        currentVersion: 33,
        currentSchemaSql: stepped(STATE_SCHEMA_V32_SQL, (database) => rebuild(database)),
        migrations: [...base.migrations, {
          fromVersion: 32,
          toVersion: 33,
          name: "a stand-in rebuild of the verdicts",
          safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
          fromIdentity: STATE_SCHEMA_V32_IDENTITY,
          replacesTables: ["work_review_verdicts"],
          ...(relaxesNotNull === undefined ? {} : { relaxesNotNull }),
          migrate: rebuild,
        }],
      };
    };
    /** Rebuild the 31 table with its DDL text edited. */
    const rebuildWith = (edit: (sql: string) => string) => (database: StateSchemaMigrationDatabase) => {
      const row = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'work_review_verdicts'").get();
      const indexes = database.prepare(
        "SELECT sql FROM sqlite_schema WHERE tbl_name = 'work_review_verdicts' AND type IN ('index', 'trigger') AND sql IS NOT NULL",
      ).all();
      database.exec("CREATE TABLE verdicts_before AS SELECT * FROM work_review_verdicts; DROP TABLE work_review_verdicts;");
      database.exec(edit(String(row?.sql)));
      database.exec("INSERT INTO work_review_verdicts SELECT * FROM verdicts_before; DROP TABLE verdicts_before;");
      for (const object of indexes) database.exec(String(object.sql));
    };
    const relaxSeat = (sql: string) => sql.replace("reviewer_seat_id TEXT NOT NULL", "reviewer_seat_id TEXT");
    const migrateFixture = async (plan: ReturnType<typeof standIn>) => {
      const database = await openCopy("command-center-v13.db");
      try {
        migrateStateSchema(database, planTo(32, STATE_SCHEMA_V32_SQL));
        migrateStateSchema(database, plan);
      } finally {
        database.close();
      }
    };

    it("admits the relax it names", async () => {
      await expect(migrateFixture(standIn(rebuildWith(relaxSeat), { work_review_verdicts: ["reviewer_seat_id"] })))
        .resolves.toBeUndefined();
    });

    it("refuses the same relax undeclared", async () => {
      await expect(migrateFixture(standIn(rebuildWith(relaxSeat)))).rejects.toThrow(
        /changed durable column work_review_verdicts.reviewer_seat_id/,
      );
    });

    it("refuses a NOT NULL tightened on a named column", async () => {
      const tighten = (sql: string) => sql.replace(/reviewer_node_id TEXT\b/u, "reviewer_node_id TEXT NOT NULL DEFAULT 'x'");
      await expect(migrateFixture(standIn(rebuildWith(tighten), { work_review_verdicts: ["reviewer_node_id"] }))).rejects
        .toThrow(/declared work_review_verdicts.reviewer_node_id relaxed but does not drop its NOT NULL/);
    });

    it("refuses a declared column the step does not relax", async () => {
      await expect(
        migrateFixture(standIn(rebuildWith(relaxSeat), { work_review_verdicts: ["reviewer_seat_id", "reviewer_node_id"] })),
      ).rejects.toThrow(/declared work_review_verdicts.reviewer_node_id relaxed but does not drop its NOT NULL/);
    });

    it("refuses a declared column that does not exist", async () => {
      await expect(
        migrateFixture(standIn(rebuildWith(relaxSeat), { work_review_verdicts: ["reviewer_seat_id", "no_such_column"] })),
      ).rejects.toThrow(/declared work_review_verdicts.no_such_column relaxed/);
    });

    it("refuses any other change to a named column", async () => {
      const retype = (sql: string) => relaxSeat(sql).replace("reviewer_seat_id TEXT", "reviewer_seat_id ANY");
      await expect(migrateFixture(standIn(rebuildWith(retype), { work_review_verdicts: ["reviewer_seat_id"] }))).rejects
        .toThrow(/changed durable column work_review_verdicts.reviewer_seat_id/);
    });
  });
});
