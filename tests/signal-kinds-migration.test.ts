/**
 * Step 60 lets an automation raise a signal for the operator (0.11/07, N1).
 * `agent_signals` is rebuilt with `notice` and `work` in its kind CHECK and
 * three nullable JSON columns (source, work, form). Proven on both shipped
 * fixtures brought to version 59 by the real steps: the step's schema hashes
 * the same as the witness, every signal already held survives with every
 * value it had, its new columns start empty, and the two new kinds then
 * insert. A signal written before the step reads as a seat's own.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateMachineNames } from "../src/main/junto/state/migrate-machine-names";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V59_IDENTITY,
  STATE_SCHEMA_V60_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, readRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V59_SQL, STATE_SCHEMA_V60_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-signal-kinds-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v13/${fixture}`, import.meta.url)), path);
  const database = new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
};

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

const named = <T extends { readonly toVersion: number; readonly migrate: (database: DatabaseSync) => void }>(step: T): T =>
  step.toVersion === 21 ? { ...step, migrate: (database: DatabaseSync) => migrateMachineNames(database, "macbook") } : step;

const upTo = (version: number, currentSchemaSql: string): StateSchemaMigrationPlan => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version).map(named),
});

const canvasOf = (database: DatabaseSync): string => {
  const canvas = database.prepare("SELECT canvas_name FROM canvases ORDER BY canvas_name LIMIT 1").get();
  if (canvas) return String(canvas.canvas_name);
  database
    .prepare("INSERT INTO canvases(canvas_name, canvas_id, created_at, updated_at, seq) VALUES ('main', 'c', 't', 't', 0)")
    .run();
  return "main";
};

/** A signal as a build before the step wrote one: three kinds, no source, no work, no form. */
const seedFromBeforeTheStep = (database: DatabaseSync, canvas: string): void => {
  const insert = database.prepare(
    `INSERT INTO agent_signals(signal_id, canvas_name, node_id, kind, text, detail, created_at, state, response_text, response_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run("sig-blocked", canvas, "agent-1", "blocked", "Need the key.", "## why", 10, "open", null, null, null);
  insert.run("sig-escalate", canvas, "agent-1", "escalate", "Which store?", null, 11, "answered", "SQLite", 12, 12);
  insert.run("sig-feedback", canvas, "agent-2", "feedback", "Ready to review.", null, 13, "dismissed", null, null, 14);
};

const KEPT = ["signal_id", "canvas_name", "node_id", "kind", "text", "detail", "created_at", "state", "response_text", "response_at", "closed_at"] as const;

describe("state migration 59 -> 60 (a signal an automation raises)", () => {
  it("starts from the version-59 witness and ends at the head, which a fresh database matches", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V59_SQL)).toEqual(STATE_SCHEMA_V59_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V60_SQL)).toEqual(STATE_SCHEMA_V60_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "keeps every signal of %s as it was, with its new columns empty and the new kinds allowed",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, upTo(59, STATE_SCHEMA_V59_SQL));
        const canvas = canvasOf(database);
        seedFromBeforeTheStep(database, canvas);
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));

        const result = migrateStateSchema(database, upTo(60, STATE_SCHEMA_V60_SQL));
        expect(result).toMatchObject({ previousVersion: 59, schemaVersion: 60, ...STATE_SCHEMA_V60_IDENTITY });
        expect(readRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V60_IDENTITY);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const after = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        expect(Object.keys(after)).toEqual(Object.keys(before));
        for (const table of Object.keys(before)) {
          if (table === "agent_signals") continue;
          expect(after[table], table).toEqual(before[table]);
        }
        // Every kept value is the one it held, and nothing was added to an old row.
        expect(after.agent_signals!.map((row) => KEPT.map((column) => row[column]))).toEqual(
          before.agent_signals!.map((row) => KEPT.map((column) => row[column])),
        );
        for (const row of after.agent_signals!) {
          expect([row.source_json, row.work_json, row.form_json]).toEqual([null, null, null]);
        }

        // A notice and a work signal insert now, with their own fields.
        const insert = database.prepare(
          `INSERT INTO agent_signals(signal_id, canvas_name, node_id, kind, text, created_at, state, source_json, work_json, form_json)
           VALUES (?, ?, 'automations-1', ?, ?, 20, 'open', ?, ?, ?)`,
        );
        insert.run("sig-notice", canvas, "notice", "A run finished.", '{"kind":"automation","automationId":"a1","nodeId":"automations-1"}', null, null);
        insert.run(
          "sig-work",
          canvas,
          "work",
          "Write 500 words.",
          '{"kind":"automation","automationId":"a1","nodeId":"automations-1"}',
          '{"dueAt":30,"urgent":true}',
          '{"kind":"proof"}',
        );
        expect(rows(database, "agent_signals").filter((row) => row.node_id === "automations-1")).toHaveLength(2);
      } finally {
        database.close();
      }
    },
    60_000,
  );
});
