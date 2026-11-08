import type { StateSchemaMigrationDatabase } from "./migrations";

/**
 * A task board derives into another (0.10.3): finishing a task on the first
 * makes a new task on the second, linked back to the one it came from. The
 * relation is the wire verb `derives`, so the wires table is rebuilt with it
 * in the verb CHECK, every row copied as it was: SQLite widens a CHECK no
 * other way. `task_heads` gains `derived_from`, the origin task's id, null on
 * every task held before this step, and an index to list an origin's derived
 * tasks. The DDL below is this step's own copy.
 */
export const DERIVES_VERB_REPLACED_TABLES = ["wires"] as const;

const WIRES_SQL = `
  CREATE TABLE IF NOT EXISTS wires (
    canvas_name TEXT NOT NULL REFERENCES canvases(canvas_name) ON UPDATE CASCADE,
    id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 256),
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    verb TEXT NOT NULL CHECK (verb IN ('messages', 'navigates', 'flows', 'derives')),
    from_side TEXT CHECK (from_side IN ('top', 'right', 'bottom', 'left')),
    to_side TEXT CHECK (to_side IN ('top', 'right', 'bottom', 'left')),
    mask_json TEXT CHECK (mask_json IS NULL OR json_valid(mask_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (canvas_name, id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS wires_from ON wires(canvas_name, from_id, id);
  CREATE INDEX IF NOT EXISTS wires_to ON wires(canvas_name, to_id, id);
`;

const TASK_DERIVED_FROM_SQL = `
  ALTER TABLE task_heads ADD COLUMN derived_from TEXT CHECK (derived_from IS NULL OR length(derived_from) = 26);
  CREATE INDEX IF NOT EXISTS task_heads_by_origin
    ON task_heads (canvas_name, derived_from)
    WHERE derived_from IS NOT NULL;
`;

const WIRE_COLUMNS = [
  "canvas_name", "id", "from_id", "to_id", "verb", "from_side", "to_side",
  "mask_json", "created_at", "updated_at",
] as const;

export const migrateDerivesVerb = (database: StateSchemaMigrationDatabase): void => {
  const stored = database
    .prepare(`SELECT ${WIRE_COLUMNS.join(", ")} FROM wires ORDER BY canvas_name, id`)
    .all() as unknown as ReadonlyArray<Record<(typeof WIRE_COLUMNS)[number], string | number | null>>;

  database.exec("DROP TABLE wires");
  database.exec(WIRES_SQL);
  const insert = database.prepare(
    `INSERT INTO wires(${WIRE_COLUMNS.join(", ")}) VALUES (${WIRE_COLUMNS.map(() => "?").join(", ")})`,
  );
  for (const row of stored) insert.run(...WIRE_COLUMNS.map((column) => row[column]));
  const kept = Number(database.prepare("SELECT count(*) AS n FROM wires").get()!.n);
  if (kept !== stored.length) throw new Error("a wire did not survive the derives step");

  database.exec(TASK_DERIVED_FROM_SQL);
};
