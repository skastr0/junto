/**
 * The state maintenance worker: a maintenance writer to junto.db on its own
 * thread (operator ruling 2026-10-30). It runs only the closed set of
 * commands below, and none of them changes a row:
 *
 * - a passive WAL checkpoint every second, so the business writer on main
 *   never copies the log into the database inside a commit;
 * - ANALYZE one table at a time, bounded by `analysis_limit`, when the host
 *   asks, so the planner has statistics without a write lock held for the
 *   whole database.
 *
 * A passive checkpoint never waits on the writer and never blocks it. Each
 * ANALYZE step takes the write lock for tens of milliseconds at most, and a
 * busy writer makes the step wait for the next round instead of retrying.
 */
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import type { MaintenanceNote, MaintenanceRequest, MaintenanceWorkerData } from "./maintenance";

export const MAINTENANCE_CHECKPOINT_EVERY_MS = 1_000;
/** Rows each index samples; full statistics on the live file take 100 ms or more per table. */
export const MAINTENANCE_ANALYSIS_LIMIT = 1_000;
const MAINTENANCE_CACHE_SIZE_KIB = 8 * 1024;
/** How long a step waits for the writer's lock before it gives the round up. */
const MAINTENANCE_BUSY_MS = 50;

const CHECKPOINT_SQL = "PRAGMA wal_checkpoint(PASSIVE)";
const TABLES_SQL = "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name";

/** The maintenance writer's connection. It never changes a row. */
export const openMaintenanceDatabase = (path: string): DatabaseSync => {
  const database = new DatabaseSync(path, {
    open: true,
    readOnly: false,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    timeout: MAINTENANCE_BUSY_MS,
  });
  database.exec(`
    PRAGMA trusted_schema = OFF;
    PRAGMA cache_size = -${MAINTENANCE_CACHE_SIZE_KIB};
    PRAGMA wal_autocheckpoint = 0;
    PRAGMA analysis_limit = ${MAINTENANCE_ANALYSIS_LIMIT};
  `);
  return database;
};

export const checkpoint = (database: DatabaseSync): { readonly log: number; readonly checkpointed: number } => {
  const row = database.prepare(CHECKPOINT_SQL).get() as { log: number; checkpointed: number };
  return { log: Number(row.log), checkpointed: Number(row.checkpointed) };
};

/** One ANALYZE per table; a table the writer kept locked is left for the next round. */
export const analyzeTables = (database: DatabaseSync): { readonly analyzed: number; readonly skipped: number } => {
  const tables = (database.prepare(TABLES_SQL).all() as Array<{ name: string }>).map((row) => row.name);
  let analyzed = 0;
  for (const table of tables) {
    try {
      database.exec(`ANALYZE "${table.replaceAll('"', '""')}"`);
      analyzed += 1;
    } catch {
      // SQLITE_BUSY: the business writer holds the lock; its commit matters more.
    }
  }
  return { analyzed, skipped: tables.length - analyzed };
};

const serve = (port: NonNullable<typeof parentPort>): void => {
  const { path } = workerData as MaintenanceWorkerData;
  const database = openMaintenanceDatabase(path);
  const note = (message: MaintenanceNote): void => port.postMessage(message);
  const tick = (): void => {
    try {
      checkpoint(database);
    } catch (error) {
      note({ kind: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  };
  const timer = setInterval(tick, MAINTENANCE_CHECKPOINT_EVERY_MS);
  port.on("message", (request: MaintenanceRequest) => {
    if (request.kind !== "analyze") return;
    const started = performance.now();
    const result = analyzeTables(database);
    note({ kind: "analyzed", ...result, ms: performance.now() - started });
  });
  port.on("close", () => {
    clearInterval(timer);
    database.close();
  });
  tick();
  note({ kind: "ready" });
};

// Loaded on a thread that is not a worker (vitest resolves `?nodeWorker` to
// this module), it serves nothing, and the writer keeps its own checkpoints.
if (parentPort !== null) serve(parentPort);
