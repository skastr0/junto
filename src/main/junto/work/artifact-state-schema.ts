/**
 * Artifacts (plan 05): one head row per artifact, one immutable row per
 * version.
 *
 * - `artifact_heads` is what list reads: the head version and its facts,
 *   never a body. Keyed by canvas and artifact id; the Artifacts node is a
 *   column, since an artifact id is a ULID and names one artifact.
 * - `artifact_versions` keeps every version's body and the edit that made
 *   it (none on version 1, the create), so show reads any version in one row
 *   and the ruler reads the edits since a base to rebase a patch.
 * - Rulings live in the shared `resource_rulings` (resource-rulings-schema.ts).
 *
 * Bodies are JSON here. When artifacts replicate (02), a version fact carries
 * a content ref to its body instead.
 */
export const ARTIFACTS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS artifact_heads (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    artifact_id TEXT NOT NULL CHECK (length(artifact_id) = 26),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    type TEXT NOT NULL CHECK (type IN ('link', 'document', 'pad', 'sheet', 'file')),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    version INTEGER NOT NULL CHECK (version >= 1),
    created_by_json TEXT NOT NULL CHECK (json_valid(created_by_json)),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
    task_ids_json TEXT NOT NULL CHECK (json_valid(task_ids_json)),
    PRIMARY KEY (canvas_name, artifact_id)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS artifact_heads_by_node
    ON artifact_heads (canvas_name, node_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS artifact_versions (
    canvas_name TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    op_id TEXT NOT NULL CHECK (length(op_id) = 26),
    author_json TEXT NOT NULL CHECK (json_valid(author_json)),
    at INTEGER NOT NULL CHECK (at >= 0),
    edit_json TEXT CHECK (edit_json IS NULL OR json_valid(edit_json)),
    body_json TEXT NOT NULL CHECK (json_valid(body_json)),
    PRIMARY KEY (canvas_name, artifact_id, version),
    CHECK ((version = 1) = (edit_json IS NULL)),
    FOREIGN KEY (canvas_name, artifact_id)
      REFERENCES artifact_heads (canvas_name, artifact_id)
      ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;
`;
