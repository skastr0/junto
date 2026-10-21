/**
 * The editing machine's rulings on resource commands (plan 02), for every
 * domain: one row per (canvas, writer installation, opId). A retried command
 * reads its first ruling here and writes nothing; a command whose `after`
 * names a refused one is refused with it. A ruling is written in the same
 * transaction as the facts it records (02, condition 3).
 *
 * `ruling_json` is the domain's record of what the ruling made (applied) or
 * the error it refused with (refused). Shared with remote's R2 path.
 */
export const RESOURCE_RULINGS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS resource_rulings (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    writer TEXT NOT NULL CHECK (length(writer) BETWEEN 1 AND 256),
    op_id TEXT NOT NULL CHECK (length(op_id) = 26),
    kind TEXT NOT NULL CHECK (kind IN ('applied', 'refused')),
    ruling_json TEXT NOT NULL CHECK (json_valid(ruling_json)),
    PRIMARY KEY (canvas_name, writer, op_id)
  ) STRICT, WITHOUT ROWID;
`;
