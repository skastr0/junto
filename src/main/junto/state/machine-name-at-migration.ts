import { defaultMachineName, isValidMachineName } from "@shared/machine-name";
import type { StateSchemaMigrationDatabase } from "./migrations";

const has = (database: StateSchemaMigrationDatabase, table: string): boolean =>
  database.prepare("SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) !== undefined;

const hasColumn = (database: StateSchemaMigrationDatabase, table: string, column: string): boolean =>
  database.prepare("SELECT 1 AS found FROM pragma_table_info(?) WHERE name = ?").get(table, column) !== undefined;

/**
 * The name of this machine, as a migration step may know it: a step has only
 * the database. It is the name already configured when that is a real one,
 * else the name the machine would be given at first boot, and never the name
 * of another machine this one already knows. Every step that needs the name
 * calls this, so they agree.
 */
export const machineNameAtMigration = (
  database: StateSchemaMigrationDatabase,
  fallback: string = defaultMachineName(),
): string => {
  const named = has(database, "machine_configuration")
    ? database.prepare("SELECT machine_name AS name FROM machine_configuration WHERE singleton = 1").get()?.name
    : has(database, "station_configuration")
      ? database.prepare("SELECT host_id AS name FROM station_configuration WHERE singleton = 1").get()?.name
      : undefined;
  if (typeof named === "string" && isValidMachineName(named)) return named;
  const others = new Set<string>();
  if (has(database, "host_registry")) {
    const own = hasColumn(database, "host_registry", "kind") ? "kind = 'local'" : "is_this_machine = 1";
    for (const row of database.prepare(`SELECT id FROM host_registry WHERE NOT (${own})`).all()) others.add(String(row.id));
  }
  let name = fallback;
  for (let attempt = 2; others.has(name); attempt += 1) name = `${fallback.slice(0, 60)}-${attempt}`;
  return name;
};
