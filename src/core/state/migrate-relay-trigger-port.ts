import type { StateSchemaMigrationDatabase } from "./migrations";

/**
 * The relay kind is gone, and with it the `relay.trigger` port. A wire's
 * stored mask decodes against the closed port list, so the word leaves every
 * stored mask here before it leaves the list. A mask that named only it keeps
 * an empty list: it granted nothing before, and grants nothing now.
 *
 * The wires table is rebuilt with the same text, the one way a consolidate
 * step may rewrite its rows. The DDL below is this step's own copy.
 */
export const RELAY_TRIGGER_PORT = "relay.trigger";

export const RELAY_TRIGGER_PORT_REPLACED_TABLES = ["wires"] as const;

const WIRES_SQL = `
  CREATE TABLE IF NOT EXISTS wires (
    canvas_name TEXT NOT NULL REFERENCES canvases(canvas_name) ON UPDATE CASCADE,
    id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 256),
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    verb TEXT NOT NULL CHECK (verb IN ('messages', 'reviews', 'participates', 'navigates', 'flows')),
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

/** The mask without the retired port, in the order it was stored. */
const withoutRelayTrigger = (mask: string | number | null): string | number | null => {
  if (typeof mask !== "string") return mask;
  const ports: unknown = JSON.parse(mask);
  if (!Array.isArray(ports) || !ports.includes(RELAY_TRIGGER_PORT)) return mask;
  return JSON.stringify(ports.filter((port) => port !== RELAY_TRIGGER_PORT));
};

export const migrateRelayTriggerPort = (database: StateSchemaMigrationDatabase): void => {
  const stored = database
    .prepare(`SELECT ${WIRE_COLUMNS.join(", ")} FROM wires ORDER BY canvas_name, id`)
    .all() as unknown as ReadonlyArray<WireRow>;

  database.exec("DROP TABLE wires");
  database.exec(WIRES_SQL);
  const insert = database.prepare(
    `INSERT INTO wires(${WIRE_COLUMNS.join(", ")}) VALUES (${WIRE_COLUMNS.map(() => "?").join(", ")})`,
  );
  for (const row of stored) {
    insert.run(...WIRE_COLUMNS.map((column) => (column === "mask_json" ? withoutRelayTrigger(row.mask_json) : row[column])));
  }
  const kept = Number(database.prepare("SELECT count(*) AS n FROM wires").get()!.n);
  if (kept !== stored.length) throw new Error("a wire did not survive the relay.trigger step");
};
