/**
 * State migration 18 -> 19 adds what the editing machine remembers of the
 * canvas copies it sent (expand only). Proven on both shipped fixtures brought
 * to version 18 by the real steps: every row already held survives and the two
 * new tables start empty.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURRENT_STATE_SCHEMA_IDENTITY,
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V18_IDENTITY,
  STATE_SCHEMA_V19_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { STATE_SCHEMA_V18_SQL } from "./fixtures/state-v1/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-canvas-copy-history-migration-"));
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

const versionEighteenPlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 18,
  currentSchemaSql: STATE_SCHEMA_V18_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 18),
};

describe("state migration 18 -> 19 (the canvas copies sent)", () => {
  it("freezes the version-eighteen witness the step starts from and names the head", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V18_SQL)).toEqual(STATE_SCHEMA_V18_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(STATE_SCHEMA_V19_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(expectedStateSchemaIdentity(STATE_SCHEMA_SQL));
  });

  it.each(["command-center-v1.db", "remote-v1.db"])(
    "adds the two tables to %s and leaves every row already held as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, versionEighteenPlan);
        const before = snapshot(database);

        const result = migrateStateSchema(database);
        expect(result).toMatchObject({ previousVersion: 18, schemaVersion: 19 });
        expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V19_IDENTITY);
        const { canvas_copies_sent: sent, canvas_placements: placements, ...rest } = snapshot(database);
        expect(rest).toEqual(before);
        expect(sent).toEqual([]);
        expect(placements).toEqual([]);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const place = database.prepare(
          `INSERT INTO canvas_placements(canvas_name, node_id, from_seq, until_seq, seat_id, machine)
           VALUES ('factory', 'peer', ?, ?, ?, 'mini')`,
        );
        const seat = `seat_${"a".repeat(64)}`;
        place.run(3, 7, seat);
        place.run(7, null, seat);
        // One open range per seat, and a range never ends before it starts.
        expect(() => place.run(9, null, seat)).toThrow();
        expect(() => place.run(12, 12, seat)).toThrow();
      } finally {
        database.close();
      }
    },
  );
});
