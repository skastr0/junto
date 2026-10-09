import type { StateSchemaMigrationDatabase } from "../state/migrations";
import { MACHINE_REGISTRY_STATE_SCHEMA_SQL } from "./state-schema";

/** Runs inside the name migration's transaction. */
export const migrateHostRegistry = (
  database: StateSchemaMigrationDatabase,
  ownName: string,
): void => {
  if (ownName === "local" || !/^(?!-)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(ownName)) {
    throw new Error("this machine needs a real short name");
  }
  if (database.prepare("SELECT id FROM host_registry WHERE id = ?").get(ownName)) {
    throw new Error(`this machine name conflicts with an existing machine: ${ownName}`);
  }
  database.exec(`
    CREATE TABLE host_registry_name_copy AS SELECT * FROM host_registry;
    DROP TRIGGER host_registry_retain_local;
    DROP TABLE host_registry;
    ${MACHINE_REGISTRY_STATE_SCHEMA_SQL}
  `);
  database.prepare(`
    INSERT INTO host_registry (
      id, label, is_this_machine, ssh_endpoint, junto_home, install_root, ssh_identity_file,
      ssh_host_key_policy, ssh_port, ssh_known_hosts_file, ssh_host_key_alias, capability_mask, hermes_id, effective_hermes_id,
      appearance_color, appearance_glyph, sort_order
    ) SELECT
      CASE WHEN kind = 'local' THEN ? ELSE id END,
      CASE WHEN kind = 'local' AND label = 'local' THEN ? ELSE label END,
      CASE WHEN kind = 'local' THEN 1 ELSE 0 END,
      ssh_endpoint, NULL, NULL, ssh_identity_file, ssh_host_key_policy, NULL, NULL, NULL, capability_mask,
      CASE WHEN kind = 'local' THEN coalesce(hermes_id, effective_hermes_id) ELSE hermes_id END,
      effective_hermes_id, appearance_color, appearance_glyph, sort_order
    FROM host_registry_name_copy ORDER BY sort_order
  `).run(ownName, ownName);
  if (!database.prepare("SELECT id FROM host_registry WHERE is_this_machine = 1").get()) {
    database.prepare(`
      INSERT INTO host_registry (id, label, is_this_machine, capability_mask, effective_hermes_id, sort_order)
      VALUES (?, ?, 1, NULL, ?, 0)
    `).run(ownName, ownName, ownName);
  }
  database.prepare(`
    INSERT OR IGNORE INTO host_registry_state (singleton, version, initialized_at) VALUES (1, 1, ?)
  `).run(new Date().toISOString());
  database.exec("DROP TABLE host_registry_name_copy");
};
