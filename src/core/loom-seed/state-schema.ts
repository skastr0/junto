/**
 * The loom's settled routes, kept as derived local data so a launch does not
 * have to route an unchanged board again. One row per canvas: the seed the
 * planner takes, the router version it was written at, and when. A seed at
 * another router version is ignored, and the canvas's delete takes it.
 *
 * Added by state migration 73 -> 74. Local only: it never crosses machines
 * and never enters a canvas copy.
 */
export const LOOM_SEEDS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS loom_seeds (
    canvas_name TEXT NOT NULL
      CHECK (length(canvas_name) BETWEEN 1 AND 256)
      REFERENCES canvases (canvas_name) ON DELETE CASCADE,
    router_version INTEGER NOT NULL CHECK (router_version >= 0),
    seed_json TEXT NOT NULL,
    saved_at INTEGER NOT NULL,
    PRIMARY KEY (canvas_name)
  ) STRICT, WITHOUT ROWID;
`;

/**
 * The seed beside the canvas, in parts: one row per card and one per wire, so
 * a moved card rewrites its own row and the wires it re-routed, never the
 * 40 MB a canvas-wide JSON blob would. The meta row says which router wrote
 * it and when. A canvas's delete takes every part.
 *
 * Added by state migration 74 -> 75. The 74 blob stays where it is, unused;
 * a consolidate step may retire it once no installed database can be running
 * a build that writes it.
 */
export const LOOM_SEED_PARTS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS loom_seed_meta (
    canvas_name TEXT NOT NULL
      CHECK (length(canvas_name) BETWEEN 1 AND 256)
      REFERENCES canvases (canvas_name) ON DELETE CASCADE,
    router_version INTEGER NOT NULL CHECK (router_version >= 0),
    fingerprint INTEGER NOT NULL,
    specs_key TEXT NOT NULL,
    geometry_key INTEGER NOT NULL,
    saved_at INTEGER NOT NULL,
    PRIMARY KEY (canvas_name)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS loom_seed_cards (
    canvas_name TEXT NOT NULL
      REFERENCES canvases (canvas_name) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    width REAL NOT NULL,
    height REAL NOT NULL,
    obstacle INTEGER NOT NULL CHECK (obstacle IN (0, 1)),
    PRIMARY KEY (canvas_name, node_id)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS loom_seed_wires (
    canvas_name TEXT NOT NULL
      REFERENCES canvases (canvas_name) ON DELETE CASCADE,
    wire_id TEXT NOT NULL,
    spec_key TEXT NOT NULL,
    fact TEXT NOT NULL,
    PRIMARY KEY (canvas_name, wire_id)
  ) STRICT, WITHOUT ROWID;
`;
