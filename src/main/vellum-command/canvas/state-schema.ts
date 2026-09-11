/**
 * Relational canvas authority schema (schema version 21).
 *
 * SQLite owns the canvas. The portfolio is one head row plus typed relational
 * node and edge records; the serialized JSON Canvas body is a derived export
 * codec, never durability.
 *
 * - canvas_portfolio_head: singleton commit counter + portfolio intent hash
 * - canvas_documents: opaque CanvasId, canonical CanvasName, revision hash
 * - canvas_nodes: typed node records, layout, native JSON Canvas fields,
 *   namespaced ether payload; z_index is the document (z-)order
 * - canvas_edges: typed edge records in semantic source order, native fields,
 *   namespaced ether payload (the verb lives inside ether)
 *
 * Deliberately absent: whole-document bodies, checkpoints, generation history,
 * commit envelopes, manifests, object tombstones, per-row semantic hashes, and
 * derived mirror columns. ether_json is the single stored truth for extension
 * data; canvas_entities (a separate registry) serves entity queries.
 */

export const CANVAS_AUTHORITY_SCHEMA_SQL = `
  -- Singleton portfolio head: monotonic commit counter + intent identity.
  CREATE TABLE IF NOT EXISTS canvas_portfolio_head (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    generation TEXT NOT NULL
      CHECK (
        length(generation) > 0
        AND generation NOT GLOB '*[^0-9]*'
        AND (generation = '0' OR substr(generation, 1, 1) <> '0')
      ),
    intent_sha256 TEXT NOT NULL
      CHECK (
        length(intent_sha256) = 64
        AND intent_sha256 NOT GLOB '*[^a-f0-9]*'
      ),
    created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
    updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64)
  ) STRICT;

  -- Opaque CanvasId mapped to canonical canvas name with its revision hash.
  CREATE TABLE IF NOT EXISTS canvas_documents (
    canvas_id TEXT PRIMARY KEY
      CHECK (length(canvas_id) BETWEEN 1 AND 64),
    canvas_name TEXT NOT NULL UNIQUE
      CHECK (
        length(canvas_name) BETWEEN 1 AND 64
        AND canvas_name GLOB '[a-z0-9]*'
        AND canvas_name NOT GLOB '*[^a-z0-9_-]*'
      ),
    revision_sha256 TEXT NOT NULL
      CHECK (
        length(revision_sha256) = 64
        AND revision_sha256 NOT GLOB '*[^a-f0-9]*'
      ),
    created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
    modified_at TEXT NOT NULL CHECK (length(modified_at) BETWEEN 1 AND 64)
  ) STRICT;

  -- Typed relational node records. z_index is the JSON Canvas array order.
  CREATE TABLE IF NOT EXISTS canvas_nodes (
    canvas_id TEXT NOT NULL
      REFERENCES canvas_documents(canvas_id),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
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
    ether_json TEXT
      CHECK (ether_json IS NULL OR json_valid(ether_json)),
    updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
    PRIMARY KEY (canvas_id, node_id)
  ) STRICT, WITHOUT ROWID;

  -- Typed relational edge records; ether_json carries the verb.
  CREATE TABLE IF NOT EXISTS canvas_edges (
    canvas_id TEXT NOT NULL
      REFERENCES canvas_documents(canvas_id),
    edge_id TEXT NOT NULL CHECK (length(edge_id) BETWEEN 1 AND 256),
    z_index INTEGER NOT NULL CHECK (z_index >= 0),
    from_node_id TEXT NOT NULL,
    from_side TEXT CHECK (from_side IS NULL OR from_side IN ('top', 'right', 'bottom', 'left')),
    from_end TEXT CHECK (from_end IS NULL OR from_end IN ('none', 'arrow')),
    to_node_id TEXT NOT NULL,
    to_side TEXT CHECK (to_side IS NULL OR to_side IN ('top', 'right', 'bottom', 'left')),
    to_end TEXT CHECK (to_end IS NULL OR to_end IN ('none', 'arrow')),
    color TEXT CHECK (color IS NULL OR length(color) BETWEEN 1 AND 64),
    label TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 256),
    ether_json TEXT
      CHECK (ether_json IS NULL OR json_valid(ether_json)),
    updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
    PRIMARY KEY (canvas_id, edge_id),
    FOREIGN KEY (canvas_id, from_node_id)
      REFERENCES canvas_nodes(canvas_id, node_id),
    FOREIGN KEY (canvas_id, to_node_id)
      REFERENCES canvas_nodes(canvas_id, node_id)
  ) STRICT, WITHOUT ROWID;
`;
