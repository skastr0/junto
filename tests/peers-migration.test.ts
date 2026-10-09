/**
 * State migration 16 -> 17 adds peers (expand only): the seats of other
 * machines, as a machine holding a copy of a canvas sees them. Proven on both
 * shipped fixtures brought to version 16 by the real steps: every row already
 * held survives, the one new table starts empty, and a peer is stored and
 * read back as a peer.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { nodeFromRow, nodeToRow } from "../src/main/junto/model/rows";
import {
  CURRENT_STATE_SCHEMA_IDENTITY,
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V16_IDENTITY,
  STATE_SCHEMA_V17_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { Node } from "../src/shared/model";
import { STATE_SCHEMA_V16_SQL } from "./fixtures/state-v1/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-peers-migration-"));
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

const versionSixteenPlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 16,
  currentSchemaSql: STATE_SCHEMA_V16_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 16),
};

const peer = Schema.decodeUnknownSync(Node)({
  kind: "peer",
  id: "lead",
  x: 10,
  y: 20,
  width: 240,
  height: 100,
  z: 3,
  label: "remote-lead",
  host: "macbook",
  seatId: `seat_${"a".repeat(64)}`,
});

describe("state migration 16 -> 17 (peers)", () => {
  it("freezes the version-sixteen witness the step starts from and names the head", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V16_SQL)).toEqual(STATE_SCHEMA_V16_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(STATE_SCHEMA_V17_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(expectedStateSchemaIdentity(STATE_SCHEMA_SQL));
  });

  it.each(["command-center-v1.db", "remote-v1.db"])(
    "adds the one table to %s and leaves every row already held as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, versionSixteenPlan);
        const before = snapshot(database);
        expect(before).not.toHaveProperty("peers");

        const result = migrateStateSchema(database);
        expect(result).toMatchObject({ previousVersion: 16, schemaVersion: 17 });
        expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V17_IDENTITY);
        const { peers, ...rest } = snapshot(database);
        expect(rest).toEqual(before);
        expect(peers).toEqual([]);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        database.close();
      }
    },
  );

  it("stores a peer in its own table and reads it back as a peer, with nothing to start it from", async () => {
    const database = await openCopy("command-center-v1.db");
    try {
      migrateStateSchema(database);
      const canvas = String(database.prepare("SELECT canvas_name FROM canvases LIMIT 1").get()!.canvas_name);
      const row = { ...nodeToRow(canvas, peer), created_at: "2026-10-09T00:00:00.000Z", updated_at: "2026-10-09T00:00:00.000Z" };
      const columns = Object.keys(row);
      database
        .prepare(`INSERT INTO peers(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
        .run(...(Object.values(row) as SQLOutputValue[]));
      const stored = database.prepare("SELECT * FROM peers").get()!;
      expect(Object.keys(stored).sort()).toEqual(
        ["canvas_name", "color", "created_at", "height", "host", "id", "label", "seat_id", "updated_at", "width", "x", "y", "z_index"].sort(),
      );
      expect(nodeFromRow("peer", stored as never)).toEqual(peer);
      expect(() => database.prepare("UPDATE peers SET seat_id = 'not-a-seat'").run()).toThrow();
    } finally {
      database.close();
    }
  });
});
