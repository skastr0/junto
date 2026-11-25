/**
 * Step 76 lets a signal stand in a thread and come after other signals
 * (0.12, threads parts 7 and 8): `agent_signals` gains `thread_id`,
 * `message_id` and `follows_signal_id`, two indexes read a seat's signals in
 * a thread and its newest, and `agent_signal_depends` keeps what a signal
 * comes after. Each shipped fixture is replayed to version 75 on the
 * production DDL, triggers active, with its immutable log as shipped, and
 * seeded with signals of every state as version 75 wrote them. The step
 * moves no row; every old signal then reads with no thread and ready, both
 * through the step and through the real boot.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V75_IDENTITY,
  STATE_SCHEMA_V76_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationDatabase,
  type StateSchemaMigrationPlan,
} from "../src/core/state/migrations";
import { migrateMachineNames } from "../src/core/state/migrate-machine-names";
import { expectedStateSchemaIdentity } from "../src/core/state/schema-identity";
import { makeStateEngineLive } from "../src/core/state/engine";
import { AgentSignalRepository, AgentSignalRepositoryLive } from "../src/core/signals/repository";
import { signalReadiness } from "../src/shared/agent-signals";
import { STATE_SCHEMA_V75_SQL, STATE_SCHEMA_V76_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<{ readonly database: DatabaseSync; readonly path: string }> => {
  dir = await mkdtemp(join(tmpdir(), "junto-signal-thread-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v13/${fixture}`, import.meta.url)), path);
  const database = new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON");
  return { database, path };
};

const upTo = (version: number, currentSchemaSql: string): StateSchemaMigrationPlan => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version).map((step) =>
    step.toVersion === 21
      ? { ...step, migrate: (database: StateSchemaMigrationDatabase) => migrateMachineNames(database, "macbook") }
      : step,
  ),
});

const tables = (database: DatabaseSync): ReadonlyArray<string> =>
  (database.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'state_schema_identity' ORDER BY name`)
    .all() as unknown as ReadonlyArray<{ readonly name: SQLOutputValue }>).map(({ name }) => String(name));

const rows = (database: DatabaseSync, table: string) =>
  (database.prepare(`SELECT * FROM "${table}"`).all() as unknown as ReadonlyArray<Record<string, unknown>>)
    .map((row) => JSON.stringify(row))
    .sort();

const CANVAS = "factory";
const SEAT = "agent-01M8AAAAAAAAAAAAAAAAAAAAAA";

/** Signals of every state as version 75 wrote them, with their parts. */
const seedAt75 = (database: DatabaseSync): void => {
  database.exec(`
    INSERT INTO agent_signals(signal_id, canvas_name, node_id, kind, text, detail, created_at, state, response_text, response_at, closed_at)
    VALUES
      ('01M8S00000000000000000000A', '${CANVAS}', '${SEAT}', 'blocked', 'need the key', '## why', 1, 'open', NULL, NULL, NULL),
      ('01M8S00000000000000000000B', '${CANVAS}', '${SEAT}', 'escalate', 'pick a db', NULL, 2, 'answered', 'use sqlite', 5, 5),
      ('01M8S00000000000000000000C', '${CANVAS}', '${SEAT}', 'feedback', 'ready for review', NULL, 3, 'dismissed', NULL, NULL, 6),
      ('01M8S00000000000000000000D', '${CANVAS}', '${SEAT}', 'feedback', 'never mind', NULL, 4, 'withdrawn', NULL, NULL, 7);
    INSERT INTO agent_signal_parts(signal_id, position, kind, body_json, caption)
    VALUES
      ('01M8S00000000000000000000A', 0, 'link', '{"url":"https://example.com"}', 'the page'),
      ('01M8S00000000000000000000A', 1, 'suggest', '{"text":"here it is"}', NULL);
  `);
};

