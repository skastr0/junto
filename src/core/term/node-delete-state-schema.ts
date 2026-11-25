import { DELETE_BINDING_UNPROVEN_REASONS } from "@shared/terminal-delete";

const reasons = DELETE_BINDING_UNPROVEN_REASONS.map((reason) => `'${reason}'`).join(", ");

/**
 * Durable node-delete facts. The held row is written on the seat's machine
 * before its create lock, stop and answer; the owed row is written on the
 * editing machine before a confirmed-unproven delete can commit. Neither
 * table carries a secret, credential, cwd or shell path.
 */
export const TERMINAL_DELETE_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS terminal_delete_held (
    binding_id TEXT NOT NULL CHECK (length(CAST(binding_id AS BLOB)) BETWEEN 1 AND 512),
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    seat_id TEXT NOT NULL CHECK (length(seat_id) BETWEEN 1 AND 256),
    editor_installation_id TEXT NOT NULL CHECK (length(editor_installation_id) BETWEEN 1 AND 256),
    editor_canvas_seq INTEGER NOT NULL CHECK (editor_canvas_seq >= 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (binding_id)
  ) STRICT, WITHOUT ROWID;

  -- Nothing reads these rows yet: they are the durable record a next-seen
  -- finish will use, and machine.remove sweeps them at retire. Any first
  -- reader keys by installation id or proves it runs after that sweep.
  CREATE TABLE IF NOT EXISTS terminal_delete_owed (
    lease_id TEXT NOT NULL CHECK (length(lease_id) BETWEEN 1 AND 128),
    binding_id TEXT NOT NULL CHECK (length(CAST(binding_id AS BLOB)) BETWEEN 1 AND 512),
    machine_name TEXT NOT NULL CHECK (length(machine_name) BETWEEN 1 AND 256),
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    seat_id TEXT NOT NULL CHECK (length(seat_id) BETWEEN 1 AND 256),
    reason TEXT NOT NULL CHECK (reason IN (${reasons})),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (lease_id, binding_id, machine_name)
  ) STRICT, WITHOUT ROWID;
`;
