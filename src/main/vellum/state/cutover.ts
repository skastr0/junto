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

type SqlRow = {
  readonly sql: string | null;
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

const tableHasColumns = (
  database: StateCutoverDatabase,
  tableName: string,
  columns: ReadonlyArray<string>,
): boolean =>
  tableExists(database, tableName) &&
  columns.every((column) =>
    tableHasColumn(database, tableName, column)
  );

const tableDefinitionContains = (
  database: StateCutoverDatabase,
  tableName: string,
  fragment: string,
): boolean => {
  const row = database
    .prepare(
      `
        SELECT sql
        FROM sqlite_schema
        WHERE type = 'table' AND name = ?
      `,
    )
    .get(tableName) as SqlRow | undefined;
  return row?.sql?.includes(fragment) ?? false;
};

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

const resetObsoleteStationEventSchema = (
  database: StateCutoverDatabase,
): void => {
  if (
    !tableExists(database, "station_events") &&
    !tableExists(database, "station_outbound_sequences")
  ) {
    return;
  }

  // The retired generic event log used a producer-global sequence domain.
  // Its cursors cannot be interpreted as canonical route-local Work cursors.
  database.exec(`
    DROP TABLE IF EXISTS station_events;
    DROP TABLE IF EXISTS station_outbound_sequences;
    DROP TABLE IF EXISTS station_received_cursors;
    DROP TABLE IF EXISTS station_peer_ack_cursors;
  `);
};

const resetObsoleteFleetTargetSchema = (
  database: StateCutoverDatabase,
): void => {
  if (
    !tableExists(database, "station_fleet_targets") ||
    tableHasColumn(database, "station_fleet_targets", "retired_at")
  ) {
    return;
  }

  // A deleted row cannot preserve the host→installation authority required
  // to reject unsafe fresh-install replacement. Pre-release fleet bindings
  // are discarded once; the current shape retains retired identity tombstones.
  database.exec("DROP TABLE station_fleet_targets");
};

const resetObsoleteWorkSchema = (
  database: StateCutoverDatabase,
): void => {
  const hasEvents = tableExists(database, "work_events");
  const obsolete =
    tableExists(database, "work_home_sequences") ||
    (hasEvents &&
      (
        !tableHasColumns(database, "work_event_sequences", [
          "event_home",
          "entity_home",
          "last_seq",
        ]) ||
        !tableHasColumns(database, "work_events", [
          "event_home",
          "entity_home",
          "seq",
          "entity_kind",
          "payload_json",
          "content_sha256",
        ]) ||
        !tableDefinitionContains(
          database,
          "work_events",
          "'receipt'",
        ) ||
        !tableHasColumns(database, "work_pending_commands", [
          "event_home",
          "entity_home",
          "seq",
          "status",
          "acknowledged_by",
          "resolved_at",
        ]) ||
        !tableDefinitionContains(
          database,
          "work_pending_commands",
          "'applied'",
        ) ||
        !tableDefinitionContains(
          database,
          "work_pending_commands",
          "'rejected'",
        ) ||
        !tableHasColumns(database, "work_tasks", [
          "home_station",
          "event_home",
          "event_seq",
        ]) ||
        !tableHasColumns(database, "work_requests", [
          "home_station",
          "event_home",
          "event_seq",
        ]) ||
        !tableHasColumns(database, "work_task_messages", [
          "parent_lane",
          "entity_home",
          "event_home",
          "event_seq",
        ]) ||
        !tableHasColumns(database, "work_messages", [
          "home_station",
          "event_home",
          "event_seq",
        ]) ||
        !tableDefinitionContains(
          database,
          "work_messages",
          "vellum:command-center",
        ) ||
        !tableHasColumns(database, "work_artifacts", [
          "home_station",
          "event_home",
          "event_seq",
        ]) ||
        !tableHasColumns(database, "work_task_transitions", [
          "home_station",
          "event_home",
          "event_seq",
        ]) ||
        !tableHasColumns(database, "work_rejections", [
          "rejected_event_home",
          "rejected_entity_home",
          "rejected_seq",
          "reported_by",
          "receipt_event_home",
          "receipt_event_seq",
        ]) ||
        !tableDefinitionContains(
          database,
          "work_rejections",
          "causal-conflict",
        )
      ));
  if (!obsolete) return;

  // The pre-replication work schema assigned one sequence per semantic home
  // and has incompatible event/material columns. There is no supported import
  // or dual-read path: this pre-release shape is retired as one domain.
  database.exec(`
    DROP TABLE IF EXISTS station_received_cursors;
    DROP TABLE IF EXISTS station_peer_ack_cursors;
    DROP TABLE IF EXISTS work_rejections;
    DROP TABLE IF EXISTS work_pending_commands;
    DROP TABLE IF EXISTS work_task_transitions;
    DROP TABLE IF EXISTS work_task_messages;
    DROP TABLE IF EXISTS work_messages;
    DROP TABLE IF EXISTS work_artifacts;
    DROP TABLE IF EXISTS work_requests;
    DROP TABLE IF EXISTS work_tasks;
    DROP TABLE IF EXISTS work_events;
    DROP TABLE IF EXISTS work_event_sequences;
    DROP TABLE IF EXISTS work_home_sequences;
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
  resetObsoleteStationEventSchema(database);
  resetObsoleteFleetTargetSchema(database);
  resetObsoleteWorkSchema(database);
};
