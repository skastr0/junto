/**
 * The 0.10 deletions step drops the nodes and wires of removed kinds and
 * verbs, says `flows` where a wire said `feeds`, and drops the tables of
 * removed features. Proven on both fixtures brought to version 25 by the real
 * steps, with rows in every table that goes and wires of every verb: what is
 * kept stays exactly as it was, and nothing else in the database moves.
 *
 * Until the code that reads the dropped tables is gone, the step runs here
 * through a stand-in plan, as the step after version 25.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  CANVAS_DELETIONS_CORRECTED_TABLES,
  CANVAS_DELETIONS_REMOVED_TABLES,
  CANVAS_DELETIONS_REPLACED_TABLES,
  CANVAS_DELETIONS_RETIRED_COLUMNS,
  migrateCanvasDeletions,
} from "../src/main/junto/state/migrate-canvas-deletions";
import { migrateMachineNames } from "../src/main/junto/state/migrate-machine-names";
import {
  STATE_SCHEMA_CONSOLIDATE_SAFETY,
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V25_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V25_SQL, stepped } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-canvas-deletions-migration-"));
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

// From the frozen v25 text the fixtures were brought to, so a head schema in
// flight cannot move it. A real database is checked on a copy of it.
const STATE_SCHEMA_V26_SQL = stepped(STATE_SCHEMA_V25_SQL, migrateCanvasDeletions);

const versionTwentyFivePlan: StateSchemaMigrationPlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 25,
  currentSchemaSql: STATE_SCHEMA_V25_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 25).map(named),
};

/** The stand-in: the deletions step appended after version 25. */
const deletionsPlan: StateSchemaMigrationPlan = {
  ...versionTwentyFivePlan,
  currentVersion: 26,
  currentSchemaSql: STATE_SCHEMA_V26_SQL,
  migrations: [
    ...versionTwentyFivePlan.migrations,
    {
      fromVersion: 25,
      toVersion: 26,
      name: "delete what 0.10 deletes",
      safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
      fromIdentity: STATE_SCHEMA_V25_IDENTITY,
      removesTables: [...CANVAS_DELETIONS_REMOVED_TABLES],
      replacesTables: [...CANVAS_DELETIONS_REPLACED_TABLES],
      retiresColumns: CANVAS_DELETIONS_RETIRED_COLUMNS,
      correctiveWriteTables: [...CANVAS_DELETIONS_CORRECTED_TABLES],
      migrate: migrateCanvasDeletions,
    },
  ],
};

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

const SETTINGS_BEFORE = { kernel: { pulseLogRetention: 20, debugVerbose: true }, canvas: { showMinimap: false } };
const SETTINGS_AFTER = { kernel: { debugVerbose: true }, canvas: { showMinimap: false } };

const OLD_VERBS = [
  "messages", "reviews", "manages", "contributes", "works", "publishes", "participates", "reads",
  "edits", "navigates", "feeds", "fires", "announces", "enqueues", "wakes", "chains",
] as const;

/**
 * Two seats with a wire of every old verb between them, a pad, a sheet and
 * a cron with a wire each, and a row in every table the step drops that has columns
 * this seed can fill without knowing the feature. A page and a region that
 * name a machine, and a remote machine with Hermes and the browser.
 */
const seed = (database: DatabaseSync, canvas: string): void => {
  const insert = (table: string, row: Record<string, string | number | null>) =>
    database
      .prepare(`INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`)
      .run(...Object.values(row));
  const seat = { canvas_name: canvas, agent_key: "k", label: "L", host: "macbook", harness: "claude", overseer: 0 };
  insert("seats", { ...seat, ...geometry("seat-a"), binding_id: "b-a" });
  insert("seats", { ...seat, ...geometry("seat-b"), binding_id: "b-b" });
  insert("pads", { canvas_name: canvas, ...geometry("pad-1"), label: null });
  insert("sheets", { canvas_name: canvas, ...geometry("sheet-1"), label: null });
  insert("sheet_grids", { canvas_name: canvas, id: "sheet-1", columns_json: "[]", rows_json: "[]", updated_at: "t" });
  insert("work_pad_meta", { canvas_name: canvas, node_id: "pad-1", revision: 1, updated_at: "t" });
  const wire = (id: string, from: string, to: string, verb: string) =>
    insert("wires", {
      canvas_name: canvas, id, from_id: from, to_id: to, verb, from_side: "right", to_side: "left",
      mask_json: null, created_at: "t", updated_at: "t",
    });
  for (const verb of OLD_VERBS) wire(`wire-${verb}`, "seat-a", "seat-b", verb);
  wire("wire-to-pad", "seat-a", "pad-1", "messages");
  wire("wire-from-sheet", "sheet-1", "seat-b", "messages");
  insert("crons", { canvas_name: canvas, ...geometry("cron-1"), label: null, host: "macbook", expression: "0 * * * *" });
  wire("wire-from-cron", "cron-1", "seat-b", "messages");
  insert("pages", { canvas_name: canvas, ...geometry("page-1"), url: "https://example.com/", host: "macbook", profile: "p", on_remove: "detach" });
  insert("regions", { canvas_name: canvas, ...geometry("region-1"), label: "R", hold: 0, page_url: "https://example.com/", page_host: "macbook" });
  const order = Number(database.prepare("SELECT max(sort_order) + 1 AS n FROM host_registry").get()!.n ?? 1);
  insert("settings_preferences", { singleton: 1, version: 1, body: JSON.stringify(SETTINGS_BEFORE), updated_at: "t" });
  insert("host_registry", { id: "studio-probe", label: "Studio", is_this_machine: 0, capability_mask: 11, effective_hermes_id: "studio-probe", sort_order: order });
};

