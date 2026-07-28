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
    CREATE TABLE IF NOT EXISTS station_pairing (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      command_center_installation_id TEXT NOT NULL,
      station_label TEXT NOT NULL
        CHECK (length(station_label) BETWEEN 1 AND 128),
      app_version TEXT NOT NULL
        CHECK (length(app_version) BETWEEN 1 AND 64),
      paired_at TEXT NOT NULL
        CHECK (length(paired_at) BETWEEN 1 AND 64),
      FOREIGN KEY (command_center_installation_id)
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
    CREATE TABLE IF NOT EXISTS station_projection_versions (
      generation TEXT NOT NULL
        CHECK (
          length(generation) BETWEEN 1 AND 32
          AND generation NOT GLOB '*[^0-9]*'
          AND (generation = '0' OR substr(generation, 1, 1) <> '0')
        ),
      content_sha256 TEXT NOT NULL
        CHECK (
          length(content_sha256) = 64
          AND content_sha256 NOT GLOB '*[^a-f0-9]*'
        ),
      source_canvas_generation TEXT NOT NULL
        CHECK (
          length(source_canvas_generation) BETWEEN 1 AND 32
          AND source_canvas_generation NOT GLOB '*[^0-9]*'
          AND (
            source_canvas_generation = '0'
            OR substr(source_canvas_generation, 1, 1) <> '0'
          )
        ),
      source_intent_sha256 TEXT NOT NULL
        CHECK (
          length(source_intent_sha256) = 64
          AND source_intent_sha256 NOT GLOB '*[^a-f0-9]*'
        ),
      body TEXT NOT NULL
        CHECK (length(body) BETWEEN 1 AND 67108864),
      created_at TEXT NOT NULL
        CHECK (length(created_at) BETWEEN 1 AND 64),
      received_at TEXT NOT NULL
        CHECK (length(received_at) BETWEEN 1 AND 64),
      PRIMARY KEY (generation),
      UNIQUE (generation, content_sha256)
    ) STRICT, WITHOUT ROWID
  `,
  `
    CREATE TABLE IF NOT EXISTS station_projection_head (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      generation TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      FOREIGN KEY (generation, content_sha256)
        REFERENCES station_projection_versions(
          generation,
          content_sha256
        )
        ON DELETE RESTRICT
        ON UPDATE RESTRICT
    ) STRICT
  `,
  `
    CREATE TABLE IF NOT EXISTS station_received_cursors (
      event_home TEXT NOT NULL,
      entity_home TEXT NOT NULL,
      through_sequence TEXT NOT NULL
        CHECK (
          length(through_sequence) BETWEEN 1 AND 32
          AND through_sequence NOT GLOB '*[^0-9]*'
          AND substr(through_sequence, 1, 1) <> '0'
        ),
      updated_at TEXT NOT NULL
        CHECK (length(updated_at) BETWEEN 1 AND 64),
      PRIMARY KEY (event_home, entity_home),
      FOREIGN KEY (event_home)
        REFERENCES station_known_installations(installation_id)
        ON DELETE RESTRICT
        ON UPDATE RESTRICT,
      FOREIGN KEY (entity_home)
        REFERENCES station_known_installations(installation_id)
        ON DELETE RESTRICT
        ON UPDATE RESTRICT
    ) STRICT, WITHOUT ROWID
  `,
  `
    CREATE TABLE IF NOT EXISTS station_peer_ack_cursors (
      peer_installation_id TEXT NOT NULL,
      event_home TEXT NOT NULL,
      entity_home TEXT NOT NULL,
      through_sequence TEXT NOT NULL
        CHECK (
          length(through_sequence) BETWEEN 1 AND 32
          AND through_sequence NOT GLOB '*[^0-9]*'
          AND substr(through_sequence, 1, 1) <> '0'
        ),
      acknowledged_at TEXT NOT NULL
        CHECK (length(acknowledged_at) BETWEEN 1 AND 64),
      PRIMARY KEY (
        peer_installation_id,
        event_home,
        entity_home
      ),
      CHECK (peer_installation_id <> event_home),
      FOREIGN KEY (peer_installation_id)
        REFERENCES station_known_installations(installation_id)
        ON DELETE RESTRICT
        ON UPDATE RESTRICT,
      FOREIGN KEY (event_home)
        REFERENCES station_known_installations(installation_id)
        ON DELETE RESTRICT
        ON UPDATE RESTRICT,
      FOREIGN KEY (entity_home)
        REFERENCES station_known_installations(installation_id)
        ON DELETE RESTRICT
        ON UPDATE RESTRICT
    ) STRICT, WITHOUT ROWID
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
  `
    CREATE TRIGGER IF NOT EXISTS station_projection_version_immutable_update
    BEFORE UPDATE ON station_projection_versions
    BEGIN
      SELECT RAISE(ABORT, 'station projection versions are immutable');
    END
  `,
  `
    CREATE TRIGGER IF NOT EXISTS station_projection_version_immutable_delete
    BEFORE DELETE ON station_projection_versions
    BEGIN
      SELECT RAISE(ABORT, 'station projection versions are immutable');
    END
  `,
] as const;

export const STATION_STATE_SCHEMA_SQL =
  `${STATION_STATE_SCHEMA_STATEMENTS.join(";\n")};`;
