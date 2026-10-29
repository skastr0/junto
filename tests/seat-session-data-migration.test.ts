/**
 * State migration 21 -> 22 keeps seat session data in the database: every
 * session survives with its history, `notes_path` is gone, and the
 * continuation ledger and offboard clock tables exist. The step imports the
 * retired files under `~/.junto/seats` once, whole, for the rows it holds:
 * notes, the note for the next session, who ended a session, when it
 * onboarded, the ledger and the clock. A missing file is skipped, a malformed
 * one skipped and counted, and every file is byte for byte what it was.
 *
 * The version-21 database is made at version 21 (a fresh database takes the
 * witness schema whole), not by replaying 13 -> 21 over a shipped fixture:
 * that replay ran seconds under a loaded full run. It lives in memory, except
 * where the step must find the seats directory beside it, and rows seeded
 * before the step stand in for what a shipped database holds.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V21_IDENTITY,
  STATE_SCHEMA_V22_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V21_SQL, STATE_SCHEMA_V22_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A version-21 database, fresh, at `path`: held in memory, the step finds no seats directory beside it. */
const openAt21 = (path = ":memory:"): DatabaseSync => {
  const database = new DatabaseSync(path, { allowExtension: false, enableForeignKeyConstraints: true });
  expect(migrateStateSchema(database, versionTwentyOnePlan)).toMatchObject({ schemaVersion: 21, ...STATE_SCHEMA_V21_IDENTITY });
  return database;
};

/** A version-21 database, fresh, where Junto keeps it, `<home>/.junto/state/junto.db`, so the step finds `<home>/.junto/seats`. */
const openAt21AtHome = async (): Promise<{ readonly database: DatabaseSync; readonly seatsRoot: string }> => {
  dir = await mkdtemp(join(tmpdir(), "junto-seat-session-data-migration-"));
  const state = join(dir, ".junto", "state");
  await mkdir(state, { recursive: true });
  return { database: openAt21(join(state, "junto.db")), seatsRoot: join(dir, ".junto", "seats") };
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

const versionTwentyOnePlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 21,
  currentSchemaSql: STATE_SCHEMA_V21_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 21),
};

const versionTwentyTwoPlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 22,
  currentSchemaSql: STATE_SCHEMA_V22_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 22),
};

/** An id that is not a plain name: the retired store named its directory or file by a digest. */
const UNSAFE_SEAT = "seat/../escape";
const UNSAFE_SESSION = "a session";
const digest = (id: string): string => `id-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;

/** Sessions as version 21 keeps them: one ended with notes, one open, one replaced, one with unsafe ids. */
const seed = (database: DatabaseSync): void => {
  const insert = database.prepare(
    `INSERT INTO seat_sessions(seat_id, session_id, harness, cwd, transcript_path, notes_path, gist, started_at,
       ended_at, end_reason, offboarded_at, binding_id)
     VALUES (?, ?, 'codex', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run("agent-1", "s1", "/work", "/t/s1.jsonl", "/home/.junto/seats/agent-1/sessions/s1.md", "Shipped it", 10, 20, "offboard", 19, null);
  insert.run("agent-1", "s2", "/work", null, "/home/.junto/seats/agent-1/sessions/s2.md", null, 20, null, null, null, "bind-1");
  insert.run("agent-2", "s3", null, null, "/home/.junto/seats/agent-2/sessions/s3.md", null, 5, 9, "replaced", null, null);
  insert.run(UNSAFE_SEAT, UNSAFE_SESSION, null, null, "/home/x.md", null, 1, 2, "reseat", null, null);
  database
    .prepare("INSERT INTO seat_session_drains(seat_id, session_id, detached_at, ended_at, ended_how) VALUES ('agent-1', 's1', 19, 25, 'settled')")
    .run();
};

/** Rows beside the sessions that the step must leave as they were: a canvas and a seat on it. */
const seedNeighbours = (database: DatabaseSync): void => {
  database.exec(`
    INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at) VALUES ('factory', 'canvas-1', 'now', 'now');
    INSERT INTO seats (canvas_name, id, x, y, width, height, z_index, created_at, updated_at,
      agent_key, label, binding_id, harness, session_id, on_remove, overseer)
    VALUES ('factory', 'agent-1', 0, 0, 100, 100, 0, 'now', 'now', 'key-1', 'Agent', 'bind-1', 'codex', 's2', 'detach', 0);
  `);
};

/** Longer than the 16000 and 8000 a row used to hold, so a cap would show. */
const LONG_NOTES = `# Handoff\n\n${"n".repeat(20_000)}\nend of notes`;
const LONG_NEXT = `Read the handoff.\n${"c".repeat(9_000)}`;