/** A table's rows without the columns the step retires from it. */
const retired = (table: string, list: ReadonlyArray<Record<string, unknown>>) =>
  list.map((row) => {
    const kept = { ...row };
    for (const column of (CANVAS_DELETIONS_RETIRED_COLUMNS as Record<string, ReadonlyArray<string>>)[table] ?? []) delete kept[column];
    return kept;
  });

describe("state migration 25 -> 26 (the 0.10 deletions)", () => {
  it("starts from the version-25 witness", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V25_SQL)).toEqual(STATE_SCHEMA_V25_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "drops what goes from %s and leaves everything else as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, versionTwentyFivePlan);
        const canvas = firstCanvas(database);
        const wiresBefore = rows(database, "wires");
        seed(database, canvas);
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));

        const result = migrateStateSchema(database, deletionsPlan);
        expect(result).toMatchObject({ previousVersion: 25, schemaVersion: 26 });
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const after = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        for (const table of CANVAS_DELETIONS_REMOVED_TABLES) expect(after).not.toHaveProperty(table);
        const { wires, host_registry: machines, ...rest } = after;
        const { wires: _wires, host_registry: machinesBefore, ...restBefore } = before;
        for (const table of CANVAS_DELETIONS_REMOVED_TABLES) delete restBefore[table];
        for (const table of ["regions", "pages"]) restBefore[table] = retired(table, restBefore[table]!);
        restBefore.settings_preferences = restBefore.settings_preferences!.map((row) => ({ ...row, body: JSON.stringify(SETTINGS_AFTER) }));
        expect(rest).toEqual(restBefore);
        expect(after.pages!.find((row) => row.id === "page-1")).not.toHaveProperty("host");
        expect(after.regions!.find((row) => row.id === "region-1")).not.toHaveProperty("page_host");

        // Every machine stays; a remote one keeps terminals and nothing else.
        expect(machines).toEqual(
          retired("host_registry", machinesBefore!).map((row) =>
            row.is_this_machine === 1 ? row : { ...row, capability_mask: 1 }),
        );

        const seeded = (wires ?? []).filter((row) => !wiresBefore.some((old) => old.id === row.id));
        expect(seeded.map((row) => [row.id, row.verb])).toEqual([
          ["wire-feeds", "flows"],
          ["wire-messages", "messages"],
          ["wire-navigates", "navigates"],
          ["wire-participates", "participates"],
          ["wire-reviews", "reviews"],
        ]);
        const kept = before.wires!.find((row) => row.id === "wire-messages");
        expect(wires!.find((row) => row.id === "wire-messages")).toEqual(kept);
      } finally {
        database.close();
      }
    },
  );

  it("refuses a removed verb, and the old word for flows, once it has run", async () => {
    const database = await openCopy("command-center-v13.db");
    try {
      migrateStateSchema(database, deletionsPlan);
      const canvas = firstCanvas(database);
      const write = (verb: string) =>
        database
          .prepare(
            `INSERT INTO wires(canvas_name, id, from_id, to_id, verb, created_at, updated_at)
              VALUES (?, ?, 'a', 'b', ?, 't', 't')`,
          )
          .run(canvas, `probe-${verb}`, verb);
      for (const verb of ["feeds", "reads", "edits", "works", "fires", "chains"]) {
        expect(() => write(verb)).toThrow(/CHECK constraint failed/u);
      }
      for (const verb of ["messages", "reviews", "participates", "navigates", "flows"]) expect(() => write(verb)).not.toThrow();
    } finally {
      database.close();
    }
  });
});
