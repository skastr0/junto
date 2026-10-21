/**
 * The page comments whose shot the operator purged (plan 06, B7). A purge
 * crosses to every machine linked for the canvas as `shot.purged` and is kept
 * here on each: the comment by canvas, page node and comment id, with no
 * digest. A shot whose comment is listed reads removed, and is never pulled
 * again, whatever row or pull later brings it back. Added by state step 42.
 */
export const SHOT_PURGES_SQL = `
  CREATE TABLE IF NOT EXISTS content_purges (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    record_id TEXT NOT NULL CHECK (length(record_id) BETWEEN 1 AND 256),
    purged_at TEXT NOT NULL CHECK (length(purged_at) BETWEEN 1 AND 64),
    PRIMARY KEY (canvas_name, node_id, record_id)
  ) STRICT, WITHOUT ROWID;
`;
