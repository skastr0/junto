/**
 * Upgrade-proof homes always carry sqlite_stat1.
 *
 * The release proof opens an older installed database with the new build. An
 * installed database has run ANALYZE (the maintenance worker does it a minute
 * after every boot, src/core/state/maintenance.ts), so it holds sqlite_stat1,
 * and a table-rebuild migration's DROP TABLE deletes that table's stat rows.
 * A home seeded fresh on a VM never ran ANALYZE: 0.12.0 passed its proof and
 * shipped a SQLITE_AUTH crash on every real home (fixed in 8030eb86d).
 *
 *   node scripts/upgrade-proof-analyze.ts prepare <junto.db>   ANALYZE, then require stat rows
 *   node scripts/upgrade-proof-analyze.ts check <junto.db>     read-only: require stat rows
 *
 * Run `prepare` on each seeded home with the app closed, before the upgrade
 * open; scripts/upgrade-proof-open.sh refuses a home that fails `check`.
 * Self-contained so plain `node` runs it. Prints counts only, never row text.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export type ProofHomeStats = {
  readonly userVersion: number;
  /** Rows in sqlite_stat1: one per analysed table or index. */
  readonly statRows: number;
  /** Tables with at least one stat row. */
  readonly statTables: number;
};

const REAL_HOME_DB = (): string => join(homedir(), ".junto", "state", "junto.db");

const refuseOperatorDatabase = (dbPath: string): string => {
  const resolved = resolve(dbPath);
  if (resolved === REAL_HOME_DB() || resolved === join(resolve(process.env.JUNTO_HOME ?? REAL_HOME_DB()), "state", "junto.db")) {
    throw new Error(`refusing the operator's own database: ${resolved}; a proof home is a throwaway copy on a VM`);
  }
  if (!existsSync(resolved)) throw new Error(`no database at ${resolved}`);
  return resolved;
};

const readStats = (database: DatabaseSync): ProofHomeStats => {
  const userVersion = Number(database.prepare("PRAGMA user_version").get()?.user_version);
  const table = database.prepare("SELECT 1 AS present FROM sqlite_schema WHERE name = 'sqlite_stat1'").get();
  if (table === undefined) {
    throw new Error(
      "no sqlite_stat1: this home never ran ANALYZE, so the upgrade would not exercise the stat-table deletes a real install hits (0.12.0 SQLITE_AUTH). Run `node scripts/upgrade-proof-analyze.ts prepare <junto.db>` first",
    );
  }
  const statRows = Number(database.prepare("SELECT count(*) AS n FROM sqlite_stat1").get()?.n);
  const statTables = Number(database.prepare("SELECT count(DISTINCT tbl) AS n FROM sqlite_stat1").get()?.n);
  if (statRows === 0) {
    throw new Error("sqlite_stat1 is empty: the home holds no rows ANALYZE could count; seed it with data before the upgrade proof");
  }
  return { userVersion, statRows, statTables };
};

/** Read-only precondition: the home already carries populated sqlite_stat1. */
export const requireProofHomeStats = (dbPath: string): ProofHomeStats => {
  const database = new DatabaseSync(refuseOperatorDatabase(dbPath), { readOnly: true });
  try {
    return readStats(database);
  } finally {
    database.close();
  }
};

/** Runs ANALYZE over the whole database, then proves sqlite_stat1 is populated. */
export const analyzeProofHome = (dbPath: string): ProofHomeStats => {
  const database = new DatabaseSync(refuseOperatorDatabase(dbPath));
  try {
    database.exec("PRAGMA busy_timeout = 10000");
    database.exec("ANALYZE");
    return readStats(database);
  } finally {
    database.close();
  }
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, dbPath] = process.argv.slice(2);
  if ((mode !== "prepare" && mode !== "check") || dbPath === undefined || process.argv.length !== 4) {
    console.error("usage: node scripts/upgrade-proof-analyze.ts prepare|check <junto.db>");
    process.exitCode = 2;
  } else {
    try {
      const stats = mode === "prepare" ? analyzeProofHome(dbPath) : requireProofHomeStats(dbPath);
      process.stdout.write(`${JSON.stringify({ ok: true, mode, ...stats })}\n`);
    } catch (error) {
      console.error(`upgrade proof home: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
