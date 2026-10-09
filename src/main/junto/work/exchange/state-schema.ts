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