/** One file of every kind the retired store held, with malformed and orphaned ones among them. */
const writeSeatFiles = async (root: string): Promise<void> => {
  const file = async (path: string, text: string) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  };
  await file("agent-1/sessions/s1.md", `\n${LONG_NOTES}\n\n`);
  await file("agent-1/sessions/s1.next.md", `${LONG_NEXT}\n`);
  await file("agent-1/sessions/s1.ended.json", `${JSON.stringify({ by: "operator", at: 21 })}\n`);
  await file("agent-1/sessions/s1.onboarded", "1970-01-01T00:00:00.012Z\n");
  // The open session: who ended it is not kept; its onboarded mark is malformed.
  await file("agent-1/sessions/s2.ended.json", `${JSON.stringify({ by: "automatic", at: 5 })}\n`);
  await file("agent-1/sessions/s2.onboarded", "not a time\n");
  // A session with no row is never looked at.
  await file("agent-1/sessions/ghost.md", "Nobody's notes\n");
  await file("agent-1/continuation.pending", `${JSON.stringify({ bindingId: "bind-1", offboarded: "gen-0", at: 30.7 })}\n`);
  // Malformed, each in its own way: empty notes, a broken marker, a bad owner, a directory where a file was.
  await file("agent-2/sessions/s3.md", "  \n\n");
  await file("agent-2/sessions/s3.ended.json", "{ by: operator");
  await file("agent-2/sessions/s3.onboarded", "2026-10-07T00:42:32.424Z");
  await mkdir(join(root, "agent-2/sessions/s3.next.md"), { recursive: true });
  await file("agent-2/continuation.pending", "{");
  await file("ghost-seat/continuation.pending", `${JSON.stringify({ bindingId: "bind-9", at: 1 })}\n`);
  await file(`${digest(UNSAFE_SEAT)}/sessions/${digest(UNSAFE_SESSION)}.md`, "Kept under a digest\n");
  await file(
    "offboard-clock.json",
    JSON.stringify({
      savedAt: 100.9,
      seats: {
        "bind-1": { idleSince: 50, activitySince: 45, offboarded: true, workMs: 7.5, sessionId: " s2 " },
        "bind-2": { movedAt: 40 },
        "bind-3": { workMs: 3 },
      },
    }),
  );
};

type Tree = Readonly<Record<string, { readonly bytes: string; readonly mtimeMs: number; readonly mode: number }>>;

/** Every entry under the root: a file's bytes, mode and time, a directory as itself. */
const tree = async (root: string): Promise<Tree> => {
  const entries: Record<string, { bytes: string; mtimeMs: number; mode: number }> = {};
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      const info = await stat(full);
      const bytes = entry.isDirectory() ? "<dir>" : (await readFile(full)).toString("base64");
      entries[relative(root, full)] = { bytes, mtimeMs: info.mtimeMs, mode: info.mode };
      if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(root);
  return entries;
};

const sessionsOf = (database: DatabaseSync) =>
  database
    .prepare("SELECT seat_id, session_id, notes, continuation, ended_by, onboarded_at FROM seat_sessions ORDER BY seat_id, session_id")
    .all();

