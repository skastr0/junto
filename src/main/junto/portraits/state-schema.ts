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

/**
 * Copy-forward for migration 4 -> 5: every seat override held in the settings
 * row (`portraits.bySeat`) becomes a row here. Preserve, never move: the
 * settings copy stays in place untouched; the app stops reading it. Entries
 * that could never have been valid rows (non-object, oversized) are skipped
 * rather than failing the step. Bound parameter: updated_at (epoch ms).
 */
export const PORTRAIT_OVERRIDES_COPY_FORWARD_SQL = `
  INSERT INTO portrait_overrides(seat_id, body_json, updated_at)
  SELECT entry.key, json(entry.value), ?
  FROM settings_preferences AS prefs,
       json_each(prefs.body, '$.portraits.bySeat') AS entry
  WHERE entry.type = 'object'
    AND length(entry.key) BETWEEN 1 AND 1024
    AND length(json(entry.value)) BETWEEN 2 AND 2048
  ON CONFLICT(seat_id) DO NOTHING
`;
