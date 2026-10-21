/**
 * Automation storage (plan 0.10/07), on the editing machine only.
 *
 * - `automations`: each automation's ruled head, the encoded `Automation`.
 * - `automation_cursors`: the last schedule or poll slot the runner
 *   considered, per automation. Replaces `scheduler_interval_state`.
 * - `automation_ruling_cursors`: how far change triggers have read each
 *   canvas's task rulings.
 * - `automation_firings`: the claim slots, renamed from
 *   `scheduler_interval_firings` and keyed by automation, and the firing
 *   history in one row. The claim key is unique per automation and cause, so
 *   a restart can never fire one slot or one transition twice; a `run` claims
 *   its own firing id.
 */
const CANVAS_NAME_CHECK = `
      CHECK (
        length(canvas_name) BETWEEN 1 AND 64
        AND canvas_name GLOB '[a-z0-9]*'
        AND canvas_name NOT GLOB '*[^a-z0-9_-]*'
      )`;

const ULID_CHECK = (column: string) => `
      CHECK (length(${column}) = 26 AND ${column} NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')`;

/**
 * The automations a node delete archived, so undoing the delete (an Add of
 * the same node id) unarchives exactly those and leaves an automation the
 * operator archived before the delete archived. Added by a later state step
 * than the store itself.
 */
export const AUTOMATION_NODE_ARCHIVES_SQL = `
  CREATE TABLE IF NOT EXISTS automation_node_archives (
    canvas_name TEXT NOT NULL${CANVAS_NAME_CHECK},
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    automation_id TEXT NOT NULL${ULID_CHECK("automation_id")},
    PRIMARY KEY (canvas_name, node_id, automation_id)
  ) STRICT, WITHOUT ROWID;
`;

/**
 * How far the runner has read each canvas's applied task rulings: the
 * `work_events` seq of the last ruling it fired task changes from, in the
 * order rulings landed on this machine. Local to the editing machine; added
 * by a later state step than the store itself.
 */
export const AUTOMATION_RULING_CURSORS_SQL = `
  CREATE TABLE IF NOT EXISTS automation_ruling_cursors (
    canvas_name TEXT NOT NULL${CANVAS_NAME_CHECK},
    seq TEXT NOT NULL CHECK (length(seq) BETWEEN 1 AND 32 AND seq NOT GLOB '*[^0-9]*'),
    PRIMARY KEY (canvas_name)
  ) STRICT, WITHOUT ROWID;
`;

export const AUTOMATION_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS automations (
    canvas_name TEXT NOT NULL${CANVAS_NAME_CHECK},
    automation_id TEXT NOT NULL${ULID_CHECK("automation_id")},
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    version INTEGER NOT NULL CHECK (version >= 1),
    archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
    updated_at_epoch_ms INTEGER NOT NULL CHECK (updated_at_epoch_ms >= 0),
    automation_json TEXT NOT NULL
      CHECK (
        json_valid(automation_json)
        AND json_type(automation_json) = 'object'
        AND length(CAST(automation_json AS BLOB)) <= 262144
      ),
    PRIMARY KEY (canvas_name, automation_id)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS automations_by_node
    ON automations(canvas_name, node_id, archived);

  CREATE TABLE IF NOT EXISTS automation_cursors (
    canvas_name TEXT NOT NULL${CANVAS_NAME_CHECK},
    automation_id TEXT NOT NULL${ULID_CHECK("automation_id")},
    cursor_epoch_ms INTEGER NOT NULL CHECK (cursor_epoch_ms >= 0),
    PRIMARY KEY (canvas_name, automation_id)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS automation_firings (
    canvas_name TEXT NOT NULL${CANVAS_NAME_CHECK},
    automation_id TEXT NOT NULL${ULID_CHECK("automation_id")},
    cause_kind TEXT NOT NULL CHECK (cause_kind IN ('schedule', 'poll', 'change', 'run')),
    claim_key TEXT NOT NULL CHECK (length(claim_key) BETWEEN 1 AND 256),
    firing_id TEXT NOT NULL${ULID_CHECK("firing_id")},
    at_epoch_ms INTEGER NOT NULL CHECK (at_epoch_ms >= 0),
    fired INTEGER NOT NULL CHECK (fired IN (0, 1)),
    firing_json TEXT NOT NULL
      CHECK (
        json_valid(firing_json)
        AND json_type(firing_json) = 'object'
        AND length(CAST(firing_json AS BLOB)) <= 65536
      ),
    PRIMARY KEY (canvas_name, automation_id, cause_kind, claim_key),
    UNIQUE (canvas_name, firing_id)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS automation_firings_newest
    ON automation_firings(canvas_name, automation_id, firing_id);
`;
