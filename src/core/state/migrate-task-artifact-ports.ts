import type { StateSchemaMigrationDatabase } from "./migrations";

/**
 * A seat reaches a task board or an artifacts node by region, with no edge
 * and no port, so the `tasks.*` ports and `artifact.publish` leave the closed
 * port list. A wire's stored mask decodes against that list, so the words
 * leave every stored mask here before they leave the list. A mask that named
 * only them keeps an empty list: it granted nothing before, and grants
 * nothing now. `artifact.publish` stays a journal operation name; only the
 * port goes.
 *
 * The wires table is rebuilt with the same text, the one way a consolidate
 * step may rewrite its rows. The DDL below is this step's own copy.
 */
export const TASK_ARTIFACT_PORTS = [
  "tasks.list",
  "tasks.create",
  "tasks.claim",
  "tasks.update",
  "artifact.publish",
] as const;

export const TASK_ARTIFACT_PORTS_REPLACED_TABLES = ["wires"] as const;

const RETIRED_PORTS: ReadonlySet<string> = new Set(TASK_ARTIFACT_PORTS);

const WIRES_SQL = `
  CREATE TABLE IF NOT EXISTS wires (
    canvas_name TEXT NOT NULL REFERENCES canvases(canvas_name) ON UPDATE CASCADE,
    id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 256),
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    verb TEXT NOT NULL CHECK (verb IN ('messages', 'navigates', 'flows')),
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

const WIRE_COLUMNS = [
  "canvas_name", "id", "from_id", "to_id", "verb", "from_side", "to_side",
  "mask_json", "created_at", "updated_at",
] as const;

type WireRow = Record<(typeof WIRE_COLUMNS)[number], string | number | null>;

/** The mask without the retired ports, in the order it was stored. */
const withoutTaskArtifactPorts = (mask: string | number | null): string | number | null => {
  if (typeof mask !== "string") return mask;
  const ports: unknown = JSON.parse(mask);
  if (!Array.isArray(ports) || !ports.some((port) => RETIRED_PORTS.has(String(port)))) return mask;
  return JSON.stringify(ports.filter((port) => !RETIRED_PORTS.has(String(port))));
};

export const migrateTaskArtifactPorts = (database: StateSchemaMigrationDatabase): void => {
  const stored = database
    .prepare(`SELECT ${WIRE_COLUMNS.join(", ")} FROM wires ORDER BY canvas_name, id`)
    .all() as unknown as ReadonlyArray<WireRow>;

  database.exec("DROP TABLE wires");
  database.exec(WIRES_SQL);
  const insert = database.prepare(
    `INSERT INTO wires(${WIRE_COLUMNS.join(", ")}) VALUES (${WIRE_COLUMNS.map(() => "?").join(", ")})`,
  );
  for (const row of stored) {
    insert.run(...WIRE_COLUMNS.map((column) => (column === "mask_json" ? withoutTaskArtifactPorts(row.mask_json) : row[column])));
  }
  const kept = Number(database.prepare("SELECT count(*) AS n FROM wires").get()!.n);
  if (kept !== stored.length) throw new Error("a wire did not survive the task and artifact ports step");
};
