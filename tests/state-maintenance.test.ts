import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  analyzeTables,
  checkpoint,
  openMaintenanceDatabase,
} from "../src/main/junto/state/maintenance-worker";

// The maintenance writer runs a closed set of commands that change no row
// (operator ruling 2026-10-30): a passive checkpoint and a bounded ANALYZE.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const writerOn = () => {
  const root = mkdtempSync(join(tmpdir(), "junto-maintenance-"));
  roots.push(root);
  const path = join(root, "junto.db");
  const writer = new DatabaseSync(path);
  writer.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE mail (id INTEGER PRIMARY KEY, box TEXT NOT NULL, body TEXT NOT NULL);
    CREATE INDEX mail_box ON mail (box);
  `);
  const insert = writer.prepare("INSERT INTO mail (box, body) VALUES (?, ?)");
  writer.exec("BEGIN");
  for (let index = 0; index < 2_000; index += 1) insert.run(`box-${index % 20}`, "x".repeat(500));
  writer.exec("COMMIT");
  return { path, writer };
};

const rowsOf = (database: DatabaseSync) =>
  database.prepare("SELECT count(*) AS n, sum(length(body)) AS bytes, max(id) AS top FROM mail").get();

describe("state maintenance writer", () => {
  test("a passive checkpoint moves the writer's log while the writer stays open", () => {
    const { path, writer } = writerOn();
    const maintenance = openMaintenanceDatabase(path);
    const first = checkpoint(maintenance);
    expect(first.log).toBeGreaterThan(0);
    expect(first.checkpointed).toBe(first.log);
    writer.prepare("INSERT INTO mail (box, body) VALUES ('box-1', 'after')").run();
    expect(rowsOf(maintenance)).toEqual(rowsOf(writer));
    maintenance.close();
    writer.close();
  });

  test("ANALYZE writes statistics, one table at a time, and no row", () => {
    const { path, writer } = writerOn();
    const before = rowsOf(writer);
    const maintenance = openMaintenanceDatabase(path);
    expect(analyzeTables(maintenance)).toEqual({ analyzed: 1, skipped: 0 });
    const stats = writer.prepare("SELECT tbl, idx FROM sqlite_stat1 ORDER BY idx").all();
    expect(stats).toEqual([{ tbl: "mail", idx: "mail_box" }]);
    expect(rowsOf(writer)).toEqual(before);
    maintenance.close();
    writer.close();
  });

  test("a table the writer holds locked is left for the next round, not waited on", () => {
    const { path, writer } = writerOn();
    const maintenance = openMaintenanceDatabase(path);
    writer.exec("BEGIN IMMEDIATE");
    const started = performance.now();
    expect(analyzeTables(maintenance)).toEqual({ analyzed: 0, skipped: 1 });
    expect(performance.now() - started).toBeLessThan(1_000);
    writer.exec("COMMIT");
    expect(analyzeTables(maintenance)).toEqual({ analyzed: 1, skipped: 0 });
    maintenance.close();
    writer.close();
  });
});
