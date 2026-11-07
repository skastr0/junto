import { Schema } from "effect";
import type { StateSchemaMigrationDatabase } from "../state/migrations";

/**
 * The machine list as the name step (20 -> 21) builds it, with its Hermes
 * columns. Frozen here: step 32 rebuilds the head table without them.
 */
const NAME_STEP_HOST_REGISTRY_SQL = `
  CREATE TABLE host_registry (
    id TEXT PRIMARY KEY CHECK (
      length(id) BETWEEN 1 AND 64
      AND substr(id, 1, 1) GLOB '[A-Za-z0-9]'
      AND id NOT GLOB '*[^A-Za-z0-9._-]*'
      AND id <> 'local'
    ),
    label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
    is_this_machine INTEGER NOT NULL CHECK (is_this_machine IN (0, 1)),
    ssh_endpoint TEXT,
    ssh_port INTEGER CHECK (ssh_port IS NULL OR ssh_port BETWEEN 1 AND 65535),
    ssh_known_hosts_file TEXT CHECK (
      ssh_known_hosts_file IS NULL OR (
        length(ssh_known_hosts_file) BETWEEN 1 AND 1024
        AND substr(ssh_known_hosts_file, 1, 1) = '/'
        AND ssh_known_hosts_file NOT GLOB '*[^A-Za-z0-9._/@+-]*'
      )
    ),
    ssh_host_key_alias TEXT CHECK (
      ssh_host_key_alias IS NULL OR (
        length(ssh_host_key_alias) BETWEEN 1 AND 255
        AND substr(ssh_host_key_alias, 1, 1) GLOB '[A-Za-z0-9]'
        AND ssh_host_key_alias NOT GLOB '*[^A-Za-z0-9._:-]*'
      )
    ),
    junto_home TEXT CHECK (junto_home IS NULL OR (length(junto_home) BETWEEN 1 AND 2048 AND substr(junto_home, 1, 1) = '/')),
    install_root TEXT CHECK (install_root IS NULL OR (length(install_root) BETWEEN 1 AND 2048 AND substr(install_root, 1, 1) = '/')),
    ssh_identity_file TEXT CHECK (
      ssh_identity_file IS NULL OR (
        length(ssh_identity_file) BETWEEN 1 AND 1024
        AND substr(ssh_identity_file, 1, 1) = '/'
      )
    ),
    ssh_host_key_policy TEXT CHECK (
      ssh_host_key_policy IS NULL OR ssh_host_key_policy IN ('system', 'accept-new')
    ),
    capability_mask INTEGER,
    hermes_id TEXT CHECK (
      hermes_id IS NULL OR (
        length(hermes_id) BETWEEN 1 AND 64
        AND substr(hermes_id, 1, 1) GLOB '[A-Za-z0-9]'
        AND hermes_id NOT GLOB '*[^A-Za-z0-9._-]*'
      )
    ),
    effective_hermes_id TEXT UNIQUE,
    appearance_color TEXT,
    appearance_glyph TEXT,
    sort_order INTEGER NOT NULL UNIQUE CHECK (sort_order >= 0),
    CHECK (
      (is_this_machine = 1 AND sort_order = 0 AND capability_mask IS NULL
        AND ssh_endpoint IS NULL AND ssh_identity_file IS NULL AND ssh_host_key_policy IS NULL
        AND junto_home IS NULL AND install_root IS NULL
        AND ssh_port IS NULL AND ssh_known_hosts_file IS NULL AND ssh_host_key_alias IS NULL)
      OR
      (is_this_machine = 0 AND sort_order > 0 AND capability_mask IS NOT NULL
        AND capability_mask BETWEEN 1 AND 15
        AND (ssh_endpoint IS NULL OR length(ssh_endpoint) BETWEEN 1 AND 255)
        AND (ssh_endpoint IS NOT NULL OR (ssh_identity_file IS NULL AND ssh_host_key_policy IS NULL
          AND ssh_port IS NULL AND ssh_known_hosts_file IS NULL AND ssh_host_key_alias IS NULL))
        AND (ssh_known_hosts_file IS NULL OR ssh_host_key_policy IS NULL OR ssh_host_key_policy = 'system'))
    ),
    CHECK (
      ((is_this_machine = 1 OR (capability_mask & 8) <> 0)
        AND effective_hermes_id IS NOT NULL
        AND effective_hermes_id = coalesce(hermes_id, id))
      OR
      (is_this_machine = 0 AND (capability_mask & 8) = 0 AND effective_hermes_id IS NULL)
    )
  ) STRICT;

  CREATE UNIQUE INDEX host_registry_route_unique
    ON host_registry(ssh_endpoint, coalesce(ssh_port, 0)) WHERE ssh_endpoint IS NOT NULL;

  CREATE UNIQUE INDEX host_registry_one_own
    ON host_registry(is_this_machine) WHERE is_this_machine = 1;

  CREATE TRIGGER host_registry_require_own
  BEFORE INSERT ON host_registry
  WHEN NEW.is_this_machine = 0 AND NOT EXISTS (SELECT 1 FROM host_registry WHERE is_this_machine = 1)
  BEGIN SELECT RAISE(ABORT, 'this machine must be registered first'); END;

  CREATE TRIGGER host_registry_retain_own
  BEFORE DELETE ON host_registry WHEN OLD.is_this_machine = 1
  BEGIN SELECT RAISE(ABORT, 'cannot remove this machine'); END;

  CREATE TRIGGER host_registry_own_flag_immutable
  BEFORE UPDATE OF is_this_machine ON host_registry
  WHEN OLD.is_this_machine <> NEW.is_this_machine
  BEGIN SELECT RAISE(ABORT, 'machine ownership cannot change'); END;

`;

/** The name migration refuses a missing or taken machine name. */
export class HostRegistryNameRefused extends Schema.TaggedError<HostRegistryNameRefused>()("HostRegistryNameRefused", {
  check: Schema.Literals(["name-invalid", "name-conflict"]),
  message: Schema.String,
}) {}

/** Runs inside the name migration's transaction. */
export const migrateHostRegistry = (
  database: StateSchemaMigrationDatabase,
  ownName: string,
): void => {
  if (ownName === "local" || !/^(?!-)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(ownName)) {
    throw new HostRegistryNameRefused({ check: "name-invalid", message: "this machine needs a real short name" });
  }
  if (database.prepare("SELECT id FROM host_registry WHERE id = ?").get(ownName)) {
    throw new HostRegistryNameRefused({ check: "name-conflict", message: `this machine name conflicts with an existing machine: ${ownName}` });
  }
  database.exec(`
    CREATE TABLE host_registry_name_copy AS SELECT * FROM host_registry;
    DROP TRIGGER host_registry_retain_local;
    DROP TABLE host_registry;
    ${NAME_STEP_HOST_REGISTRY_SQL}
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
