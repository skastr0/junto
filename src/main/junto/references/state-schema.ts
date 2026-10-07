/**
 * The app briefing and references (`@shared/references`): prose the operator
 * keeps in Junto. One row is the briefing; every other row is one named
 * reference, app-wide or belonging to one region of one canvas. Neither
 * description nor body has a length bound.
 *
 * `canvas_name` and `region_id` are plain values, not foreign keys: a row
 * whose region is gone is simply never listed. Added by state migration
 * 11 -> 12.
 */
export const APP_TEXTS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS app_texts (
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('briefing', 'app', 'region')),
    canvas_name TEXT NOT NULL,
    region_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT CHECK (description IS NULL OR length(description) >= 1),
    body TEXT NOT NULL CHECK (length(body) >= 1),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    updated_by TEXT NOT NULL CHECK (length(updated_by) >= 1),
    PRIMARY KEY (scope_kind, canvas_name, region_id, name),
    CHECK (
      (scope_kind = 'briefing' AND canvas_name = '' AND region_id = '' AND name = '' AND description IS NULL)
      OR (scope_kind = 'app' AND canvas_name = '' AND region_id = '' AND length(name) BETWEEN 1 AND 80)
      OR (scope_kind = 'region' AND length(canvas_name) >= 1 AND length(region_id) >= 1 AND length(name) BETWEEN 1 AND 80)
    )
  ) STRICT, WITHOUT ROWID;
`;