describe("state migration 21 -> 22 (seat session data in the database)", () => {
  it("freezes the witnesses the step starts from and ends at", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V21_SQL)).toEqual(STATE_SCHEMA_V21_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V22_SQL)).toEqual(STATE_SCHEMA_V22_IDENTITY);
  });

  it(
    "keeps every session with its history, without notes_path, and adds the ledger and clock",
    () => {
      const database = openAt21();
      try {
        seedNeighbours(database);
        seed(database);
        const before = snapshot(database);
        expect(before["seat_sessions"]).toHaveLength(4);
        expect(before["seats"]).toHaveLength(1);

        const result = migrateStateSchema(database, versionTwentyTwoPlan);
        expect(result).toMatchObject({ previousVersion: 21, schemaVersion: 22 });
        expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V22_IDENTITY);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const {
          seat_sessions: sessions,
          seat_continuations_owed: owed,
          seat_offboard_clock: clock,
          ...rest
        } = snapshot(database);
        const { seat_sessions: sessionsBefore, ...restBefore } = before;
        expect(rest).toEqual(restBefore);
        // No files under the seats root: nothing to import.
        expect(owed).toEqual([]);
        expect(clock).toEqual([]);
        expect(sessions).toEqual(
          (sessionsBefore as ReadonlyArray<Record<string, unknown>>).map(({ notes_path: _path, ...row }) => ({
            ...row,
            notes: null,
            continuation: null,
            ended_by: null,
            onboarded_at: null,
          })),
        );
        // The drain still belongs to its session.
        expect(database.prepare("SELECT seat_id, session_id FROM seat_session_drains").all()).toEqual([
          { seat_id: "agent-1", session_id: "s1" },
        ]);
      } finally {
        database.close();
      }
    },
  );

  it(
    "imports the retired seat files once, whole, and leaves every file as it was",
    async () => {
      const { database, seatsRoot } = await openAt21AtHome();
      try {
        seed(database);
        await writeSeatFiles(seatsRoot);
        const filesBefore = await tree(seatsRoot);
        const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

        migrateStateSchema(database, versionTwentyTwoPlan);

        expect(await tree(seatsRoot)).toEqual(filesBefore);
        expect(sessionsOf(database)).toEqual([
          { seat_id: "agent-1", session_id: "s1", notes: LONG_NOTES, continuation: LONG_NEXT, ended_by: "operator", onboarded_at: 12 },
          { seat_id: "agent-1", session_id: "s2", notes: null, continuation: null, ended_by: null, onboarded_at: null },
          {
            seat_id: "agent-2",
            session_id: "s3",
            notes: null,
            continuation: null,
            ended_by: null,
            onboarded_at: Date.parse("2026-10-07T00:42:32.424Z"),
          },
          { seat_id: UNSAFE_SEAT, session_id: UNSAFE_SESSION, notes: "Kept under a digest", continuation: null, ended_by: null, onboarded_at: null },
        ]);
        expect(database.prepare("SELECT * FROM seat_continuations_owed").all()).toEqual([
          { seat_id: "agent-1", binding_id: "bind-1", offboarded_generation: "gen-0", owed_at: 30 },
        ]);
        expect(database.prepare("SELECT * FROM seat_offboard_clock ORDER BY binding_id").all()).toEqual([
          { binding_id: "bind-1", idle_since: 50, activity_since: 45, offboarded: 1, work_ms: 7, session_id: "s2", saved_at: 100 },
          { binding_id: "bind-2", idle_since: 40, activity_since: null, offboarded: 0, work_ms: 0, session_id: null, saved_at: 100 },
        ]);

        // Counts only, never content.
        const logged = info.mock.calls.map((call) => call.join(" ")).join("\n");
        expect(logged).toContain(
          "2 notes, 1 continuations, 1 ended marks, 2 onboarded marks, 1 owed continuations, 2 clock entries; 5 malformed skipped",
        );
        expect(logged).not.toMatch(/Handoff|digest|bind-|gen-0|s1|agent-/);

        // Once: the database is at 22, and a second open imports nothing.
        await writeFile(join(seatsRoot, "agent-1/sessions/s2.md"), "Written after the step\n");
        migrateStateSchema(database, versionTwentyTwoPlan);
        expect(database.prepare("SELECT notes FROM seat_sessions WHERE session_id = 's2'").get()).toEqual({ notes: null });
      } finally {
        database.close();
      }
    },
  );

  it("skips and counts a clock it cannot read, and a binding owed to two seats", async () => {
    const { database, seatsRoot } = await openAt21AtHome();
    try {
      seed(database);
      await mkdir(join(seatsRoot, "agent-1"), { recursive: true });
      await mkdir(join(seatsRoot, "agent-2"), { recursive: true });
      await writeFile(join(seatsRoot, "offboard-clock.json"), JSON.stringify({ seats: {} }));
      await writeFile(join(seatsRoot, "agent-1/continuation.pending"), JSON.stringify({ bindingId: "bind-1", at: 1 }));
      await writeFile(join(seatsRoot, "agent-2/continuation.pending"), JSON.stringify({ bindingId: "bind-1", at: 2 }));
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

      migrateStateSchema(database, versionTwentyTwoPlan);

      expect(database.prepare("SELECT seat_id, binding_id, owed_at FROM seat_continuations_owed").all()).toEqual([
        { seat_id: "agent-1", binding_id: "bind-1", owed_at: 1 },
      ]);
      expect(database.prepare("SELECT count(*) AS n FROM seat_offboard_clock").get()).toEqual({ n: 0 });
      expect(info.mock.calls.map((call) => call.join(" ")).join("\n")).toContain("1 owed continuations, 0 clock entries; 2 malformed skipped");
    } finally {
      database.close();
    }
  });

  it("holds notes and the next session's note whole, never empty", () => {
    const database = openAt21();
    try {
      migrateStateSchema(database, versionTwentyTwoPlan);
      const insert = database.prepare(
        "INSERT INTO seat_sessions(seat_id, session_id, harness, started_at, notes, continuation, ended_at, end_reason, ended_by) VALUES ('a', ?, 'codex', 1, ?, ?, 2, 'offboard', ?)",
      );
      insert.run("long", "n".repeat(100_000), "c".repeat(50_000), "operator");
      expect(() => insert.run("empty", "", null, null)).toThrow();
      expect(() => insert.run("empty-next", "n", "", null)).toThrow();
      expect(() => insert.run("who", "n", null, "agent")).toThrow();
    } finally {
      database.close();
    }
  });
});
