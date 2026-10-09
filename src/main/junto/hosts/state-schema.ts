/**
 * Host enrollment is durable application state, not a user-editable file.
 *
 * The local row stores presentation only. Its identity and capabilities are
 * projected from code at runtime. Remote capability sets are represented as a
 * non-zero bit mask, making duplicate or empty claims unrepresentable in the
 * database. `effective_hermes_id` is null for remotes without Hermes and
 * unique for every host that participates in Hermes routing.
 */
export const HOSTS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS host_registry (
    id TEXT PRIMARY KEY
      CHECK (
        length(id) BETWEEN 1 AND 64
        AND substr(id, 1, 1) GLOB '[A-Za-z0-9]'
        AND id NOT GLOB '*[^A-Za-z0-9._-]*'
      ),
    label TEXT NOT NULL
      CHECK (length(label) BETWEEN 1 AND 64),
    kind TEXT NOT NULL
      CHECK (kind IN ('local', 'remote')),
    ssh_endpoint TEXT UNIQUE,
    ssh_identity_file TEXT
      CHECK (
        ssh_identity_file IS NULL
        OR (
          length(ssh_identity_file) BETWEEN 1 AND 1024
          AND substr(ssh_identity_file, 1, 1) = '/'
        )
      ),
    ssh_host_key_policy TEXT
      CHECK (
        ssh_host_key_policy IS NULL
        OR ssh_host_key_policy IN ('system', 'accept-new')
      ),
    capability_mask INTEGER,
    hermes_id TEXT
      CHECK (
        hermes_id IS NULL
        OR (
          length(hermes_id) BETWEEN 1 AND 64
          AND substr(hermes_id, 1, 1) GLOB '[A-Za-z0-9]'
          AND hermes_id NOT GLOB '*[^A-Za-z0-9._-]*'
        )
      ),
    effective_hermes_id TEXT UNIQUE,
    appearance_color TEXT,
    appearance_glyph TEXT,
    sort_order INTEGER NOT NULL UNIQUE
      CHECK (sort_order >= 0),
    CHECK (
      (
        kind = 'local'
        AND id = 'local'
        AND ssh_endpoint IS NULL
        AND ssh_identity_file IS NULL
        AND ssh_host_key_policy IS NULL
        AND capability_mask IS NULL
        AND sort_order = 0
      )
      OR
      (
        kind = 'remote'
        AND id <> 'local'
        AND (
          ssh_endpoint IS NULL
          OR length(ssh_endpoint) BETWEEN 1 AND 255
        )
        AND (
          ssh_endpoint IS NOT NULL
          OR (
            ssh_identity_file IS NULL
            AND ssh_host_key_policy IS NULL
          )
        )
        AND capability_mask BETWEEN 1 AND 15
        AND sort_order > 0
      )
    ),
    CHECK (
      (
        (
          kind = 'local'
          OR (capability_mask & 8) <> 0
        )
        AND effective_hermes_id IS NOT NULL
        AND effective_hermes_id = coalesce(hermes_id, id)
      )
      OR
      (
        kind = 'remote'
        AND (capability_mask & 8) = 0
        AND effective_hermes_id IS NULL
      )
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS host_registry_state (
    singleton INTEGER PRIMARY KEY
      CHECK (singleton = 1),
    version INTEGER NOT NULL
      CHECK (version = 1),
    initialized_at TEXT NOT NULL
      CHECK (length(initialized_at) > 0)
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS host_registry_retain_local
  BEFORE DELETE ON host_registry
  WHEN OLD.id = 'local'
  BEGIN
    SELECT RAISE(ABORT, 'the local host is immutable');
  END;
`;

export const MACHINE_REGISTRY_STATE_SCHEMA_SQL = `
  CREATE TABLE host_registry (
    id TEXT PRIMARY KEY CHECK (
      length(id) BETWEEN 1 AND 64
      AND substr(id, 1, 1) GLOB '[A-Za-z0-9]'
      AND id NOT GLOB '*[^A-Za-z0-9._-]*'
      AND id <> 'local'
    ),
    label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
    is_this_machine INTEGER NOT NULL CHECK (is_this_machine IN (0, 1)),
    ssh_endpoint TEXT UNIQUE,
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
        AND junto_home IS NULL AND install_root IS NULL)
      OR
      (is_this_machine = 0 AND sort_order > 0 AND capability_mask IS NOT NULL
        AND capability_mask BETWEEN 1 AND 15
        AND (ssh_endpoint IS NULL OR length(ssh_endpoint) BETWEEN 1 AND 255)
        AND (ssh_endpoint IS NOT NULL OR (ssh_identity_file IS NULL AND ssh_host_key_policy IS NULL)))
    ),
    CHECK (
      ((is_this_machine = 1 OR (capability_mask & 8) <> 0)
        AND effective_hermes_id IS NOT NULL
        AND effective_hermes_id = coalesce(hermes_id, id))
      OR
      (is_this_machine = 0 AND (capability_mask & 8) = 0 AND effective_hermes_id IS NULL)
    )
  ) STRICT;

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
