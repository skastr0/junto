/**
 * State migration 24 -> 25 retires `on_remove` from seats and terminals:
 * nothing ever read it for either. Proven on both shipped fixtures brought to
 * version 24 by the real steps: every row survives with every other column as
 * it was, pages keep theirs, and nothing else in the database moves.
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
  STATE_SCHEMA_V24_IDENTITY,
  STATE_SCHEMA_V25_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { STATE_SCHEMA_V24_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-retire-on-remove-migration-"));
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

const versionTwentyFourPlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 24,
  currentSchemaSql: STATE_SCHEMA_V24_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 24).map(named),
};

const headPlan = { ...STATE_SCHEMA_MIGRATION_PLAN, migrations: STATE_SCHEMA_MIGRATIONS.map(named) };

const geometry = (id: string) => ({
  id, x: 0, y: 0, width: 10, height: 10, z_index: 1, color: null, created_at: "t", updated_at: "t",
});

const firstCanvas = (database: DatabaseSync): string => {
  const row = database.prepare("SELECT canvas_name FROM canvases ORDER BY canvas_name LIMIT 1").get();
  if (row) return String(row.canvas_name);
  database
    .prepare("INSERT INTO canvases(canvas_name, canvas_id, created_at, updated_at, seq) VALUES ('main', 'c', 't', 't', 0)")
    .run();
  return "main";
};

/** A seat that stopped, one that detached, a terminal, and a page that keeps its own. */
const seed = (database: DatabaseSync, canvas: string): void => {
  const insert = (table: string, row: Record<string, string | number | null>) =>
    database
      .prepare(`INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`)
      .run(...Object.values(row));
  const seat = { canvas_name: canvas, agent_key: "k", label: "L", host: "macbook", harness: "claude", overseer: 0 };
  insert("seats", { ...seat, ...geometry("seat-stops"), binding_id: "b-stops", on_remove: "stop" });
  insert("seats", { ...seat, ...geometry("seat-detaches"), binding_id: "b-detaches", on_remove: "detach" });
  insert("terminals", { canvas_name: canvas, ...geometry("term"), label: null, host: "macbook", binding_id: "b-term", on_remove: "stop" });
  insert("pages", { canvas_name: canvas, ...geometry("page"), url: "https://example.com/", host: "macbook", profile: "p", on_remove: "kill-session" });
};

describe("state migration 24 -> 25 (retire on_remove from seats and terminals)", () => {
  it("freezes the witness the step starts from and names the head", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V24_SQL)).toEqual(STATE_SCHEMA_V24_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(STATE_SCHEMA_V25_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(expectedStateSchemaIdentity(STATE_SCHEMA_SQL));
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "drops the column from seats and terminals in %s and leaves everything else as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, versionTwentyFourPlan);
        seed(database, firstCanvas(database));
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));

        const result = migrateStateSchema(database, headPlan);
        expect(result).toMatchObject({ previousVersion: 24, schemaVersion: 25 });
        expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V25_IDENTITY);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const { seats, terminals, ...rest } = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        const { seats: seatsBefore, terminals: terminalsBefore, ...restBefore } = before;
        expect(rest).toEqual(restBefore);
        const without = (list: ReadonlyArray<Record<string, unknown>>) => list.map(({ on_remove: _gone, ...row }) => row);
        expect(seats).toEqual(without(seatsBefore!));
        expect(terminals).toEqual(without(terminalsBefore!));
        expect(seats!.map((row) => row.id)).toEqual(expect.arrayContaining(["seat-stops", "seat-detaches"]));
        for (const row of seats!) expect(nodeFromRow("agent", row)).not.toHaveProperty("onRemove");
        for (const row of terminals!) expect(nodeFromRow("terminal", row)).not.toHaveProperty("onRemove");
      } finally {
        database.close();
      }
    },
  );
});
