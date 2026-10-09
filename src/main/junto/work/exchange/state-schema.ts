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
