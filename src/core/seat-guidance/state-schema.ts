/**
 * Seat guidance: the operator's optional soul and instructions for one agent
 * seat (`@shared/seat-guidance`), one row per seat identity (canvas node id,
 * the same key as `portrait_overrides`). A row holds at least one of the two;
 * clearing both deletes it. Added by state migration 6 -> 7.
 */
export const SEAT_GUIDANCE_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS seat_guidance (
    seat_id TEXT PRIMARY KEY CHECK (length(seat_id) BETWEEN 1 AND 1024),
    soul TEXT CHECK (soul IS NULL OR length(soul) BETWEEN 1 AND 4000),
    instructions TEXT
      CHECK (instructions IS NULL OR length(instructions) BETWEEN 1 AND 8000),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    CHECK (soul IS NOT NULL OR instructions IS NOT NULL)
  ) STRICT, WITHOUT ROWID;
`;
