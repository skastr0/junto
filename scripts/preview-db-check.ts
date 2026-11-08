import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileSha256 } from "./preview-snapshot";

const identifier = (name: string) => '"' + name.replaceAll('"', '""') + '"';
type Row = Record<string, unknown>;

const tables = (db: DatabaseSync): string[] =>
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => String(row.name));
const columns = (db: DatabaseSync, table: string): string[] =>
  db.prepare(`SELECT name FROM pragma_table_info(${"'" + table.replaceAll("'", "''") + "'"})`).all().map(row => String(row.name));
const count = (db: DatabaseSync, table: string): number =>
  Number(db.prepare(`SELECT count(*) AS n FROM ${identifier(table)}`).get()?.n);

/**
 * Compares a migrated copy with its untouched baseline, whatever schema each
 * is at: health, every table's row count, and the canvases and seats rows on
 * the columns both schemas still have. A step that drops a column is not a
 * change; a step that rewrites a kept column's value is.
 */
const sameRows = (before: DatabaseSync, after: DatabaseSync, table: string, key: readonly string[]) => {
  const shared = columns(before, table).filter(column => columns(after, table).includes(column));
  const select = `SELECT ${shared.map(identifier).join(",")} FROM ${identifier(table)} ORDER BY ${key.map(identifier).join(",")}`;
  const rowKey = (row: Row) => key.map(column => String(row[column])).join("/");
  const old = new Map((before.prepare(select).all() as Row[]).map(row => [rowKey(row), row]));
  const next = new Map((after.prepare(select).all() as Row[]).map(row => [rowKey(row), row]));
  const changed: Array<{ key: string; changes: Record<string, { before: unknown; after: unknown }> }> = [];
  for (const [id, row] of old) {
    const migrated = next.get(id);
    if (migrated === undefined) { changed.push({ key: id, changes: { row: { before: "present", after: "missing" } } }); continue; }
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const column of shared) if (row[column] !== migrated[column]) changes[column] = { before: row[column], after: migrated[column] };
    if (Object.keys(changes).length) changed.push({ key: id, changes });
  }
  const added = [...next.keys()].filter(id => !old.has(id));
  return { table, compared: shared, before: old.size, after: next.size, changed, added };
};

export const checkPreview = (home: string) => {
  const baselinePath = join(home, "before", "junto.db");
  const manifest = JSON.parse(readFileSync(join(home, "snapshot.json"), "utf8")) as { beforeSha256: string };
  const before = new DatabaseSync(baselinePath, { readOnly: true });
  const after = new DatabaseSync(join(home, ".junto", "state", "junto.db"), { readOnly: true });
  try {
    before.exec("PRAGMA query_only=ON; BEGIN");
    after.exec("PRAGMA query_only=ON; BEGIN");
    const failures: string[] = [];
    const unchangedBaseline = fileSha256(baselinePath) === manifest.beforeSha256;
    if (!unchangedBaseline) failures.push("Untouched baseline hash changed");
    const health = (db: DatabaseSync) => ({ version: Number(db.prepare("PRAGMA user_version").get()?.user_version),
      integrity: db.prepare("PRAGMA integrity_check").all(), foreignKeys: db.prepare("PRAGMA foreign_key_check").all() });
    const baselineHealth = health(before), previewHealth = health(after);
    for (const [label, h] of [["before", baselineHealth], ["after", previewHealth]] as const) {
      if (h.integrity.length !== 1 || h.integrity[0]?.integrity_check !== "ok" || h.foreignKeys.length) failures.push(`${label}: database health check failed`);
    }
    if (previewHealth.version < baselineHealth.version) failures.push(`schema went back from ${baselineHealth.version} to ${previewHealth.version}`);

    const oldTables = tables(before), newTables = tables(after);
    const rowCounts = [...new Set([...oldTables, ...newTables])].sort().map(table => {
      const previous = oldTables.includes(table) ? count(before, table) : null;
      const current = newTables.includes(table) ? count(after, table) : null;
      if (previous !== null && current !== null && previous !== current) failures.push(`${table}: ${previous} rows before, ${current} after`);
      if (previous !== null && previous > 0 && current === null) failures.push(`${table}: dropped with ${previous} rows`);
      return { table, before: previous, after: current };
    });

    const identity = [sameRows(before, after, "canvases", ["canvas_name"]), sameRows(before, after, "seats", ["canvas_name", "id"])];
    for (const result of identity) {
      if (result.changed.length) failures.push(`${result.table}: ${result.changed.length} rows changed or missing`);
      if (result.added.length) failures.push(`${result.table}: ${result.added.length} rows added`);
    }
    return { ok: failures.length === 0, unchangedBaseline, baselineHealth, previewHealth, rowCounts, identity, failures };
  } finally { before.close(); after.close(); }
};

if (process.argv[1]?.endsWith("/preview-db-check.ts") || process.argv[1]?.endsWith("/preview-db-check.mjs") || process.argv[1]?.endsWith("/preview-db-check.js")) {
  const result = checkPreview(resolve(process.env.JUNTO_HOME ?? join(homedir(), ".junto-preview-copy")));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
