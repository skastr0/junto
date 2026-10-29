/**
 * Step 48 takes the `tasks.*` ports and `artifact.publish` out of every stored
 * wire mask, and nothing else moves. Proven with masks of the shapes a live
 * wire can hold: none, one retired port alone, every retired port, retired
 * ports among kept ones, and kept ones only. A stored wire that still named
 * one would no longer decode.
 *
 * The version-47 database is made at version 47 (a fresh database takes the
 * witness schema whole), not by replaying 13 -> 47 over a shipped fixture:
 * that replay ran seconds under a loaded full run. It lives in memory, so no
 * path is shared with any other test, and rows seeded before the step stand in
 * for what a shipped database holds.
 */
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { wireFromRow } from "../src/main/junto/model/rows";
import { TASK_ARTIFACT_PORTS } from "../src/main/junto/state/migrate-task-artifact-ports";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V47_IDENTITY,
  STATE_SCHEMA_V48_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { Port } from "../src/shared/physics/schema";
import { STATE_SCHEMA_V47_SQL, STATE_SCHEMA_V48_SQL } from "./fixtures/state-v13/schema";

const tables = (database: DatabaseSync): ReadonlyArray<string> =>
  (
    database
      .prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'state_schema_identity'
          ORDER BY name`,
      )
      .all() as unknown as ReadonlyArray<{ readonly name: SQLOutputValue }>
  ).map(({ name }) => String(name));

const rows = (database: DatabaseSync, table: string) =>
  database.prepare(`SELECT * FROM "${table}" ORDER BY 1, 2`).all() as unknown as ReadonlyArray<Record<string, unknown>>;

const upTo = (version: number, currentSchemaSql: string): StateSchemaMigrationPlan => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version),
});

/** A version-47 database, fresh and in memory. */
const openAt47 = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:", { allowExtension: false, enableForeignKeyConstraints: true });
  expect(migrateStateSchema(database, upTo(47, STATE_SCHEMA_V47_SQL))).toMatchObject({ schemaVersion: 47, ...STATE_SCHEMA_V47_IDENTITY });
  return database;
};

/** Stored masks before the step, and what each reads after it. */
const MASKS = [
  ["mask-none", null, null],
  ["mask-task", '["tasks.claim"]', "[]"],
  ["mask-artifact", '["artifact.publish"]', "[]"],
  ["mask-every", JSON.stringify(TASK_ARTIFACT_PORTS), "[]"],
  ["mask-mixed", '["msg.send","tasks.list","msg.list","artifact.publish"]', '["msg.send","msg.list"]'],
  ["mask-kept", '["msg.send"]', '["msg.send"]'],
] as const;

/** A canvas, a board, a sided flows wire and a messages wire per mask shape. */
const seed = (database: DatabaseSync): void => {
  const name = "main";
  database.exec(`
    INSERT INTO canvases(canvas_name, canvas_id, created_at, updated_at, seq) VALUES ('main', 'c', 't', 't', 0);
    INSERT INTO artifact_boards (canvas_name, id, x, y, width, height, z_index, color, created_at, updated_at, label)
      VALUES ('main', 'shelf', 0, 0, 10, 10, 0, NULL, 't', 't', 'Shelf');
    INSERT INTO wires(canvas_name, id, from_id, to_id, verb, from_side, to_side, mask_json, created_at, updated_at)
      VALUES ('main', 'wire-flows', 'a', 'c', 'flows', 'right', 'left', NULL, 't', 't');
  `);
  const insert = database.prepare(
    `INSERT INTO wires(canvas_name, id, from_id, to_id, verb, mask_json, created_at, updated_at)
      VALUES (?, ?, 'a', 'b', 'messages', ?, 't', 't')`,
  );
  for (const [id, before] of MASKS) insert.run(name, id, before);
};

const storedWire = (mask: string) => ({ id: "w", from_id: "a", to_id: "b", verb: "messages", mask_json: mask });

describe("state migration 47 -> 48 (the task and artifact ports leave wire masks)", () => {
  it("starts from the version-47 witness and ends at the version-48 one, with the same text", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V47_SQL)).toEqual(STATE_SCHEMA_V47_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V48_SQL)).toEqual(STATE_SCHEMA_V48_IDENTITY);
    expect(STATE_SCHEMA_V48_IDENTITY).toEqual(STATE_SCHEMA_V47_IDENTITY);
  });

  it("no longer lists the ports, and a stored wire naming one does not decode", () => {
    for (const port of TASK_ARTIFACT_PORTS) {
      expect(Port.literals, port).not.toContain(port);
      expect(() => wireFromRow(storedWire(JSON.stringify(["msg.send", port]))), port).toThrow();
    }
    expect(wireFromRow(storedWire('["msg.send"]')).mask).toEqual(["msg.send"]);
  });

  it(
    "takes the ports out of every mask and leaves everything else as it was",
    () => {
      const database = openAt47();
      try {
        seed(database);
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        expect(before.wires).toHaveLength(MASKS.length + 1);
        expect(before.artifact_boards).toHaveLength(1);

        const result = migrateStateSchema(database, upTo(48, STATE_SCHEMA_V48_SQL));
        expect(result).toMatchObject({ previousVersion: 47, schemaVersion: 48 });
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const after = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        const { wires, ...rest } = after;
        const { wires: wiresBefore, ...restBefore } = before;
        expect(rest).toEqual(restBefore);
        const masked = new Map<string, string | null>(MASKS.map(([id, , expected]) => [id, expected]));
        expect(wires).toEqual(
          wiresBefore!.map((row) =>
            masked.has(String(row.id)) ? { ...row, mask_json: masked.get(String(row.id)) } : row),
        );
        for (const row of wires!) expect(() => wireFromRow(row), String(row.id)).not.toThrow();
      } finally {
        database.close();
      }
    },
  );
});
