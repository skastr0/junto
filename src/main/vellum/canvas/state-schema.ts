/**
 * Relational canvas authority schema (schema version 21).
 *
 * Expands record-oriented canvas rows beside frozen whole-document generations:
 * - canvas_documents: opaque CanvasId, canonical CanvasName, head tracking
 * - canvas_objects: stable object identity, deletion tracking, tombstone identity
 * - canvas_nodes: typed relational node records, layout, native JSON Canvas fields, namespaced ether payload
 * - canvas_edges: typed relational edge records, semantic source order, verb, native fields, namespaced ether payload
 * - canvas_checkpoints: content-addressed immutable serialized JSON Canvas bodies
 * - canvas_generation_manifests: compact mapping from portfolio generation to canvas IDs and checkpoint hashes
 * - canvas_commit_envelopes: append-only commit audit envelope keyed to generations
 *
 * Immutability triggers reject direct updates/deletions on checkpoints, envelopes, and manifests.
 */

export const CANVAS_RELATIONAL_AUTHORITY_SCHEMA_SQL = `
  -- Opaque CanvasId mapped to canonical canvas name with active head pointers.
  CREATE TABLE IF NOT EXISTS canvas_documents (
    canvas_id TEXT PRIMARY KEY
      CHECK (length(canvas_id) BETWEEN 1 AND 64),
    canvas_name TEXT NOT NULL UNIQUE
      CHECK (
        length(canvas_name) BETWEEN 1 AND 64
        AND canvas_name GLOB '[a-z0-9]*'
        AND canvas_name NOT GLOB '*[^a-z0-9_-]*'
      ),
    head_generation TEXT NOT NULL
      CHECK (
        length(head_generation) > 0
        AND head_generation NOT GLOB '*[^0-9]*'
        AND (head_generation = '0' OR substr(head_generation, 1, 1) <> '0')
      ),
    head_checkpoint_sha256 TEXT NOT NULL
      CHECK (
        length(head_checkpoint_sha256) = 64
        AND head_checkpoint_sha256 NOT GLOB '*[^a-f0-9]*'
      ),
    head_semantic_sha256 TEXT NOT NULL
      CHECK (
        length(head_semantic_sha256) = 64
        AND head_semantic_sha256 NOT GLOB '*[^a-f0-9]*'
      ),
    created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
    updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS canvas_documents_name
    ON canvas_documents(canvas_name);

  -- Stable object identity per canvas (nodes and edges).
  CREATE TABLE IF NOT EXISTS canvas_objects (
    canvas_id TEXT NOT NULL
      REFERENCES canvas_documents(canvas_id) ON DELETE CASCADE,
    object_id TEXT NOT NULL
      CHECK (length(object_id) BETWEEN 1 AND 256),
    object_kind TEXT NOT NULL
      CHECK (object_kind IN ('node', 'edge')),
    first_seen_generation TEXT NOT NULL
      CHECK (
        length(first_seen_generation) > 0
        AND first_seen_generation NOT GLOB '*[^0-9]*'
      ),
    deleted_generation TEXT
      CHECK (
        deleted_generation IS NULL
        OR (
          length(deleted_generation) > 0
          AND deleted_generation NOT GLOB '*[^0-9]*'
        )
      ),
    created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
    PRIMARY KEY (canvas_id, object_id)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS canvas_objects_kind
    ON canvas_objects(canvas_id, object_kind, deleted_generation);

  -- Typed relational node records.
  CREATE TABLE IF NOT EXISTS canvas_nodes (
    canvas_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    z_index INTEGER NOT NULL CHECK (z_index >= 0),
    type TEXT NOT NULL
      CHECK (type IN ('text', 'file', 'link', 'group')),
    x REAL NOT NULL,
    y REAL NOT NULL,
    width REAL NOT NULL CHECK (width > 0),
    height REAL NOT NULL CHECK (height > 0),
    color TEXT CHECK (color IS NULL OR length(color) BETWEEN 1 AND 64),
    text_content TEXT,
    file_path TEXT,
    file_subpath TEXT,
    link_url TEXT,
    group_label TEXT,
    group_background TEXT,
    group_background_style TEXT
      CHECK (
        group_background_style IS NULL
        OR group_background_style IN ('cover', 'ratio', 'repeat')
      ),
    entity_kind TEXT
      CHECK (entity_kind IS NULL OR length(entity_kind) BETWEEN 1 AND 128),
    entity_name TEXT
      CHECK (entity_name IS NULL OR length(entity_name) BETWEEN 1 AND 256),
    terminal_binding_id TEXT
      CHECK (terminal_binding_id IS NULL OR length(terminal_binding_id) BETWEEN 1 AND 256),
    terminal_harness TEXT
      CHECK (terminal_harness IS NULL OR length(terminal_harness) BETWEEN 1 AND 64),
    host_id TEXT
      CHECK (host_id IS NULL OR length(host_id) BETWEEN 1 AND 64),
    flags_json TEXT
      CHECK (flags_json IS NULL OR json_valid(flags_json)),
    ether_json TEXT
      CHECK (ether_json IS NULL OR json_valid(ether_json)),
    semantic_sha256 TEXT NOT NULL
      CHECK (
        length(semantic_sha256) = 64
        AND semantic_sha256 NOT GLOB '*[^a-f0-9]*'
      ),
    updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
    PRIMARY KEY (canvas_id, node_id),
    FOREIGN KEY (canvas_id, node_id)
      REFERENCES canvas_objects(canvas_id, object_id) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS canvas_nodes_entity
    ON canvas_nodes(canvas_id, entity_kind, entity_name);

  CREATE INDEX IF NOT EXISTS canvas_nodes_terminal
    ON canvas_nodes(canvas_id, terminal_binding_id)
    WHERE terminal_binding_id IS NOT NULL;

  -- Typed relational edge records.
  CREATE TABLE IF NOT EXISTS canvas_edges (
    canvas_id TEXT NOT NULL,
    edge_id TEXT NOT NULL,
    z_index INTEGER NOT NULL CHECK (z_index >= 0),
    from_node_id TEXT NOT NULL,
    from_side TEXT CHECK (from_side IS NULL OR from_side IN ('top', 'right', 'bottom', 'left')),
    from_end TEXT CHECK (from_end IS NULL OR from_end IN ('none', 'arrow')),
    to_node_id TEXT NOT NULL,
    to_side TEXT CHECK (to_side IS NULL OR to_side IN ('top', 'right', 'bottom', 'left')),
    to_end TEXT CHECK (to_end IS NULL OR to_end IN ('none', 'arrow')),
    verb TEXT NOT NULL CHECK (length(verb) BETWEEN 1 AND 64),
    color TEXT CHECK (color IS NULL OR length(color) BETWEEN 1 AND 64),
    label TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 256),
    ether_json TEXT
      CHECK (ether_json IS NULL OR json_valid(ether_json)),
    semantic_sha256 TEXT NOT NULL
      CHECK (
        length(semantic_sha256) = 64
        AND semantic_sha256 NOT GLOB '*[^a-f0-9]*'
      ),
    updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
    PRIMARY KEY (canvas_id, edge_id),
    FOREIGN KEY (canvas_id, edge_id)
      REFERENCES canvas_objects(canvas_id, object_id) ON DELETE CASCADE,
    FOREIGN KEY (canvas_id, from_node_id)
      REFERENCES canvas_nodes(canvas_id, node_id) ON DELETE RESTRICT,
    FOREIGN KEY (canvas_id, to_node_id)
      REFERENCES canvas_nodes(canvas_id, node_id) ON DELETE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS canvas_edges_from
    ON canvas_edges(canvas_id, from_node_id, verb);

  CREATE INDEX IF NOT EXISTS canvas_edges_to
    ON canvas_edges(canvas_id, to_node_id, verb);

  -- Content-addressed immutable JSON Canvas checkpoint bodies.
  CREATE TABLE IF NOT EXISTS canvas_checkpoints (
    sha256 TEXT PRIMARY KEY
      CHECK (
        length(sha256) = 64
        AND sha256 NOT GLOB '*[^a-f0-9]*'
      ),
    byte_length INTEGER NOT NULL
      CHECK (byte_length >= 0),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64)
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS canvas_checkpoints_immutable_update
  BEFORE UPDATE ON canvas_checkpoints
  BEGIN
    SELECT RAISE(ABORT, 'canvas checkpoints are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS canvas_checkpoints_immutable_delete
  BEFORE DELETE ON canvas_checkpoints
  BEGIN
    SELECT RAISE(ABORT, 'canvas checkpoints are immutable');
  END;

  -- Append-only commit envelope table keyed to portfolio generations.
  CREATE TABLE IF NOT EXISTS canvas_commit_envelopes (
    generation TEXT PRIMARY KEY
      REFERENCES canvas_generations(generation) ON DELETE CASCADE,
    parent_generation TEXT
      CHECK (
        parent_generation IS NULL
        OR (
          length(parent_generation) > 0
          AND parent_generation NOT GLOB '*[^0-9]*'
        )
      ),
    cause TEXT NOT NULL CHECK (length(cause) BETWEEN 1 AND 64),
    intent_sha256 TEXT NOT NULL
      CHECK (
        length(intent_sha256) = 64
        AND intent_sha256 NOT GLOB '*[^a-f0-9]*'
      ),
    author_seat_id TEXT
      CHECK (
        author_seat_id IS NULL
        OR (
          length(author_seat_id) = 69
          AND substr(author_seat_id, 1, 5) = 'seat_'
          AND substr(author_seat_id, 6) NOT GLOB '*[^a-f0-9]*'
        )
      ),
    author_principal TEXT
      CHECK (author_principal IS NULL OR length(author_principal) BETWEEN 1 AND 256),
    idempotency_key TEXT
      CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 256),
    change_summary TEXT
      CHECK (change_summary IS NULL OR length(change_summary) BETWEEN 1 AND 512),
    created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64)
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS canvas_commit_envelopes_immutable_update
  BEFORE UPDATE ON canvas_commit_envelopes
  BEGIN
    SELECT RAISE(ABORT, 'canvas commit envelopes are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS canvas_commit_envelopes_immutable_delete
  BEFORE DELETE ON canvas_commit_envelopes
  BEGIN
    SELECT RAISE(ABORT, 'canvas commit envelopes are immutable');
  END;

  -- Compact mapping from portfolio generation to canvas IDs and checkpoint hashes.
  CREATE TABLE IF NOT EXISTS canvas_generation_manifests (
    generation TEXT NOT NULL
      REFERENCES canvas_generations(generation) ON DELETE CASCADE,
    canvas_id TEXT NOT NULL
      REFERENCES canvas_documents(canvas_id) ON DELETE RESTRICT,
    checkpoint_sha256 TEXT NOT NULL
      REFERENCES canvas_checkpoints(sha256) ON DELETE RESTRICT,
    semantic_sha256 TEXT NOT NULL
      CHECK (
        length(semantic_sha256) = 64
        AND semantic_sha256 NOT GLOB '*[^a-f0-9]*'
      ),
    PRIMARY KEY (generation, canvas_id)
  ) STRICT, WITHOUT ROWID;

  CREATE TRIGGER IF NOT EXISTS canvas_generation_manifests_immutable_update
  BEFORE UPDATE ON canvas_generation_manifests
  BEGIN
    SELECT RAISE(ABORT, 'canvas generation manifests are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS canvas_generation_manifests_immutable_delete
  BEFORE DELETE ON canvas_generation_manifests
  BEGIN
    SELECT RAISE(ABORT, 'canvas generation manifests are immutable');
  END;
`;
