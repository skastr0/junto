import { randomUUID } from "node:crypto";
import { isValidMachineName } from "@shared/machine-identity";
import type { StateSchemaMigrationDatabase } from "../state/migrations";
import {
  MACHINE_CONFIGURATION_STATE_SCHEMA_SQL,
  MACHINE_IDENTITY_STATE_SCHEMA_SQL,
  MACHINE_PEERS_STATE_SCHEMA_SQL,
} from "./state-schema";

const admitName = (name: string): void => {
  if (!isValidMachineName(name)) throw new Error("this machine needs a real short name");
};

/** Each converter joins the schema migration's transaction. */
export const migrateMachineIdentity = (database: StateSchemaMigrationDatabase): void => {
  database.exec(`
    DROP TRIGGER station_known_installation_identity_immutable;
    DROP TRIGGER station_local_installation_identity_immutable;
    ALTER TABLE station_known_installations RENAME TO known_installations;
    ALTER TABLE station_installation RENAME TO installation;
    ${MACHINE_IDENTITY_STATE_SCHEMA_SQL}
  `);
  if (database.prepare("SELECT installation_id FROM installation WHERE singleton = 1").get()) return;
  const id = randomUUID();
  const at = new Date().toISOString();
  database.prepare("INSERT INTO known_installations(installation_id, registered_at) VALUES (?, ?)").run(id, at);
  database.prepare("INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ?, ?)").run(id, at);
};

export const migrateMachineConfiguration = (
  database: StateSchemaMigrationDatabase,
  ownName: string,
): void => {
  admitName(ownName);
  database.exec(MACHINE_CONFIGURATION_STATE_SCHEMA_SQL);
  database.prepare(`
    INSERT INTO machine_configuration(singleton, machine_name, supervised_preferred, configured_at)
    SELECT singleton, ?, supervised_preferred, configured_at FROM station_configuration
  `).run(ownName);
  database.prepare(`
    INSERT OR IGNORE INTO machine_configuration(singleton, machine_name, supervised_preferred, configured_at)
    VALUES (1, ?, 0, ?)
  `).run(ownName, new Date().toISOString());
  database.exec("DROP TABLE station_configuration");
};

export const migrateMachinePeers = (
  database: StateSchemaMigrationDatabase,
): void => {
  database.exec(MACHINE_PEERS_STATE_SCHEMA_SQL);
  database.exec("DROP TABLE station_fleet_targets");
};
