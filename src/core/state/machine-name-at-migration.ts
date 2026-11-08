import { defaultMachineName, isValidMachineName } from "@shared/machine-name";
import type { StateSchemaMigrationDatabase } from "./migrations";

const has = (database: StateSchemaMigrationDatabase, table: string): boolean =>
  database.prepare("SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) !== undefined;

const hasColumn = (database: StateSchemaMigrationDatabase, table: string, column: string): boolean =>
  database.prepare("SELECT 1 AS found FROM pragma_table_info(?) WHERE name = ?").get(table, column) !== undefined;

/**
 * The name of this machine, as a migration step may know it: a step has only
 * the database. Every step that needs the name calls this, so they agree.
 *
 * A machine that already has a name keeps it. A machine another one set up
 * was given its name by that machine, and every row either of them holds says
 * so: it keeps that name, and a row under it in its own list is itself. Any
 * other machine takes the name first boot would give, and never the name of
 * a machine it already knows.
 */
export const machineNameAtMigration = (
  database: StateSchemaMigrationDatabase,
  fallback: string = defaultMachineName(),
): string => {
  if (has(database, "machine_configuration")) {
    const named = database.prepare("SELECT machine_name AS name FROM machine_configuration WHERE singleton = 1").get()?.name;
    if (typeof named === "string" && isValidMachineName(named)) return named;
  }
  const configured = has(database, "station_configuration")
    ? database.prepare("SELECT role, host_id AS name FROM station_configuration WHERE singleton = 1").get()
    : undefined;
  const given =
    typeof configured?.name === "string" && isValidMachineName(configured.name) ? configured.name : undefined;
  if (given !== undefined && configured?.role === "remote") return given;
  const wanted = given ?? fallback;
  const others = new Set<string>();
  if (has(database, "host_registry")) {
    const own = hasColumn(database, "host_registry", "kind") ? "kind = 'local'" : "is_this_machine = 1";
    for (const row of database.prepare(`SELECT id FROM host_registry WHERE NOT (${own})`).all()) others.add(String(row.id));
  }
  let name = wanted;
  for (let attempt = 2; others.has(name); attempt += 1) name = `${wanted.slice(0, 60)}-${attempt}`;
  return name;
};
