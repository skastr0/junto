/**
 * How far this machine is caught up on the facts of one writer for one
 * canvas. `through` is the highest sequence a sender vouched it has given
 * this machine everything it is entitled to; entitlement leaves gaps, so it is
 * not the highest sequence held. `last_basis_seq` is the canvas count stated
 * by the newest fact taken from that writer: within one writer's sequence it
 * never goes backwards. Added by state migration 15 -> 16.
 */
export const WORK_EXCHANGE_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS work_exchange_cursors (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    writer TEXT NOT NULL,
    through TEXT NOT NULL
      CHECK (
        length(through) BETWEEN 1 AND 32
        AND through NOT GLOB '*[^0-9]*'
        AND (through = '0' OR substr(through, 1, 1) <> '0')
      ),
    last_basis_seq INTEGER NOT NULL
      CHECK (last_basis_seq BETWEEN 0 AND 9007199254740991),
    updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
    PRIMARY KEY (canvas_name, writer),
    FOREIGN KEY (writer)
      REFERENCES known_installations(installation_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;
`;

/** The cursor table exactly as state migration 15 -> 16 creates it. */
export const WORK_EXCHANGE_CURSORS_V16_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS work_exchange_cursors (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    writer TEXT NOT NULL,
    through TEXT NOT NULL
      CHECK (
        length(through) BETWEEN 1 AND 32
        AND through NOT GLOB '*[^0-9]*'
        AND (through = '0' OR substr(through, 1, 1) <> '0')
      ),
    last_basis_seq INTEGER NOT NULL
      CHECK (last_basis_seq BETWEEN 0 AND 9007199254740991),
    updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
    PRIMARY KEY (canvas_name, writer),
    FOREIGN KEY (writer)
      REFERENCES station_known_installations(installation_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;
`;

/**
 * What the machine that edits a canvas remembers about the copies it sent:
 * each count it sent each machine, and which machine each seat was on from
 * which count to which. A row that arrives later is judged against where its
 * author's seat was at the count the row states, so mail written before a
 * seat moved or was removed still arrives, and a writer cannot state a count
 * it was never sent. Added by state migration 18 -> 19.
 */
export const CANVAS_COPY_HISTORY_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS canvas_copies_sent (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    target TEXT NOT NULL CHECK (length(target) BETWEEN 1 AND 128),
    seq INTEGER NOT NULL CHECK (seq BETWEEN 0 AND 9007199254740991),
    sent_at TEXT NOT NULL CHECK (length(sent_at) BETWEEN 1 AND 64),
    PRIMARY KEY (canvas_name, target, seq)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS canvas_placements (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    from_seq INTEGER NOT NULL CHECK (from_seq BETWEEN 0 AND 9007199254740991),
    until_seq INTEGER CHECK (until_seq IS NULL OR until_seq > from_seq),
    seat_id TEXT NOT NULL
      CHECK (
        length(seat_id) = 69
        AND substr(seat_id, 1, 5) = 'seat_'
        AND substr(seat_id, 6) NOT GLOB '*[^a-f0-9]*'
      ),
    machine TEXT NOT NULL CHECK (length(machine) BETWEEN 1 AND 128),
    PRIMARY KEY (canvas_name, node_id, from_seq)
  ) STRICT, WITHOUT ROWID;

  CREATE UNIQUE INDEX IF NOT EXISTS canvas_placements_open
    ON canvas_placements(canvas_name, node_id)
    WHERE until_seq IS NULL;
`;

/**
 * With files over SSH (0.12.1, X6, remote-security C2): the canvases each
 * machine was last sent a Files node of whole, by the machine that edits
 * them. A row means that machine may still hold the node and its root, so
 * once it has no reason left it is sent the departure copy. Written in the
 * transaction that records each copy sent: a copy carrying a Files node sets
 * it, and the departure copy or a copy without one clears it, so a restart
 * never loses it. Added by state migration 80 -> 81.
 */
export const CANVAS_FILES_CARRIED_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS canvas_files_carried (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    target TEXT NOT NULL CHECK (length(target) BETWEEN 1 AND 128),
    seq INTEGER NOT NULL CHECK (seq BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (canvas_name, target)
  ) STRICT, WITHOUT ROWID;
`;

/**
 * A canvas removed across machines (0.12.1, remote-security terms 1 to 4).
 *
 * `canvas_removals_owed`, on the machine that edited the canvas: each
 * machine it had sent a copy of that canvas id to, written in the removal's
 * own transaction before the copy history and departure marks go, and kept
 * until that machine says it took the removal.
 *
 * `canvas_removed`, on the machine that held the copy: the canvas id its
 * editor removed, so a copy of that id, or of an older one under the name
 * from that editor, never brings it back. Added by state migration 81 -> 82.
 */
export const CANVAS_REMOVALS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS canvas_removals_owed (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    canvas_id TEXT NOT NULL CHECK (length(canvas_id) BETWEEN 1 AND 128),
    target TEXT NOT NULL CHECK (length(target) BETWEEN 1 AND 128),
    removed_at TEXT NOT NULL CHECK (length(removed_at) BETWEEN 1 AND 64),
    PRIMARY KEY (canvas_id, target)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS canvas_removed (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    canvas_id TEXT NOT NULL CHECK (length(canvas_id) BETWEEN 1 AND 128),
    editor TEXT NOT NULL CHECK (length(editor) BETWEEN 1 AND 128),
    removed_at TEXT NOT NULL CHECK (length(removed_at) BETWEEN 1 AND 64),
    PRIMARY KEY (canvas_name, canvas_id)
  ) STRICT, WITHOUT ROWID;
`;

/**
 * The canvases an earlier build removed on this machine while it edited them,
 * by name, with each machine it had sent a copy: what that build left in
 * `canvas_copies_sent` for a canvas this machine no longer held. Recorded once,
 * at state migration 82 -> 83, and never fed again: the copy history of a live
 * canvas is not a removal (remote-security, LOW 1 on 4689b5d6e). A machine
 * that states it still holds one is sent the removal, and admits it only from
 * its recorded editor with the id it holds.
 */
export const CANVAS_REMOVED_EARLIER_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS canvas_removed_earlier (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    target TEXT NOT NULL CHECK (length(target) BETWEEN 1 AND 128),
    PRIMARY KEY (canvas_name, target)
  ) STRICT, WITHOUT ROWID;
`;

/** The one fill of `canvas_removed_earlier`, from what an earlier build left. */
export const CANVAS_REMOVED_EARLIER_FILL_SQL = `
  INSERT OR IGNORE INTO canvas_removed_earlier (canvas_name, target)
  SELECT DISTINCT sent.canvas_name, sent.target
  FROM canvas_copies_sent sent
  WHERE NOT EXISTS (SELECT 1 FROM canvases c WHERE c.canvas_name = sent.canvas_name);
`;

/**
 * Which machine each automation was on from which count to which, as the
 * machine that edits a canvas sent it in its copies: an automation is judged
 * as a seat is (`canvas_placements`), by its Automations node and its id,
 * since one node holds automations on many machines. Added by state
 * migration 55 -> 56.
 */
export const AUTOMATION_PLACEMENTS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS automation_placements (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    automation_id TEXT NOT NULL CHECK (length(automation_id) BETWEEN 1 AND 128),
    from_seq INTEGER NOT NULL CHECK (from_seq BETWEEN 0 AND 9007199254740991),
    until_seq INTEGER CHECK (until_seq IS NULL OR until_seq > from_seq),
    machine TEXT NOT NULL CHECK (length(machine) BETWEEN 1 AND 128),
    PRIMARY KEY (canvas_name, node_id, automation_id, from_seq)
  ) STRICT, WITHOUT ROWID;

  CREATE UNIQUE INDEX IF NOT EXISTS automation_placements_open
    ON automation_placements(canvas_name, node_id, automation_id)
    WHERE until_seq IS NULL;
`;