describe("state migration 75 -> 76 (a signal in a thread, after other signals)", () => {
  it("starts from the version-75 witness and ends at the version-76 one", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V75_SQL)).toEqual(STATE_SCHEMA_V75_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V76_SQL)).toEqual(STATE_SCHEMA_V76_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "adds the columns and the table to %s, empty, and moves no row",
    async (fixture) => {
      const { database } = await openCopy(fixture);
      try {
        expect(migrateStateSchema(database, upTo(75, STATE_SCHEMA_V75_SQL))).toMatchObject({
          schemaVersion: 75,
          ...STATE_SCHEMA_V75_IDENTITY,
        });
        seedAt75(database);
        const events = Number((database.prepare("SELECT COUNT(*) AS n FROM work_events").get() as { n: number }).n);
        expect(events).toBeGreaterThan(0);
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));

        expect(migrateStateSchema(database, upTo(76, STATE_SCHEMA_V76_SQL))).toMatchObject({
          previousVersion: 75,
          schemaVersion: 76,
          ...STATE_SCHEMA_V76_IDENTITY,
        });

        const after = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        const { agent_signals: signals, agent_signal_depends: depends, ...rest } = after;
        const { agent_signals: signalsBefore, ...restBefore } = before;
        expect(rest).toEqual(restBefore);
        expect(depends).toEqual([]);
        // Every signal keeps its bytes and reads as raised outside a thread.
        expect(signals).toEqual(
          signalsBefore!.map((row) =>
            JSON.stringify({ ...JSON.parse(row), thread_id: null, message_id: null, follows_signal_id: null }),
          ).sort(),
        );

        // The immutable log is still held by its triggers.
        expect(() => database.exec("DELETE FROM work_events")).toThrow(/immutable/);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });

        // The new shape holds its own rules.
        expect(() =>
          database.exec(`INSERT INTO agent_signals(signal_id, canvas_name, node_id, kind, text, created_at, state, message_id)
            VALUES ('01M8S00000000000000000000E', '${CANVAS}', '${SEAT}', 'feedback', 'a mail with no thread', 8, 'open', 'm1')`),
        ).toThrow(/CHECK/);
        expect(() =>
          database.exec(`INSERT INTO agent_signal_depends(signal_id, position, depends_on_signal_id)
            VALUES ('01M8S00000000000000000000A', 0, '01M8S00000000000000000000A')`),
        ).toThrow(/CHECK/);
        database.exec(`INSERT INTO agent_signal_depends(signal_id, position, depends_on_signal_id)
          VALUES ('01M8S00000000000000000000A', 0, '01M8S00000000000000000000B')`);
        expect(() =>
          database.exec(`INSERT INTO agent_signal_depends(signal_id, position, depends_on_signal_id)
            VALUES ('01M8S00000000000000000000A', 1, '01M8S00000000000000000000B')`),
        ).toThrow(/UNIQUE/);
        expect(() =>
          database.exec(`INSERT INTO agent_signal_depends(signal_id, position, depends_on_signal_id)
            VALUES ('01M8S00000000000000000000A', 8, '01M8S00000000000000000000C')`),
        ).toThrow(/CHECK/);
        expect(() =>
          database.exec(`INSERT INTO agent_signal_depends(signal_id, position, depends_on_signal_id)
            VALUES ('01M8S00000000000000000000A', 1, 'not-a-ulid')`),
        ).toThrow(/CHECK/);
        expect(() =>
          database.exec(`UPDATE agent_signals SET thread_id = 'thread-1' WHERE signal_id = '01M8S00000000000000000000B'`),
        ).toThrow(/CHECK/);
        database.exec(`UPDATE agent_signals SET thread_id = '01M8T00000000000000000000A', message_id = '01M8M00000000000000000000A'
          WHERE signal_id = '01M8S00000000000000000000B'`);
        expect(() =>
          database.exec(`UPDATE agent_signals SET thread_id = '01M8T00000000000000000000A', message_id = '01M8M00000000000000000000A'
            WHERE signal_id = '01M8S00000000000000000000C'`),
        ).toThrow(/UNIQUE/);
      } finally {
        database.close();
      }
    },
    60_000,
  );

  it("boots a version-75 store to the head and reads every old signal with no thread, ready", async () => {
    const { database, path } = await openCopy("command-center-v13.db");
    try {
      migrateStateSchema(database, upTo(75, STATE_SCHEMA_V75_SQL));
      seedAt75(database);
    } finally {
      database.close();
    }
    const runtime = ManagedRuntime.make(AgentSignalRepositoryLive.pipe(Layer.provide(makeStateEngineLive(path))));
    try {
      const held = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* (yield* AgentSignalRepository).listCanvas(CANVAS);
        }),
      );
      expect(held.map((signal) => signal.signalId).sort()).toEqual([
        "01M8S00000000000000000000A",
        "01M8S00000000000000000000B",
        "01M8S00000000000000000000C",
        "01M8S00000000000000000000D",
      ]);
      const states = new Map(held.map((signal) => [signal.signalId, signal.state]));
      for (const signal of held) {
        expect(signal.threadId).toBeUndefined();
        expect(signal.messageId).toBeUndefined();
        expect(signal.followsSignalId).toBeUndefined();
        expect(signal.dependsOn).toBeUndefined();
        expect(signalReadiness(signal, (id) => states.get(id))).toEqual({ ready: true, waitingOn: [], notReceived: [] });
      }
      const open = held.find((signal) => signal.signalId === "01M8S00000000000000000000A")!;
      expect(open).toMatchObject({ kind: "blocked", text: "need the key", detail: "## why", state: "open", suggestions: ["here it is"] });
      expect(open.attachments).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
    const reopened = new DatabaseSync(path, { readOnly: true });
    try {
      expect(reopened.prepare("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_STATE_SCHEMA_VERSION });
    } finally {
      reopened.close();
    }
  }, 60_000);
});
