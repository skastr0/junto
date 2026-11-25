/**
 * Step 77 keeps both closings of a signal that cross between machines
 * (0.12, remote-work's terms; approved by the operator 2026-11-23). It
 * rebuilds `agent_signals`, the one table it names, with its state CHECKs
 * relaxed and `withdrawn_at` added, and drops nothing.
 *
 * Proven on both shipped fixtures replayed to version 76 on the production
 * DDL, triggers active, their immutable log as shipped, seeded with signals
 * in every state, in threads and after one another, with parts, legacy
 * attachments and rows in `agent_signal_depends`: no row moves, every index
 * and trigger is back as it was, and the new CHECKs admit what the terms
 * admit and refuse the rest. With JUNTO_INSTALLED_DB_COPY set to a disposable
 * copy of an installed database (never a path under ~/.junto), the whole
 * chain runs on it to 76 and the step changes no kept row; it reports counts,
 * hashes and names only, never a row's text.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V76_IDENTITY,
  STATE_SCHEMA_V77_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationDatabase,
  type StateSchemaMigrationPlan,
} from "../src/core/state/migrations";
import { migrateMachineNames } from "../src/core/state/migrate-machine-names";
import { expectedStateSchemaIdentity } from "../src/core/state/schema-identity";
import { STATE_SCHEMA_V76_SQL, STATE_SCHEMA_V77_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (source: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-signal-withdrawn-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(source, path);
  const database = new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
};
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/state-v13/${name}`, import.meta.url));

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

const all = (database: DatabaseSync, sql: string) =>
  database.prepare(sql).all() as unknown as ReadonlyArray<Record<string, SQLOutputValue>>;

const tables = (database: DatabaseSync): ReadonlyArray<string> =>
  all(database, `SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'state_schema_identity' ORDER BY name`)
    .map(({ name }) => String(name));

const rows = (database: DatabaseSync, table: string) =>
  all(database, `SELECT * FROM "${table}"`).map((row) => JSON.stringify(row)).sort();

/** Every index and trigger, by name, as it reads with its spacing folded. */
const objects = (database: DatabaseSync) =>
  Object.fromEntries(
    all(database, `SELECT type, name, tbl_name, sql FROM sqlite_schema
        WHERE type IN ('index', 'trigger') AND name NOT GLOB 'sqlite_*' ORDER BY type, name`)
      .map((row) => [`${String(row.type)}:${String(row.name)}`, `${String(row.tbl_name)} ${String(row.sql ?? "").replace(/\s+/gu, " ").trim()}`]),
  );

const CANVAS = "factory";
const SEAT = "agent-01M8AAAAAAAAAAAAAAAAAAAAAA";
const THREAD = "01M8T00000000000000000000A";
const id = (letter: string) => `01M8S0000000000000000000${letter}0`;

/** Signals of every state as version 76 writes them, with what names them. */
const seedAt76 = (database: DatabaseSync): void => {
  database.exec(`
    INSERT INTO agent_signals(signal_id, canvas_name, node_id, kind, text, detail, source_json, created_at, state,
      response_text, response_at, closed_at, thread_id, message_id, follows_signal_id)
    VALUES
      ('${id("A")}', '${CANVAS}', '${SEAT}', 'blocked', 'need the key', '## why', NULL, 1, 'open', NULL, NULL, NULL, NULL, NULL, NULL),
      ('${id("B")}', '${CANVAS}', '${SEAT}', 'escalate', 'pick a db', NULL, NULL, 2, 'answered', 'use sqlite', 5, 5, '${THREAD}', NULL, NULL),
      ('${id("C")}', '${CANVAS}', '${SEAT}', 'feedback', 'ready for review', NULL, NULL, 3, 'dismissed', NULL, NULL, 6,
        '${THREAD}', '01M8M00000000000000000000A', '${id("B")}'),
      ('${id("D")}', '${CANVAS}', '${SEAT}', 'feedback', 'never mind', NULL, NULL, 4, 'withdrawn', NULL, NULL, 7, NULL, NULL, NULL),
      ('${id("E")}', '${CANVAS}', '${SEAT}', 'notice', 'the run finished', NULL,
        '{"kind":"automation","automationId":"01M8U00000000000000000000A","nodeId":"${SEAT}"}', 8, 'open', NULL, NULL, NULL, NULL, NULL, NULL);
    INSERT INTO agent_signal_parts(signal_id, position, kind, body_json, caption)
    VALUES
      ('${id("A")}', 0, 'link', '{"url":"https://example.com"}', 'the page'),
      ('${id("A")}', 1, 'suggest', '{"text":"here it is"}', NULL),
      ('${id("B")}', 0, 'answer-reply', '{"kind":"links","links":["https://example.com/proof"]}', NULL);
    INSERT INTO agent_signal_attachments(signal_id, position, sha256, byte_length, media_type, display_name, caption)
    VALUES ('${id("A")}', 0, '${"a".repeat(64)}', 10, 'image/png', 'shot.png', NULL);
    INSERT INTO agent_signal_depends(signal_id, position, depends_on_signal_id)
    VALUES
      ('${id("A")}', 0, '${id("B")}'),
      ('${id("A")}', 1, '${id("C")}'),
      ('${id("E")}', 0, '01M8S000000000000000000ZZZ');
  `);
};

