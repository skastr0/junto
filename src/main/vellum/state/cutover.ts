import type { DatabaseSync } from "node:sqlite";

/**
 * Narrow bootstrap surface for destructive, one-way schema consolidation.
 *
 * Cutovers run inside StateEngine's schema transaction. They remove obsolete
 * internal shapes so the current schema can be created immediately afterward;
 * repositories never carry readers or writers for the retired shape.
 */
export type StateCutoverDatabase = Pick<
  DatabaseSync,
  "exec" | "prepare"
>;

type PresenceRow = {
  readonly present: number;
};

const tableExists = (
  database: StateCutoverDatabase,
  tableName: string,
): boolean =>
  Number(
    (
      database
        .prepare(
          `
            SELECT 1 AS present
            FROM sqlite_schema
            WHERE type = 'table' AND name = ?
          `,
        )
        .get(tableName) as PresenceRow | undefined
    )?.present ?? 0,
  ) === 1;

const tableHasColumn = (
  database: StateCutoverDatabase,
  tableName: string,
  columnName: string,
): boolean =>
  Number(
    (
      database
        .prepare(
          `
            SELECT 1 AS present
            FROM pragma_table_info(?)
            WHERE name = ?
          `,
        )
        .get(tableName, columnName) as PresenceRow | undefined
    )?.present ?? 0,
  ) === 1;

const resetObsoleteSchedulerSchema = (
  database: StateCutoverDatabase,
): void => {
  const stateTable = "scheduler_interval_state";
  const firingTable = "scheduler_interval_firings";
  const obsolete =
    (tableExists(database, stateTable) &&
      !tableHasColumn(database, stateTable, "catch_up_policy")) ||
    (tableExists(database, firingTable) &&
      !tableHasColumn(database, firingTable, "catch_up_policy"));
  if (!obsolete) return;

  database.exec(`
    DROP TABLE IF EXISTS scheduler_interval_firings;
    DROP TABLE IF EXISTS scheduler_interval_state;
  `);
};

/**
 * Apply bounded irreversible transitions to the one current schema.
 *
 * This is deliberately not a migration registry: each detector recognizes one
 * known obsolete internal shape and deletes it. Missing and already-current
 * tables are untouched.
 */
export const applyIrreversibleStateCutovers = (
  database: StateCutoverDatabase,
): void => {
  resetObsoleteSchedulerSchema(database);
};
