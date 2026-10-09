/**
 * State migration 19 -> 20 makes the session each seat row names the seat's
 * open session in the seat sessions store, and gives every session there its
 * binding. Proven on both shipped fixtures brought to version 19 by the real
 * steps, with seats and sessions of every shape the step has to handle: every
 * session already recorded survives, and every other table is untouched.
 */
import { copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { seatSessionNotesPath } from "../src/main/junto/seat-sessions/notes-file";
import {
  CURRENT_STATE_SCHEMA_IDENTITY,
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V19_IDENTITY,
  STATE_SCHEMA_V20_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { STATE_SCHEMA_V19_SQL } from "./fixtures/state-v1/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** The database sits where an installed one does, so the notes path is derived the same way. */
const openCopy = async (fixture: string): Promise<{ database: DatabaseSync; seatsRoot: string }> => {
  // The step derives the notes path from the path the database reports, which is the real one.
  dir = await realpath(await mkdtemp(join(tmpdir(), "junto-seat-pins-migration-")));
  const state = join(dir, ".junto", "state");
  await mkdir(state, { recursive: true });
  const path = join(state, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v1/${fixture}`, import.meta.url)), path);
  const database = new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON");
  return { database, seatsRoot: join(dir, ".junto", "seats") };
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

const versionNineteenPlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 19,
  currentSchemaSql: STATE_SCHEMA_V19_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 19),
};

const at = "2026-10-09T00:00:00.000Z";

/**
 * Five seats: one pinned and never recorded, one pinned and open already, one
 * pinned to a session that ended, one with no pin, and one with an open
 * session and no pin.
 */
const seed = (database: DatabaseSync): void => {
  database
    .prepare("INSERT OR IGNORE INTO canvases(canvas_name, canvas_id, created_at, updated_at) VALUES ('factory', 'canvas-factory', ?, ?)")
    .run(at, at);
  const canvas = "factory";
  const seat = database.prepare(
    `INSERT INTO seats(canvas_name, id, x, y, width, height, z_index, created_at, updated_at,
       agent_key, label, host, binding_id, harness, session_id, on_remove, overseer)
     VALUES (?, ?, 0, 0, 240, 100, 0, ?, ?, 'local:claude', ?, 'local', ?, 'claude', ?, 'detach', 0)`,
  );
  for (const [id, session] of [
    ["pinned", "pin-never-recorded"],
    ["open", "pin-open"],
    ["ended", "pin-ended"],
    ["unpinned", null],
    ["running", null],
  ] as const) {
    seat.run(canvas, id, at, at, id, `binding-${id}`, session);
  }
  const session = database.prepare(
    `INSERT INTO seat_sessions(seat_id, session_id, harness, notes_path, started_at, ended_at, end_reason)
     VALUES (?, ?, 'claude', ?, ?, ?, ?)`,
  );
  session.run("open", "pin-open", "/notes/open.md", 10, null, null);
  session.run("open", "an-older-session", "/notes/open-older.md", 5, 9, "replaced");
  session.run("ended", "pin-ended", "/notes/ended.md", 20, 30, "offboard");
  session.run("running", "running-now", "/notes/running.md", 40, null, null);
};

describe("state migration 19 -> 20 (seat session pins)", () => {
  it("freezes the version-nineteen witness the step starts from and names the head", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V19_SQL)).toEqual(STATE_SCHEMA_V19_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(STATE_SCHEMA_V20_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(expectedStateSchemaIdentity(STATE_SCHEMA_SQL));
  });

  it.each(["command-center-v1.db", "remote-v1.db"])(
    "pins every seat of %s in the seat sessions store and keeps every session it had",
    async (fixture) => {
      const { database, seatsRoot } = await openCopy(fixture);
      try {
        migrateStateSchema(database, versionNineteenPlan);
        database.exec("PRAGMA foreign_keys = OFF");
        seed(database);
        database.exec("PRAGMA foreign_keys = ON");
        const { seat_sessions: sessionsBefore, ...before } = snapshot(database);

        const result = migrateStateSchema(database);
        expect(result).toMatchObject({ previousVersion: 19, schemaVersion: 20 });
        expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V20_IDENTITY);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        const { seat_sessions: _sessions, ...rest } = snapshot(database);
        expect(rest).toEqual(before);

        const sessions = database
          .prepare("SELECT seat_id, session_id, notes_path, started_at, ended_at, end_reason, binding_id FROM seat_sessions ORDER BY seat_id, session_id")
          .all();
        expect(sessions.length).toBe((sessionsBefore as unknown[]).length + 1);
        expect(sessions).toEqual([
          // Reopened with its history: the notes path and the start it had.
          { seat_id: "ended", session_id: "pin-ended", notes_path: "/notes/ended.md", started_at: 20, ended_at: null, end_reason: null, binding_id: "binding-ended" },
          { seat_id: "open", session_id: "an-older-session", notes_path: "/notes/open-older.md", started_at: 5, ended_at: 9, end_reason: "replaced", binding_id: null },
          { seat_id: "open", session_id: "pin-open", notes_path: "/notes/open.md", started_at: 10, ended_at: null, end_reason: null, binding_id: "binding-open" },
          // The one new row: a pin nothing had recorded.
          {
            seat_id: "pinned",
            session_id: "pin-never-recorded",
            notes_path: seatSessionNotesPath(seatsRoot, "pinned", "pin-never-recorded"),
            started_at: expect.any(Number),
            ended_at: null,
            end_reason: null,
            binding_id: "binding-pinned",
          },
          { seat_id: "running", session_id: "running-now", notes_path: "/notes/running.md", started_at: 40, ended_at: null, end_reason: null, binding_id: "binding-running" },
        ]);
        // One open session per seat still holds.
        expect(() =>
          database
            .prepare("INSERT INTO seat_sessions(seat_id, session_id, harness, notes_path, started_at) VALUES ('open', 'a-second-open', 'claude', '/n.md', 1)")
            .run(),
        ).toThrow();
        expect(migrateStateSchema(database)).toMatchObject({ previousVersion: 20, initialized: false });
      } finally {
        database.close();
      }
    },
  );
});
