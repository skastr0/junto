import { migrateHostRegistry } from "../hosts/migrate";
import {
  migrateMachineConfiguration,
  migrateMachineIdentity,
  migrateMachinePeers,
} from "../machines/migrate";
import { machineNameAtMigration } from "./machine-name-at-migration";
import type { StateSchemaMigrationDatabase } from "./migrations";

/**
 * State migration 20 -> 21. Every machine gets a real name. A row said `local`
 * for the machine it was written on, which would mean a different machine on
 * every copy of a canvas; from here every row names its machine.
 *
 * In one transaction: the identity tables take their plain names, this
 * machine's configuration and the machines it knows move to their new tables
 * (the converters of the areas that own them), and every canvas row that said
 * `local` says this machine's name.
 */

/** A stored row's word for the machine it was written on. */
const UNNAMED = "local";

/** Kind tables with a `host` column, at this step. */
const HOSTED_TABLES = ["seats", "terminals", "pages", "crons", "relays", "watchers"] as const;

export const MACHINE_NAMES_REMOVED_TABLES = ["station_configuration", "station_fleet_targets"] as const;

export const MACHINE_NAMES_RENAMED_TABLES = {
  station_known_installations: "known_installations",
  station_installation: "installation",
} as const;

/** Other rows kept per machine: a timer's state and firings, and what was last observed of a machine. */
const KEYED_BY_MACHINE = [
  ["scheduler_interval_state", "home_station"],
  ["scheduler_interval_firings", "home_station"],
  ["station_status_facts", "host_id"],
] as const;

/** Tables whose rows this step corrects in place: the word `local`, and the registry's own bookkeeping. */
export const MACHINE_NAMES_CORRECTED_TABLES = [
  ...HOSTED_TABLES,
  "regions",
  ...KEYED_BY_MACHINE.map(([table]) => table),
  "host_registry_state",
] as const;

type Paths = Record<string, string>;
type Environment = { sources?: Array<{ host?: string }> };

const nameRegions = (database: StateSchemaMigrationDatabase, name: string): void => {
  const regions = database
    .prepare("SELECT canvas_name, id, page_host, paths_json, environment_json FROM regions")
    .all() as unknown as ReadonlyArray<{
    canvas_name: string;
    id: string;
    page_host: string | null;
    paths_json: string | null;
    environment_json: string | null;
  }>;
  const update = database.prepare(
    "UPDATE regions SET page_host = ?, paths_json = ?, environment_json = ? WHERE canvas_name = ? AND id = ?",
  );
  for (const region of regions) {
    const paths = region.paths_json === null ? null : (JSON.parse(region.paths_json) as Paths);
    const environment =
      region.environment_json === null ? null : (JSON.parse(region.environment_json) as Environment);
    const namedPaths =
      paths !== null && UNNAMED in paths
        ? Object.fromEntries(Object.entries(paths).map(([host, path]) => [host === UNNAMED ? name : host, path]))
        : paths;
    const said = environment?.sources?.some((source) => source.host === UNNAMED) ?? false;
    const namedEnvironment = said
      ? {
          ...environment,
          sources: environment!.sources!.map((source) => (source.host === UNNAMED ? { ...source, host: name } : source)),
        }
      : environment;
    if (region.page_host !== UNNAMED && namedPaths === paths && !said) continue;
    update.run(
      region.page_host === UNNAMED ? name : region.page_host,
      namedPaths === null ? null : JSON.stringify(namedPaths),
      namedEnvironment === null ? null : JSON.stringify(namedEnvironment),
      region.canvas_name,
      region.id,
    );
  }
};

export const migrateMachineNames = (
  database: StateSchemaMigrationDatabase,
  firstBootName?: string,
): void => {
  const name = machineNameAtMigration(database, firstBootName);
  migrateMachineIdentity(database);
  migrateMachineConfiguration(database, name);
  migrateMachinePeers(database);
  // A row in this machine's own list under its own name is this machine,
  // listed before it knew its name.
  database.prepare("DELETE FROM host_registry WHERE id = ? AND kind <> 'local'").run(name);
  migrateHostRegistry(database, name);
  for (const table of HOSTED_TABLES) {
    database.prepare(`UPDATE ${table} SET host = ? WHERE host = ?`).run(name, UNNAMED);
  }
  for (const [table, column] of KEYED_BY_MACHINE) {
    database.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(name, UNNAMED);
  }
  nameRegions(database, name);
};
