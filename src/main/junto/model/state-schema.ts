/** Domain storage. Geometry belongs to each kind; Work contents stay in Work. */
const geometry = `
  canvas_name TEXT NOT NULL REFERENCES canvases(canvas_name) ON UPDATE CASCADE,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 256),
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL NOT NULL CHECK (width > 0),
  height REAL NOT NULL CHECK (height > 0),
  z_index INTEGER NOT NULL,
  color TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL`;

const launch = `
  launch_kind TEXT CHECK (launch_kind IN ('shell', 'command', 'harness')),
  launch_cwd TEXT,
  launch_argv_json TEXT CHECK (launch_argv_json IS NULL OR json_valid(launch_argv_json)),
  launch_env_json TEXT CHECK (launch_env_json IS NULL OR json_valid(launch_env_json)),
  launch_extra_args_json TEXT CHECK (launch_extra_args_json IS NULL OR json_valid(launch_extra_args_json))`;

const table = (name: string, fields: string): string => `
  CREATE TABLE IF NOT EXISTS ${name} (
    ${geometry},
    ${fields},
    PRIMARY KEY (canvas_name, id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS ${name}_canvas_order ON ${name}(canvas_name, z_index, id);
`;

/** Closed kind-to-table map. Table identifiers never come from a caller. */
export const KIND_TABLES = {
  agent: "seats",
  peer: "peers",
  region: "regions",
  terminal: "terminals",
  page: "pages",
  task: "task_boards",
  requests: "request_boards",
  artifacts: "artifact_boards",
  board: "boards",
  pad: "pads",
  sheet: "sheets",
  cron: "crons",
  relay: "relays",
  watcher: "watchers",
  note: "notes",
  label: "labels",
  file: "file_cards",
  link: "link_cards",
  git: "git_repositories",
} as const;

/**
 * Seats that live on other machines, held only in a copy of a canvas: who and
 * where, and nothing to start one from. Added by state migration 16 -> 17.
 */
export const PEERS_STATE_SCHEMA_SQL = table(
  "peers",
  `
    label TEXT NOT NULL,
    host TEXT NOT NULL,
    seat_id TEXT NOT NULL
      CHECK (
        length(seat_id) = 69
        AND substr(seat_id, 1, 5) = 'seat_'
        AND substr(seat_id, 6) NOT GLOB '*[^a-f0-9]*'
      )`,
);

export const MODEL_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS canvases (
    canvas_name TEXT PRIMARY KEY CHECK (length(canvas_name) BETWEEN 1 AND 64),
    canvas_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0)
  ) STRICT, WITHOUT ROWID;

  ${table(
    "seats",
    `
    agent_key TEXT NOT NULL,
    label TEXT NOT NULL,
    host TEXT NOT NULL DEFAULT 'local',
    binding_id TEXT NOT NULL,
    harness TEXT NOT NULL,
    session_id TEXT,
    on_remove TEXT NOT NULL CHECK (on_remove IN ('detach', 'kill-session')),
    overseer INTEGER NOT NULL CHECK (overseer IN (0, 1)),
    ${launch}`,
  )}
  CREATE UNIQUE INDEX IF NOT EXISTS seats_canvas_binding ON seats(canvas_name, binding_id);

  ${table(
    "terminals",
    `
    label TEXT,
    host TEXT NOT NULL DEFAULT 'local',
    binding_id TEXT NOT NULL,
    on_remove TEXT NOT NULL CHECK (on_remove IN ('detach', 'kill-session')),
    ${launch}`,
  )}
  CREATE UNIQUE INDEX IF NOT EXISTS terminals_canvas_binding ON terminals(canvas_name, binding_id);

  ${table(
    "regions",
    `
    label TEXT,
    hold INTEGER NOT NULL CHECK (hold IN (0, 1)),
    instruction TEXT,
    page_url TEXT,
    page_profile TEXT,
    page_host TEXT,
    paths_json TEXT CHECK (paths_json IS NULL OR json_valid(paths_json)),
    rules_json TEXT CHECK (rules_json IS NULL OR json_valid(rules_json)),
    rulings_json TEXT CHECK (rulings_json IS NULL OR json_valid(rulings_json)),
    environment_json TEXT CHECK (environment_json IS NULL OR json_valid(environment_json)),
    background TEXT,
    background_style TEXT CHECK (background_style IN ('cover', 'ratio', 'repeat'))`,
  )}

  ${table(
    "pages",
    `
    url TEXT NOT NULL,
    host TEXT NOT NULL DEFAULT 'local',
    profile TEXT NOT NULL,
    on_remove TEXT NOT NULL CHECK (on_remove IN ('detach', 'kill-session'))`,
  )}

  ${table(
    "task_boards",
    `
    name TEXT,
    contract_json TEXT CHECK (contract_json IS NULL OR json_valid(contract_json))`,
  )}
  ${table("request_boards", "name TEXT")}
  ${table("artifact_boards", "label TEXT")}
  ${table("boards", "label TEXT")}
  ${table("pads", "label TEXT")}
  ${table("sheets", "label TEXT")}
  CREATE TABLE IF NOT EXISTS sheet_grids (
    canvas_name TEXT NOT NULL,
    id TEXT NOT NULL,
    columns_json TEXT NOT NULL CHECK (json_valid(columns_json)),
    rows_json TEXT NOT NULL CHECK (json_valid(rows_json)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (canvas_name,id),
    FOREIGN KEY (canvas_name,id) REFERENCES sheets(canvas_name,id) ON DELETE CASCADE ON UPDATE CASCADE
  ) STRICT, WITHOUT ROWID;

  ${table(
    "crons",
    `
    label TEXT,
    host TEXT NOT NULL DEFAULT 'local',
    expression TEXT CHECK (expression IS NULL OR length(expression) > 0)`,
  )}
  ${table("relays", "label TEXT, host TEXT NOT NULL DEFAULT 'local'")}
  ${table(
    "watchers",
    `
    label TEXT,
    host TEXT NOT NULL DEFAULT 'local',
    watch_key TEXT,
    stat TEXT,
    op TEXT CHECK (op IN ('gt', 'lt', 'eq')),
    value REAL`,
  )}
  ${table("notes", "text TEXT NOT NULL")}
  ${table("labels", "text TEXT NOT NULL")}
  ${table("file_cards", "path TEXT NOT NULL, subpath TEXT")}
  ${table("link_cards", "url TEXT NOT NULL")}
  ${table("git_repositories", "label TEXT, cwd TEXT NOT NULL")}

  CREATE TABLE IF NOT EXISTS wires (
    canvas_name TEXT NOT NULL REFERENCES canvases(canvas_name) ON UPDATE CASCADE,
    id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 256),
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    verb TEXT NOT NULL CHECK (verb IN (
      'messages', 'reviews', 'manages', 'contributes', 'publishes',
      'participates', 'reads', 'edits', 'navigates', 'fires', 'announces',
      'works', 'feeds', 'wakes', 'enqueues', 'chains'
    )),
    from_side TEXT CHECK (from_side IN ('top', 'right', 'bottom', 'left')),
    to_side TEXT CHECK (to_side IN ('top', 'right', 'bottom', 'left')),
    mask_json TEXT CHECK (mask_json IS NULL OR json_valid(mask_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (canvas_name, id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS wires_from ON wires(canvas_name, from_id, id);
  CREATE INDEX IF NOT EXISTS wires_to ON wires(canvas_name, to_id, id);

  ${PEERS_STATE_SCHEMA_SQL}
`;
