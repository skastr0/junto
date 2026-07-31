/**
 * Durable kernel operator intent and the bounded diagnostic pulse ring.
 *
 * RETAINED SCHEMA BYTES — Region Pulse product (arming + debug pulse ring) is
 * retired. Tables are not dropped (SQLite evolution law: no physical retirement
 * in routine migrations). Product path no longer reads/writes these rows for
 * delivery; repository methods remain for schema-identity tests.
 *
 * Arming was normalized by canvas/region. Debug pulses were diagnostic only;
 * the ring is capped at twenty positions and every field has a fixed domain
 * shape.
 */
export const KERNEL_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS kernel_armed_regions (
    canvas_name TEXT NOT NULL
      CHECK (
        length(canvas_name) BETWEEN 1 AND 64
        AND canvas_name GLOB '[a-z0-9]*'
        AND canvas_name NOT GLOB '*[^a-z0-9_-]*'
      ),
    region_id TEXT NOT NULL CHECK (length(region_id) BETWEEN 1 AND 1024),
    armed_at TEXT NOT NULL CHECK (length(armed_at) BETWEEN 1 AND 64),
    PRIMARY KEY (canvas_name, region_id)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS kernel_debug_pulses (
    position INTEGER PRIMARY KEY CHECK (position BETWEEN 0 AND 19),
    id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 256),
    at_epoch_ms INTEGER NOT NULL CHECK (at_epoch_ms >= 0),
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 64),
    source_node_id TEXT NOT NULL
      CHECK (length(source_node_id) BETWEEN 1 AND 1024),
    region_id TEXT CHECK (
      region_id IS NULL OR length(region_id) BETWEEN 1 AND 1024
    ),
    kind TEXT NOT NULL CHECK (kind IN ('watcher', 'timer', 'manual')),
    summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 4096),
    delivered_json TEXT NOT NULL
      CHECK (
        json_valid(delivered_json)
        AND json_type(delivered_json) = 'array'
        AND length(CAST(delivered_json AS BLOB)) <= 65536
      ),
    dry INTEGER NOT NULL CHECK (dry IN (0, 1)),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 1 AND 64)
  ) STRICT;
`;
