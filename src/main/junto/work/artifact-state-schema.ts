/**
 * Artifacts (plan 05): one head row per artifact, one immutable row per
 * version.
 *
 * - `artifact_heads` is what list reads: the head version and its facts,
 *   never a body. Keyed by canvas and artifact id; the Artifacts node is a
 *   column, since an artifact id is a ULID and names one artifact.
 * - `artifact_versions` keeps every version's body ref, its body and the
 *   edit that made it (none on version 1, the create), so show reads any
 *   version in one row and the ruler reads the edits since a base to rebase
 *   a patch. `inline_body_json` is the canonical bytes the ref names, or null while
 *   a replica's bytes are pending; the content store holds them too.
 * - Rulings live in the shared `resource_rulings` (resource-rulings-schema.ts).
 *
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
    body_ref_json TEXT NOT NULL CHECK (json_valid(body_ref_json)),
    inline_body_json TEXT CHECK (inline_body_json IS NULL OR json_valid(inline_body_json)),
    PRIMARY KEY (canvas_name, artifact_id, version),
    CHECK ((version = 1) = (edit_json IS NULL)),
    FOREIGN KEY (canvas_name, artifact_id)
      REFERENCES artifact_heads (canvas_name, artifact_id)
      ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;
`;

/**
 * What each artifact's head body links (0.11, 02): one row per (source,
 * target), rebuilt from the head body on every applied edit. The target is a
 * mention key, a node and an item, never a title, so a rename changes no row;
 * the read joins heads for the title and keeps only links whose node is an
 * Artifacts node. Added by state migration 51 -> 52.
 */
export const ARTIFACT_LINKS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS work_artifact_links (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    source_artifact_id TEXT NOT NULL CHECK (length(source_artifact_id) = 26),
    target_node_id TEXT NOT NULL CHECK (length(target_node_id) BETWEEN 1 AND 256),
    target_artifact_id TEXT NOT NULL CHECK (length(target_artifact_id) = 26),
    line TEXT NOT NULL CHECK (length(line) BETWEEN 1 AND 240),
    source_version INTEGER NOT NULL CHECK (source_version >= 1),
    PRIMARY KEY (canvas_name, source_artifact_id, target_node_id, target_artifact_id),
    FOREIGN KEY (canvas_name, source_artifact_id)
      REFERENCES artifact_heads (canvas_name, artifact_id)
      ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS work_artifact_links_target
    ON work_artifact_links (canvas_name, target_node_id, target_artifact_id);
`;
