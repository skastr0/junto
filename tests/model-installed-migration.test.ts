import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { CURRENT_STATE_SCHEMA_VERSION, migrateStateSchema } from "../src/main/junto/state/migrations";
import { KIND_TABLES } from "../src/main/junto/model/state-schema";

const baseline = process.env.JUNTO_MODEL_INSTALLED_COPY;
const digest = (database: DatabaseSync, table: string) => createHash("sha256").update(
  database.prepare(`SELECT * FROM "${table}"`).all().map((row) => JSON.stringify(row)).sort().join("\n"),
).digest("hex");
it.skipIf(!baseline)("migrates a disposable installed copy and preserves all unrelated durable rows", () => {
  const path = join(mkdtempSync(join(tmpdir(), "junto-v13-proof-")), "copy.db");
  copyFileSync(baseline!, path);
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    const retired = new Set(["canvas_nodes", "canvas_edges", "canvas_documents", "canvas_entities", "canvas_portfolio_head", "state_schema_identity", "work_facts"]);
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => String(row.name));
    const before = new Map(tables.filter((name) => !retired.has(name)).map((name) => [name, digest(db, name)]));
    const objects = Number(db.prepare("SELECT count(*) AS n FROM canvas_nodes").get()!.n);
    const wires = Number(db.prepare("SELECT count(*) AS n FROM canvas_edges").get()!.n);
    const facts = Number(db.prepare("SELECT count(*) AS n FROM work_facts").get()!.n);
    const report = migrateStateSchema(db);
    expect(report.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
    expect(db.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    for (const [table, hash] of before) expect(digest(db, table), table).toBe(hash);
    expect(Object.values(KIND_TABLES).reduce((sum, table) => sum + Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n), 0)).toBe(objects);
    expect(Number(db.prepare("SELECT count(*) AS n FROM wires").get()!.n)).toBe(wires);
    expect(Number(db.prepare("SELECT count(*) AS n FROM work_facts").get()!.n)).toBe(facts);
    expect(db.prepare("SELECT DISTINCT basis_kind FROM work_facts").all()).toEqual([{basis_kind: "historical"}]);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='app_texts'").get()!.n).toBe(1);
    expect(migrateStateSchema(db).initialized).toBe(false);
    console.log(JSON.stringify({ path, ...report, objects, wires, facts, unchangedTables: before.size }));
  } finally { db.close(); }
}, 30000);
