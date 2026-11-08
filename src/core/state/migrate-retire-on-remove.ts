import type { StateSchemaMigrationDatabase } from "./migrations";

/**
 * State migration 24 -> 25. A seat or terminal row said what happened to its
 * process when it was removed from the canvas; nothing ever read that for a
 * seat or a terminal, so this step retires `on_remove` from both tables.
 * Every row survives with every other column as it was. Pages keep theirs.
 *
 * The DDL below is this step's own copy. It never follows the head schema.
 */

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

const SEATS_V25_SQL = `${table(
  "seats",
  `
    agent_key TEXT NOT NULL,
    label TEXT NOT NULL,
    host TEXT NOT NULL DEFAULT 'local',
    binding_id TEXT NOT NULL,
    harness TEXT NOT NULL,
    overseer INTEGER NOT NULL CHECK (overseer IN (0, 1)),
    ${launch}`,
)}
  CREATE UNIQUE INDEX IF NOT EXISTS seats_canvas_binding ON seats(canvas_name, binding_id);
`;

const TERMINALS_V25_SQL = `${table(
  "terminals",
  `
    label TEXT,
    host TEXT NOT NULL DEFAULT 'local',
    binding_id TEXT NOT NULL,
    ${launch}`,
)}
  CREATE UNIQUE INDEX IF NOT EXISTS terminals_canvas_binding ON terminals(canvas_name, binding_id);
`;

const GEOMETRY_COLUMNS = [
  "canvas_name", "id", "x", "y", "width", "height", "z_index", "color", "created_at", "updated_at",
] as const;
const LAUNCH_COLUMNS = [
  "launch_kind", "launch_cwd", "launch_argv_json", "launch_env_json", "launch_extra_args_json",
] as const;

/** Every column each table keeps: all but `on_remove`. */
const KEPT = {
  seats: [
    ...GEOMETRY_COLUMNS,
    "agent_key", "label", "host", "binding_id", "harness", "overseer",
    ...LAUNCH_COLUMNS,
  ],
  terminals: [...GEOMETRY_COLUMNS, "label", "host", "binding_id", ...LAUNCH_COLUMNS],
} as const;

const rebuild = (database: StateSchemaMigrationDatabase, name: keyof typeof KEPT, sql: string): void => {
  const columns = KEPT[name];
  const stored = database
    .prepare(`SELECT ${columns.join(", ")} FROM ${name} ORDER BY canvas_name, id`)
    .all() as unknown as ReadonlyArray<Record<string, string | number | null>>;

  database.exec(`DROP TABLE ${name}`);
  database.exec(sql);
  const insert = database.prepare(
    `INSERT INTO ${name}(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  );
  for (const row of stored) insert.run(...columns.map((column) => row[column]));
  const kept = Number(database.prepare(`SELECT count(*) AS n FROM ${name}`).get()!.n);
  if (kept !== stored.length) throw new Error(`a row of ${name} did not survive the step`);
};

export const migrateRetireOnRemove = (database: StateSchemaMigrationDatabase): void => {
  rebuild(database, "seats", SEATS_V25_SQL);
  rebuild(database, "terminals", TERMINALS_V25_SQL);
};