const digest = (lines: ReadonlyArray<string>): string =>
  createHash("sha256").update([...lines].sort().join("\n")).digest("hex");

/**
 * What a store holds, as counts, hashes and names only. A kept signal row is
 * hashed without `withdrawn_at`, the one column step 77 adds.
 */
const census = (database: DatabaseSync) => {
  const names = tables(database);
  const objectSql = objects(database);
  const kept = (row: Record<string, SQLOutputValue>) => {
    const { withdrawn_at: _withdrawn, ...rest } = row;
    return JSON.stringify(rest, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
  };
  return {
    counts: Object.fromEntries(names.map((table) => [table, Number(all(database, `SELECT COUNT(*) AS n FROM "${table}"`)[0]!.n)])),
    signalsHash: digest(all(database, "SELECT * FROM agent_signals").map(kept)),
    dependsHash: digest(rows(database, "agent_signal_depends")),
    tablesHash: digest(names.filter((table) => table !== "agent_signals").flatMap((table) => rows(database, table).map((row) => `${table} ${row}`))),
    objectsHash: digest(Object.entries(objectSql).map(([key, sql]) => `${key} ${sql}`)),
    triggers: Object.keys(objectSql).filter((key) => key.startsWith("trigger:")).map((key) => key.slice(8)),
    indexes: Object.keys(objectSql).filter((key) => key.startsWith("index:")).map((key) => key.slice(6)),
  };
};

/** Step 77 on a database at 76: every kept row and object as it was. */
const proveStep = (database: DatabaseSync): void => {
  const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
  const objectsBefore = objects(database);

  expect(migrateStateSchema(database, upTo(77, STATE_SCHEMA_V77_SQL))).toMatchObject({
    previousVersion: 76,
    schemaVersion: 77,
    ...STATE_SCHEMA_V77_IDENTITY,
  });

  const after = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  const { agent_signals: signals, ...rest } = after;
  const { agent_signals: signalsBefore, ...restBefore } = before;
  expect(rest).toEqual(restBefore);
  expect(signals).toEqual(
    signalsBefore!.map((row) => JSON.stringify({ ...JSON.parse(row), withdrawn_at: null })).sort(),
  );
  expect(objects(database)).toEqual(objectsBefore);
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
};

describe("state migration 76 -> 77 (both closings of a signal that cross)", () => {
  it("starts from the version-76 witness and ends at the version-77 one", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V76_SQL)).toEqual(STATE_SCHEMA_V76_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V77_SQL)).toEqual(STATE_SCHEMA_V77_IDENTITY);
  });

  it("names agent_signals as the one table it rebuilds, and drops none", () => {
    const step = STATE_SCHEMA_MIGRATIONS.find((candidate) => candidate.toVersion === 77)!;
    expect(step).toMatchObject({ fromVersion: 76, safety: "consolidate", replacesTables: ["agent_signals"] });
    expect(step.removesTables).toBeUndefined();
    expect(step.renamesTables).toBeUndefined();
    expect(step.retiresColumns).toBeUndefined();
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "rebuilds agent_signals in %s and moves no row, index or trigger",
    async (name) => {
      const database = await openCopy(fixture(name));
      try {
        expect(migrateStateSchema(database, upTo(76, STATE_SCHEMA_V76_SQL))).toMatchObject({
          schemaVersion: 76,
          ...STATE_SCHEMA_V76_IDENTITY,
        });
        seedAt76(database);
        expect(Number(all(database, "SELECT COUNT(*) AS n FROM work_events")[0]!.n)).toBeGreaterThan(0);
        expect(Object.keys(objects(database)).filter((key) => key.startsWith("trigger:")).length).toBeGreaterThan(0);

        proveStep(database);

        // The immutable log is still held by its triggers.
        expect(() => database.exec("DELETE FROM work_events")).toThrow(/immutable/);
        // A signal's parts and what it comes after still go with it.
        database.exec(`DELETE FROM agent_signals WHERE signal_id = '${id("A")}'`);
        expect(all(database, `SELECT COUNT(*) AS n FROM agent_signal_parts WHERE signal_id = '${id("A")}'`)[0]!.n).toBe(0);
        expect(all(database, `SELECT COUNT(*) AS n FROM agent_signal_depends WHERE signal_id = '${id("A")}'`)[0]!.n).toBe(0);
        expect(all(database, `SELECT COUNT(*) AS n FROM agent_signal_attachments WHERE signal_id = '${id("A")}'`)[0]!.n).toBe(0);
      } finally {
        database.close();
      }
    },
    60_000,
  );

  it("admits both closings as the terms write them, and refuses the rest", async () => {
    const database = await openCopy(fixture("command-center-v13.db"));
    try {
      migrateStateSchema(database, upTo(77, STATE_SCHEMA_V77_SQL));
      const insert = (signalId: string, state: string, closedAt: number | null, response: string | null, withdrawnAt: number | null | string) =>
        database.exec(`INSERT INTO agent_signals(signal_id, canvas_name, node_id, kind, text, created_at, state,
            response_text, response_at, closed_at, withdrawn_at)
          VALUES ('${signalId}', '${CANVAS}', '${SEAT}', 'escalate', 'pick', 1, '${state}',
            ${response === null ? "NULL" : `'${response}'`}, ${response === null ? "NULL" : 9},
            ${closedAt === null ? "NULL" : closedAt}, ${withdrawnAt === null ? "NULL" : typeof withdrawnAt === "string" ? `'${withdrawnAt}'` : withdrawnAt})`);

      // A late answer beside a withdrawal, on the seat's machine.
      insert(id("F"), "withdrawn", 7, "use sqlite", null);
      // A late withdrawal beside an answer, on the editing machine, earlier than the answer by another clock.
      insert(id("G"), "answered", 7, "use sqlite", 3);
      // What the old CHECKs admitted still goes in.
      insert(id("H"), "answered", 7, "use sqlite", null);
      insert(id("J"), "withdrawn", 7, null, null);
      insert(id("K"), "dismissed", 7, null, null);
      insert(id("M"), "open", null, null, null);

      expect(() => insert(id("N"), "answered", 7, null, null)).toThrow(/CHECK/);
      expect(() => insert(id("P"), "open", null, "early", null)).toThrow(/CHECK/);
      expect(() => insert(id("Q"), "dismissed", 7, "late", null)).toThrow(/CHECK/);
      expect(() => insert(id("R"), "withdrawn", 7, null, 3)).toThrow(/CHECK/);
      expect(() => insert(id("S"), "open", null, null, 3)).toThrow(/CHECK/);
      expect(() => insert(id("T"), "answered", 7, "use sqlite", -1)).toThrow(/CHECK/);
      expect(() => insert(id("V"), "answered", 7, "use sqlite", "soon")).toThrow(/CHECK|cannot store/);
      expect(() =>
        database.exec(`UPDATE agent_signals SET response_text = 'x', response_at = NULL WHERE signal_id = '${id("J")}'`),
      ).toThrow(/CHECK/);
    } finally {
      database.close();
    }
  }, 60_000);

  const installed = process.env.JUNTO_INSTALLED_DB_COPY;
  it.runIf(installed !== undefined)(
    "rebuilds agent_signals in a disposable copy of an installed database and changes no kept row",
    async () => {
      // The proof reads a copy, never the installed store.
      const source = resolve(installed!);
      const home = resolve(homedir(), ".junto");
      expect(source === home || source.startsWith(`${home}${sep}`), "the proof takes a copy, never a path under ~/.junto").toBe(false);
      const database = await openCopy(source);
      try {
        const version = Number(all(database, "PRAGMA user_version")[0]!.user_version);
        expect(version).toBeLessThanOrEqual(76);
        if (version < 76) migrateStateSchema(database, upTo(76, STATE_SCHEMA_V76_SQL));
        const before = census(database);
        expect(migrateStateSchema(database, upTo(77, STATE_SCHEMA_V77_SQL))).toMatchObject({
          previousVersion: 76,
          schemaVersion: 77,
          ...STATE_SCHEMA_V77_IDENTITY,
        });
        const after = census(database);
        // Counts, hashes and names only: no row's text is ever printed.
        console.log(JSON.stringify({
          startedAt: version,
          endedAt: Number(all(database, "PRAGMA user_version")[0]!.user_version),
          counts: Object.fromEntries(Object.keys(before.counts).map((table) => [table, [before.counts[table], after.counts[table]]])),
          agentSignals: { before: before.signalsHash, after: after.signalsHash },
          agentSignalDepends: { before: before.dependsHash, after: after.dependsHash },
          triggers: before.triggers,
          indexes: before.indexes,
        }, null, 1));
        expect(after.counts, "row counts per table").toEqual(before.counts);
        expect(after.signalsHash, "agent_signals kept rows").toBe(before.signalsHash);
        expect(after.dependsHash, "agent_signal_depends rows").toBe(before.dependsHash);
        expect(after.tablesHash, "every other table's rows").toBe(before.tablesHash);
        expect(after.objectsHash, "triggers and indexes").toBe(before.objectsHash);
        expect(after.triggers).toEqual(before.triggers);
        expect(after.indexes).toEqual(before.indexes);
        expect(database.prepare("PRAGMA foreign_key_check").all().length, "foreign key faults").toBe(0);
        expect(String((database.prepare("PRAGMA integrity_check").get() as { integrity_check: unknown }).integrity_check)).toBe("ok");
      } finally {
        database.close();
      }
    },
    600_000,
  );
});
