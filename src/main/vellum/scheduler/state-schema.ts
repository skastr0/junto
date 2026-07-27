/**
 * Durable interval-scheduler cursors.
 *
 * The cursor is owned by exactly one station home and one timer key. Wall
 * clock values only decide whether a slot is due; the decimal slot is the
 * logical identity used for deduplication and restart-safe catch-up.
 */
export const SCHEDULER_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS scheduler_interval_state (
    home_station TEXT NOT NULL
      CHECK (
        length(home_station) BETWEEN 1 AND 64
        AND substr(home_station, 1, 1) <> '-'
        AND home_station GLOB '[A-Za-z0-9]*'
        AND home_station NOT GLOB '*[^A-Za-z0-9._-]*'
      ),
    timer_key TEXT NOT NULL CHECK (length(timer_key) BETWEEN 1 AND 512),
    schedule_id TEXT NOT NULL CHECK (length(schedule_id) BETWEEN 1 AND 256),
    interval_milliseconds INTEGER NOT NULL
      CHECK (interval_milliseconds > 0),
    next_due_at_epoch_ms INTEGER NOT NULL
      CHECK (next_due_at_epoch_ms >= 0),
    next_due_slot TEXT NOT NULL
      CHECK (
        length(next_due_slot) > 0
        AND next_due_slot NOT GLOB '*[^0-9]*'
        AND (
          next_due_slot = '0'
          OR substr(next_due_slot, 1, 1) <> '0'
        )
      ),
    last_fired_slot TEXT
      CHECK (
        last_fired_slot IS NULL
        OR (
          length(last_fired_slot) > 0
          AND last_fired_slot NOT GLOB '*[^0-9]*'
          AND (
            last_fired_slot = '0'
            OR substr(last_fired_slot, 1, 1) <> '0'
          )
        )
      ),
    updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
    PRIMARY KEY (home_station, timer_key)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS scheduler_interval_firings (
    home_station TEXT NOT NULL
      CHECK (length(home_station) BETWEEN 1 AND 64),
    timer_key TEXT NOT NULL CHECK (length(timer_key) BETWEEN 1 AND 512),
    schedule_id TEXT NOT NULL CHECK (length(schedule_id) BETWEEN 1 AND 256),
    claim_slot TEXT NOT NULL
      CHECK (
        length(claim_slot) > 0
        AND claim_slot NOT GLOB '*[^0-9]*'
        AND (
          claim_slot = '0'
          OR substr(claim_slot, 1, 1) <> '0'
        )
      ),
    due_slot TEXT NOT NULL
      CHECK (
        length(due_slot) > 0
        AND due_slot NOT GLOB '*[^0-9]*'
        AND (
          due_slot = '0'
          OR substr(due_slot, 1, 1) <> '0'
        )
      ),
    scheduled_for_epoch_ms INTEGER NOT NULL
      CHECK (scheduled_for_epoch_ms >= 0),
    observed_at_epoch_ms INTEGER NOT NULL
      CHECK (observed_at_epoch_ms >= 0),
    coalesced_missed_slots TEXT NOT NULL
      CHECK (
        length(coalesced_missed_slots) > 0
        AND coalesced_missed_slots NOT GLOB '*[^0-9]*'
        AND (
          coalesced_missed_slots = '0'
          OR substr(coalesced_missed_slots, 1, 1) <> '0'
        )
      ),
    claimed_at TEXT NOT NULL CHECK (length(claimed_at) BETWEEN 1 AND 64),
    PRIMARY KEY (
      home_station,
      timer_key,
      schedule_id,
      claim_slot
    )
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS scheduler_interval_due
    ON scheduler_interval_state(
      home_station,
      next_due_at_epoch_ms,
      timer_key
    );
`;
