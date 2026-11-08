/**
 * What the seat's machine remembers of each `seat.control` it admitted
 * (0.11, 05 S4): one row per (firing, action) — the at-most-once record and
 * the result it settled with. A control held for a fold it has not seen has
 * no row; the sweep derives it from the work log. The reason is the closed
 * set the security review fixed, never harness or spawn words. Added by
 * state migration 58 -> 59.
 */
export const SEAT_CONTROLS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS seat_controls (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    firing_id TEXT NOT NULL CHECK (length(firing_id) BETWEEN 1 AND 128),
    action_index INTEGER NOT NULL CHECK (action_index BETWEEN 0 AND 15),
    control_id TEXT NOT NULL CHECK (length(control_id) BETWEEN 1 AND 256),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    op TEXT NOT NULL CHECK (op IN ('start', 'stop')),
    outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'refused')),
    reason TEXT CHECK (reason IS NULL OR reason IN ('not_permitted', 'not_found', 'paused', 'stale', 'rate', 'failed')),
    settled_at_epoch_ms INTEGER NOT NULL CHECK (settled_at_epoch_ms >= 0),
    PRIMARY KEY (canvas_name, firing_id, action_index)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS seat_controls_by_control
    ON seat_controls(canvas_name, control_id);

  CREATE INDEX IF NOT EXISTS seat_controls_by_seat_settled
    ON seat_controls(canvas_name, node_id, settled_at_epoch_ms);
`;
