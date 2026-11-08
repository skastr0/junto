/**
 * Portrait overrides: the operator's per-seat character customization
 * (`@shared/portrait-overrides`), one row per seat identity (canvas node id).
 * The body is JSON normalized on read, so a trait a later build retires never
 * makes a row unreadable. Moved out of the settings row, whose JSON body is
 * capped, by state migration 4 -> 5.
 */
export const PORTRAIT_OVERRIDES_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS portrait_overrides (
    seat_id TEXT PRIMARY KEY CHECK (length(seat_id) BETWEEN 1 AND 1024),
    body_json TEXT NOT NULL
      CHECK (
        length(body_json) BETWEEN 2 AND 2048
        AND json_valid(body_json)
        AND json_type(body_json) = 'object'
      ),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
  ) STRICT, WITHOUT ROWID;
`;
