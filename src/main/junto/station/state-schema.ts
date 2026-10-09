/**
 * Exact-current durable Station coordination schema.
 *
 * Installation identity is the only durable work-routing identity. The
 * registry is deliberately shared by Station cursors and the Work schema so a
 * HostId, sentinel, or transport locator cannot enter an event/entity route.
 * Timestamps remain display metadata.
 *
 * This module is SQL-only so StateEngine composes it into the one installation
 * database without importing repositories or wire adapters.
 */
export const STATION_STATE_SCHEMA_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS station_known_installations (
      installation_id TEXT PRIMARY KEY
        CHECK (
          length(installation_id) BETWEEN 1 AND 128
          AND installation_id GLOB '[A-Za-z0-9]*'
          AND installation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        ),
      registered_at TEXT NOT NULL
        CHECK (length(registered_at) BETWEEN 1 AND 64)
    ) STRICT, WITHOUT ROWID
  `,
  `
    CREATE TABLE IF NOT EXISTS station_installation (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      installation_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
        CHECK (length(created_at) BETWEEN 1 AND 64),
      FOREIGN KEY (installation_id)
        REFERENCES station_known_installations(installation_id)
        ON DELETE RESTRICT
        ON UPDATE RESTRICT
    ) STRICT
  `,
  `
    CREATE TABLE IF NOT EXISTS station_configuration (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      role TEXT NOT NULL
        CHECK (role IN ('command-center', 'remote')),
      host_id TEXT NOT NULL CHECK (length(host_id) BETWEEN 1 AND 64),
      agent_host_id TEXT,
      command_center_installation_id TEXT,
      supervised_preferred INTEGER NOT NULL
        CHECK (supervised_preferred IN (0, 1)),
      configured_at TEXT NOT NULL
        CHECK (length(configured_at) BETWEEN 1 AND 64),
      CHECK (
        (
          role = 'command-center'
          AND agent_host_id IS NULL
          AND command_center_installation_id IS NULL
        )
        OR
        (
          role = 'remote'
          AND agent_host_id IS NOT NULL
          AND length(agent_host_id) BETWEEN 1 AND 64
          AND command_center_installation_id IS NOT NULL
        )
      ),
      FOREIGN KEY (command_center_installation_id)
        REFERENCES station_known_installations(installation_id)
        ON DELETE RESTRICT
        ON UPDATE RESTRICT
    ) STRICT
  `,
  `
    CREATE TABLE IF NOT EXISTS station_fleet_targets (
      host_id TEXT PRIMARY KEY
        CHECK (
          length(host_id) BETWEEN 1 AND 64
          AND substr(host_id, 1, 1) <> '-'
          AND host_id GLOB '[A-Za-z0-9]*'
          AND host_id NOT GLOB '*[^A-Za-z0-9._-]*'
        ),
      station_installation_id TEXT NOT NULL UNIQUE,
      bound_at TEXT NOT NULL
        CHECK (length(bound_at) BETWEEN 1 AND 64),
      retired_at TEXT
        CHECK (
          retired_at IS NULL
          OR length(retired_at) BETWEEN 1 AND 64
        ),
      FOREIGN KEY (station_installation_id)
        REFERENCES station_known_installations(installation_id)
        ON DELETE RESTRICT
        ON UPDATE RESTRICT
    ) STRICT, WITHOUT ROWID
  `,
  `
    CREATE TRIGGER IF NOT EXISTS station_known_installation_identity_immutable
    BEFORE UPDATE OF installation_id ON station_known_installations
    WHEN OLD.installation_id <> NEW.installation_id
    BEGIN
      SELECT RAISE(ABORT, 'known installation identity is immutable');
    END
  `,
  `
    CREATE TRIGGER IF NOT EXISTS station_local_installation_identity_immutable
    BEFORE UPDATE OF installation_id ON station_installation
    WHEN OLD.installation_id <> NEW.installation_id
    BEGIN
      SELECT RAISE(ABORT, 'local installation identity is immutable');
    END
  `,
] as const;

export const STATION_STATE_SCHEMA_SQL =
  `${STATION_STATE_SCHEMA_STATEMENTS.join(";\n")};`;
