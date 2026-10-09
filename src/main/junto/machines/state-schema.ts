export const MACHINE_IDENTITY_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS known_installations (
    installation_id TEXT PRIMARY KEY CHECK (
      length(installation_id) BETWEEN 1 AND 128
      AND installation_id GLOB '[A-Za-z0-9]*'
      AND installation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
    registered_at TEXT NOT NULL CHECK (length(registered_at) BETWEEN 1 AND 64)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS installation (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    installation_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
    FOREIGN KEY (installation_id) REFERENCES known_installations(installation_id)
      ON DELETE RESTRICT ON UPDATE RESTRICT
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS known_installation_identity_immutable
  BEFORE UPDATE OF installation_id ON known_installations
  WHEN OLD.installation_id <> NEW.installation_id
  BEGIN
    SELECT RAISE(ABORT, 'known installation identity is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS own_installation_identity_immutable
  BEFORE UPDATE OF installation_id ON installation
  WHEN OLD.installation_id <> NEW.installation_id
  BEGIN
    SELECT RAISE(ABORT, 'installation identity is immutable');
  END;
`;

export const MACHINE_CONFIGURATION_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS machine_configuration (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    machine_name TEXT NOT NULL CHECK (
      machine_name <> 'local'
      AND length(machine_name) BETWEEN 1 AND 64
      AND machine_name GLOB '[A-Za-z0-9]*'
      AND machine_name NOT GLOB '*[^A-Za-z0-9._-]*'
    ),
    supervised_preferred INTEGER NOT NULL CHECK (supervised_preferred IN (0, 1)),
    configured_at TEXT NOT NULL CHECK (length(configured_at) BETWEEN 1 AND 64)
  ) STRICT;
`;

export const MACHINE_PEERS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS machine_peers (
    machine_name TEXT PRIMARY KEY CHECK (
      machine_name <> 'local'
      AND length(machine_name) BETWEEN 1 AND 64
      AND machine_name GLOB '[A-Za-z0-9]*'
      AND machine_name NOT GLOB '*[^A-Za-z0-9._-]*'
    ),
    installation_id TEXT NOT NULL UNIQUE,
    bound_at TEXT NOT NULL CHECK (length(bound_at) BETWEEN 1 AND 64),
    retired_at TEXT CHECK (retired_at IS NULL OR length(retired_at) BETWEEN 1 AND 64),
    FOREIGN KEY (installation_id) REFERENCES known_installations(installation_id)
      ON DELETE RESTRICT ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TRIGGER IF NOT EXISTS machine_peer_identity_immutable
  BEFORE UPDATE OF machine_name, installation_id ON machine_peers
  WHEN OLD.machine_name <> NEW.machine_name OR OLD.installation_id <> NEW.installation_id
  BEGIN
    SELECT RAISE(ABORT, 'machine peer identity is immutable');
  END;
`;

export const MACHINE_STATE_SCHEMA_SQL =
  MACHINE_IDENTITY_STATE_SCHEMA_SQL +
  MACHINE_CONFIGURATION_STATE_SCHEMA_SQL +
  MACHINE_PEERS_STATE_SCHEMA_SQL;
