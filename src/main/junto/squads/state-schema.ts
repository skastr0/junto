/**
 * Squads: the operator's reusable seat templates (`@shared/squads`). Durable
 * because the operator builds them once and places them again and again. The
 * template body is JSON decoded on read with bounded, forgiving fields, so a
 * harness or verb a later build retires never makes a row unreadable.
 */
export const SQUADS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS squads (
    squad_id TEXT PRIMARY KEY CHECK (length(squad_id) BETWEEN 1 AND 64),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
    body_json TEXT NOT NULL
      CHECK (length(body_json) BETWEEN 2 AND 262144 AND json_valid(body_json)),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
  ) STRICT, WITHOUT ROWID;

  CREATE UNIQUE INDEX IF NOT EXISTS squads_by_name
    ON squads(name COLLATE NOCASE);
`;
