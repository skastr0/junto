/**
 * State migration 10 -> 11 adds signal parts (expand only): what a signal
 * carries beside its words, with no bound on how many or on a caption's
 * length. Proven on the real shipped fixture brought to version 10 by the
 * real steps, with attachments already held in the table it replaces: every
 * pre-existing row survives byte for byte, and every attachment is there
 * after, as a file part in its place and order.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V10_IDENTITY,
  STATE_SCHEMA_V11_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { STATE_SCHEMA_V10_SQL } from "./fixtures/state-v1/schema";

const fixture = fileURLToPath(new URL("./fixtures/state-v1/command-center-v1.db", import.meta.url));

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-signal-parts-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fixture, path);
  const database = new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
};

const tableNames = (database: DatabaseSync): string[] =>
  (
    database
      .prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'state_schema_identity'
          ORDER BY name`,
      )
      .all() as unknown as ReadonlyArray<{ readonly name: SQLOutputValue }>
  ).map(({ name }) => String(name));

const snapshot = (database: DatabaseSync) =>
  Object.fromEntries(
    tableNames(database).map((table) => [table, database.prepare(`SELECT * FROM "${table}" ORDER BY 1, 2`).all()]),
  );

const versionTenPlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 10,
  currentSchemaSql: STATE_SCHEMA_V10_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 10),
};

const sha = (fill: string): string => fill.repeat(64);
const raiseSignal = (database: DatabaseSync, signalId: string): void => {
  database
    .prepare(
      `INSERT INTO agent_signals(signal_id, canvas_name, node_id, kind, text, created_at, state)
       VALUES (?, 'factory', 'atlas', 'feedback', 'ready', 1, 'open')`,
    )
    .run(signalId);
};

describe("state migration 10 -> 11 (signal parts)", () => {
  it("freezes the version-ten witness the step starts from and names the head", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V10_SQL)).toEqual(STATE_SCHEMA_V10_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V11_IDENTITY);
  });

  it("carries every attachment already held across, in place and order, and touches nothing else", async () => {
    const database = await openCopy();
    try {
      migrateStateSchema(database, versionTenPlan);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 10 });
      // Two signals raised before this version, with files in the old table.
      raiseSignal(database, "sig-old-1");
      raiseSignal(database, "sig-old-2");
      const old = database.prepare(
        `INSERT INTO agent_signal_attachments(signal_id, position, sha256, byte_length, media_type, display_name, caption)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      old.run("sig-old-1", 0, sha("a"), 130109, "image/png", "before.png", "Before");
      old.run("sig-old-1", 1, sha("b"), 56078, "image/png", "after.png", null);
      old.run("sig-old-2", 0, sha("c"), 7, "text/markdown", "notes.md", "Notes");
      const before = snapshot(database);
      expect((before.work_events as unknown[]).length).toBeGreaterThan(0);
      expect(before.agent_signal_attachments).toHaveLength(3);
      expect(before).not.toHaveProperty("agent_signal_parts");

      const result = migrateStateSchema(database);
      expect(result).toMatchObject({ previousVersion: 10, schemaVersion: 11 });
      expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V11_IDENTITY);

      const { agent_signal_parts: parts, ...rest } = snapshot(database);
      // The old table included: it stays, with its rows.
      expect(rest).toEqual(before);
      expect(
        (parts as ReadonlyArray<Record<string, SQLOutputValue>>).map((row) => ({ ...row, body_json: JSON.parse(String(row.body_json)) })),
      ).toEqual([
        { signal_id: "sig-old-1", position: 0, kind: "file", body_json: { sha256: sha("a"), byteLength: 130109, mediaType: "image/png", displayName: "before.png" }, caption: "Before" },
        { signal_id: "sig-old-1", position: 1, kind: "file", body_json: { sha256: sha("b"), byteLength: 56078, mediaType: "image/png", displayName: "after.png" }, caption: null },
        { signal_id: "sig-old-2", position: 0, kind: "file", body_json: { sha256: sha("c"), byteLength: 7, mediaType: "text/markdown", displayName: "notes.md" }, caption: "Notes" },
      ]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("bounds neither how many parts a signal has nor a caption's length, and lets parts go with their signal", async () => {
    const database = await openCopy();
    try {
      migrateStateSchema(database);
      raiseSignal(database, "sig-1");
      const insert = database.prepare(
        "INSERT INTO agent_signal_parts(signal_id, position, kind, body_json, caption) VALUES (?, ?, ?, ?, ?)",
      );
      const body = JSON.stringify({ sha256: sha("a"), byteLength: 1, mediaType: "image/png", displayName: "a.png" });
      for (let position = 0; position < 200; position += 1) insert.run("sig-1", position, "file", body, null);
      insert.run("sig-1", 200, "file", body, "x".repeat(5000));
      // A kind this version does not draw is still held.
      insert.run("sig-1", 201, "commit", JSON.stringify({ sha: "abc1234" }), null);
      expect(database.prepare("SELECT COUNT(*) AS n FROM agent_signal_parts").get()).toEqual({ n: 202 });

      // Still refused: a place taken twice, a signal that does not exist, a body that is not an object, an empty caption or kind.
      expect(() => insert.run("sig-1", 0, "file", body, null)).toThrow();
      expect(() => insert.run("nope", 0, "file", body, null)).toThrow();
      expect(() => insert.run("sig-1", -1, "file", body, null)).toThrow();
      expect(() => insert.run("sig-1", 300, "file", "not json", null)).toThrow();
      expect(() => insert.run("sig-1", 300, "file", "[]", null)).toThrow();
      expect(() => insert.run("sig-1", 300, "file", body, "")).toThrow();
      expect(() => insert.run("sig-1", 300, "", body, null)).toThrow();

      database.prepare("DELETE FROM agent_signals WHERE signal_id = 'sig-1'").run();
      expect(database.prepare("SELECT COUNT(*) AS n FROM agent_signal_parts").get()).toEqual({ n: 0 });
    } finally {
      database.close();
    }
  });
});
