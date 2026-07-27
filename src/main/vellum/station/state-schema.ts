/**
 * Durable Station coordination schema.
 *
 * Station intent is deliberately small: one installation identity, at most
 * one paired Command Center, one selected role/configuration, and one complete
 * replaceable projection. Canonical events live in the Work schema; Station
 * retains only transport cursors over those route-local logical sequences.
 * Timestamps are display metadata.
 *
 * This module is SQL-only so StateEngine can compose it without importing the
 * repository or the station wire contract.
 */
export const STATION_STATE_SCHEMA_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS station_installation (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      installation_id TEXT NOT NULL UNIQUE
        CHECK (length(installation_id) BETWEEN 1 AND 128),
      created_at TEXT NOT NULL
        CHECK (length(created_at) BETWEEN 1 AND 64)
    ) STRICT
  `,
  `
    CREATE TABLE IF NOT EXISTS station_pairing (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      command_center_installation_id TEXT NOT NULL
        CHECK (length(command_center_installation_id) BETWEEN 1 AND 128),
      station_label TEXT NOT NULL
        CHECK (length(station_label) BETWEEN 1 AND 128),
      app_version TEXT NOT NULL
        CHECK (length(app_version) BETWEEN 1 AND 64),
      paired_at TEXT NOT NULL
        CHECK (length(paired_at) BETWEEN 1 AND 64)
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
      command_center_ref TEXT,
      supervised_preferred INTEGER NOT NULL
        CHECK (supervised_preferred IN (0, 1)),
      configured_at TEXT NOT NULL
        CHECK (length(configured_at) BETWEEN 1 AND 64),
      CHECK (
        (
          role = 'command-center'
          AND agent_host_id IS NULL
          AND command_center_installation_id IS NULL
          AND command_center_ref IS NULL
        )
        OR
        (
          role = 'remote'
          AND agent_host_id IS NOT NULL
          AND length(agent_host_id) BETWEEN 1 AND 64
          AND command_center_installation_id IS NOT NULL
          AND length(command_center_installation_id) BETWEEN 1 AND 128
          AND command_center_ref IS NOT NULL
          AND length(command_center_ref) BETWEEN 1 AND 255
        )
      )
    ) STRICT
  `,
  `
    CREATE TABLE IF NOT EXISTS station_projection (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      generation TEXT NOT NULL
        CHECK (
          length(generation) BETWEEN 1 AND 32
          AND generation NOT GLOB '*[^0-9]*'
          AND (generation = '0' OR substr(generation, 1, 1) <> '0')
        ),
      body TEXT NOT NULL
        CHECK (length(body) BETWEEN 1 AND 67108864),
      content_sha256 TEXT NOT NULL
        CHECK (
          length(content_sha256) = 64
          AND content_sha256 NOT GLOB '*[^a-f0-9]*'
        ),
      created_at TEXT NOT NULL
        CHECK (length(created_at) BETWEEN 1 AND 64),
      received_at TEXT NOT NULL
        CHECK (length(received_at) BETWEEN 1 AND 64)
    ) STRICT
  `,
  `
    CREATE TABLE IF NOT EXISTS station_received_cursors (
      home TEXT PRIMARY KEY CHECK (length(home) BETWEEN 1 AND 128),
      through_sequence TEXT NOT NULL
        CHECK (
          length(through_sequence) BETWEEN 1 AND 32
          AND through_sequence NOT GLOB '*[^0-9]*'
          AND (
            through_sequence = '0'
            OR substr(through_sequence, 1, 1) <> '0'
          )
        ),
      updated_at TEXT NOT NULL
        CHECK (length(updated_at) BETWEEN 1 AND 64)
    ) STRICT, WITHOUT ROWID
  `,
  `
    CREATE TABLE IF NOT EXISTS station_peer_ack_cursors (
      peer_installation_id TEXT NOT NULL
        CHECK (length(peer_installation_id) BETWEEN 1 AND 128),
      home TEXT NOT NULL CHECK (length(home) BETWEEN 1 AND 128),
      through_sequence TEXT NOT NULL
        CHECK (
          length(through_sequence) BETWEEN 1 AND 32
          AND through_sequence NOT GLOB '*[^0-9]*'
          AND (
            through_sequence = '0'
            OR substr(through_sequence, 1, 1) <> '0'
          )
        ),
      acknowledged_at TEXT NOT NULL
        CHECK (length(acknowledged_at) BETWEEN 1 AND 64),
      PRIMARY KEY (peer_installation_id, home)
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
      endpoint TEXT NOT NULL UNIQUE
        CHECK (length(endpoint) BETWEEN 1 AND 255),
      station_installation_id TEXT NOT NULL UNIQUE
        CHECK (
          length(station_installation_id) BETWEEN 1 AND 128
          AND station_installation_id GLOB '[A-Za-z0-9]*'
          AND station_installation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        ),
      bound_at TEXT NOT NULL
        CHECK (length(bound_at) BETWEEN 1 AND 64),
      retired_at TEXT
        CHECK (
          retired_at IS NULL
          OR length(retired_at) BETWEEN 1 AND 64
        )
    ) STRICT, WITHOUT ROWID
  `,
] as const;

export const STATION_STATE_SCHEMA_SQL =
  `${STATION_STATE_SCHEMA_STATEMENTS.join(";\n")};`;
