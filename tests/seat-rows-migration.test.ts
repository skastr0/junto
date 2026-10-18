/**
 * State migration 23 -> 24 retires `seats.session_id` and says "stop" where a
 * seat or terminal row said "kill-session". Proven on both shipped fixtures
 * brought to version 23 by the real steps: every row survives, every other
 * column is as it was, and nothing else in the database moves.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { nodeFromRow } from "../src/main/junto/model/rows";
import { migrateMachineNames } from "../src/main/junto/state/migrate-machine-names";
import {
  CURRENT_STATE_SCHEMA_IDENTITY,
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V23_IDENTITY,
  STATE_SCHEMA_V24_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { STATE_SCHEMA_V23_SQL } from "./fixtures/state-v1/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-seat-rows-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v1/${fixture}`, import.meta.url)), path);
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

const versionTwentyThreePlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 23,
  currentSchemaSql: STATE_SCHEMA_V23_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 23).map(named),
};

const headPlan = { ...STATE_SCHEMA_MIGRATION_PLAN, migrations: STATE_SCHEMA_MIGRATIONS.map(named) };

const geometry = (id: string) => ({
  id, x: 0, y: 0, width: 10, height: 10, z_index: 1, color: null, created_at: "t", updated_at: "t",
});

/** A seat that stops and names a session, one that detaches, and a terminal that stops. */
const seed = (database: DatabaseSync, canvas: string): void => {
  const insert = (table: string, row: Record<string, string | number | null>) =>
    database
      .prepare(`INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`)
      .run(...Object.values(row));
  const seat = { canvas_name: canvas, agent_key: "k", label: "L", host: "macbook", harness: "claude", overseer: 0 };
  insert("seats", { ...seat, ...geometry("seat-stops"), binding_id: "b-stops", session_id: "s-1", on_remove: "kill-session" });
  insert("seats", { ...seat, ...geometry("seat-detaches"), binding_id: "b-detaches", session_id: null, on_remove: "detach" });
  insert("terminals", { canvas_name: canvas, ...geometry("term-stops"), label: null, host: "macbook", binding_id: "b-term", on_remove: "kill-session" });
};

const firstCanvas = (database: DatabaseSync): string => {
  const row = database.prepare("SELECT canvas_name FROM canvases ORDER BY canvas_name LIMIT 1").get();
  if (row) return String(row.canvas_name);
  database
    .prepare("INSERT INTO canvases(canvas_name, canvas_id, created_at, updated_at, seq) VALUES ('main', 'c', 't', 't', 0)")
    .run();
  return "main";
};

describe("state migration 23 -> 24 (seat rows)", () => {
  it("freezes the witness the step starts from and names the head", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V23_SQL)).toEqual(STATE_SCHEMA_V23_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(STATE_SCHEMA_V24_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(expectedStateSchemaIdentity(STATE_SCHEMA_SQL));
  });

  it.each(["command-center-v1.db", "remote-v1.db"])(
    "retires the column and the old word in %s and leaves everything else as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, versionTwentyThreePlan);
        seed(database, firstCanvas(database));
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));

        const result = migrateStateSchema(database, headPlan);
        expect(result).toMatchObject({ previousVersion: 23, schemaVersion: 24 });
        expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V24_IDENTITY);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const word = (value: unknown) => (value === "kill-session" ? "stop" : value);
        const after = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        const { seats, terminals, ...rest } = after;
        const { seats: seatsBefore, terminals: terminalsBefore, ...restBefore } = before;
        expect(rest).toEqual(restBefore);
        expect(seats).toEqual(
          seatsBefore!.map(({ session_id: _gone, ...row }) => ({ ...row, on_remove: word(row.on_remove) })),
        );
        expect(terminals).toEqual(terminalsBefore!.map((row) => ({ ...row, on_remove: word(row.on_remove) })));
        expect(seats!.some((row) => row.id === "seat-stops" && row.on_remove === "stop")).toBe(true);
        expect(terminals!.some((row) => row.id === "term-stops" && row.on_remove === "stop")).toBe(true);
        for (const row of seats!) expect(nodeFromRow("agent", row)).toMatchObject({ onRemove: word(row.on_remove) });
      } finally {
        database.close();
      }
    },
  );

  it("refuses the old word once the step has run", async () => {
    const database = await openCopy("command-center-v1.db");
    try {
      migrateStateSchema(database, headPlan);
      const canvas = firstCanvas(database);
      expect(() =>
        database
          .prepare(
            `INSERT INTO terminals(canvas_name, id, x, y, width, height, z_index, created_at, updated_at, host, binding_id, on_remove)
             VALUES (?, 'old', 0, 0, 1, 1, 0, 't', 't', 'local', 'b-old', 'kill-session')`,
          )
          .run(canvas),
      ).toThrow();
    } finally {
      database.close();
    }
  });
});
