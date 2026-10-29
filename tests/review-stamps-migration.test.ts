/**
 * State migration 32 -> 33 rebuilds `work_review_verdicts` with each
 * verdict's reviewer kind (consolidate): every verdict comes through as a
 * seat's with its columns as they were, and every other table is untouched.
 *
 * The version-32 database is made at version 32 (a fresh database takes the
 * witness schema whole), not by replaying 13 -> 32 over a shipped fixture:
 * that replay ran seconds under a loaded full run. It lives in memory, so no
 * path is shared with any other test, and rows seeded before the step stand in
 * for what a shipped database holds.
 */
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
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

/** A version-32 database, fresh and in memory. */
const openAt32 = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:", { allowExtension: false, enableForeignKeyConstraints: true });
  expect(migrateStateSchema(database, planTo(32, STATE_SCHEMA_V32_SQL))).toMatchObject({ schemaVersion: 32, ...STATE_SCHEMA_V32_IDENTITY });
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

const planTo = (version: number, currentSchemaSql: string) => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version),
});

const SEAT = `seat_${"b".repeat(64)}`;

describe("state migration 32 -> 33 (review stamps)", () => {
  it("freezes the witnesses the step starts from and ends at", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V32_SQL)).toEqual(STATE_SCHEMA_V32_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V33_SQL)).toEqual(STATE_SCHEMA_V33_IDENTITY);
  });

  it(
    "carries every verdict over as a seat's and leaves every other row as it was",
    () => {
      const database = openAt32();
      try {
        database.exec("INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at) VALUES ('factory', 'canvas-1', 'now', 'now')");
        // A crew verdict on a task with seat ids and no node, as the old schema allowed, and one with a node.
        const verdict = database.prepare(`
          INSERT INTO work_review_verdicts (verdict_id, kind, reviewer_seat_id, reviewer_node_id, author_seat_id,
            subject_kind, subject_task_installation, subject_task_canvas, subject_task_node, subject_task_item,
            subject_epoch, subject_hash, epoch, findings_json, refs_json, posted_at_ms)
          VALUES (?, ?, ?, ?, ?, 'task', 'mini', 'factory', 'tasks-1', 'task-1', 0, 'h', 0, '[]', '[]', 1)
        `);
        verdict.run("v-old", "green", SEAT, null, SEAT);
        verdict.run("v-node", "blocking", SEAT, "agent-1", SEAT);
        const before = snapshot(database);
        expect(before["work_review_verdicts"]).toHaveLength(2);

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
      const database = openAt32();
      try {
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
