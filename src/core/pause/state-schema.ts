/**
 * Factory pause state is normalized by canvas and scope. An absent canvas row
 * is the born-paused state; scope rows cannot exist without their canvas.
 */
export const FACTORY_PAUSE_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS factory_pause_canvases (
    canvas_name TEXT PRIMARY KEY
      CHECK (
        length(canvas_name) BETWEEN 1 AND 64
        AND canvas_name GLOB '[a-z0-9]*'
        AND canvas_name NOT GLOB '*[^a-z0-9_-]*'
      ),
    playing INTEGER NOT NULL CHECK (playing IN (0, 1)),
    ever_played INTEGER NOT NULL CHECK (ever_played IN (0, 1)),
    updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS factory_pause_scopes (
    canvas_name TEXT NOT NULL
      REFERENCES factory_pause_canvases(canvas_name) ON DELETE CASCADE,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('node', 'region')),
    scope_id TEXT NOT NULL CHECK (length(scope_id) BETWEEN 1 AND 1024),
    paused_at TEXT NOT NULL CHECK (length(paused_at) BETWEEN 1 AND 64),
    PRIMARY KEY (canvas_name, scope_kind, scope_id)
  ) STRICT, WITHOUT ROWID;
`;
