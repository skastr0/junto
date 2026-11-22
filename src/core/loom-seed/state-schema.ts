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
