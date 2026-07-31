/**
 * Local content-object manifest (expand-only, schema v12).
 *
 * Bytes live under `~/.vellum/content/v1/sha256/<2hex>/<digest>`. SQLite holds
 * only identity, references, verification receipts, and transfer bookkeeping.
 * A reference row is inserted only after the object file is durable and the
 * object row exists — crash before commit may leave an orphan file, never a
 * dangling reference.
 */

export const CONTENT_STATE_SCHEMA_SQL = `
  -- Immutable verified object identity. Media type / display name live on
  -- content_refs (descriptive metadata is not part of byte identity).
  CREATE TABLE IF NOT EXISTS content_objects (
    sha256 TEXT PRIMARY KEY
      CHECK (
        length(sha256) = 64
        AND sha256 NOT GLOB '*[^a-f0-9]*'
      ),
    byte_length INTEGER NOT NULL
      CHECK (
        typeof(byte_length) = 'integer'
        AND byte_length >= 0
      ),
    created_at TEXT NOT NULL
      CHECK (length(created_at) BETWEEN 1 AND 64),
    verified_at TEXT NOT NULL
      CHECK (length(verified_at) BETWEEN 1 AND 64)
  ) STRICT, WITHOUT ROWID;

  -- Portable references bound to durable work after the object exists.
  CREATE TABLE IF NOT EXISTS content_refs (
    ref_id TEXT PRIMARY KEY
      CHECK (length(ref_id) BETWEEN 1 AND 256),
    sha256 TEXT NOT NULL
      CHECK (
        length(sha256) = 64
        AND sha256 NOT GLOB '*[^a-f0-9]*'
      ),
    byte_length INTEGER NOT NULL
      CHECK (
        typeof(byte_length) = 'integer'
        AND byte_length >= 0
      ),
    media_type TEXT NOT NULL
      CHECK (length(media_type) BETWEEN 1 AND 255),
    display_name TEXT
      CHECK (
        display_name IS NULL
        OR length(display_name) BETWEEN 1 AND 255
      ),
    owner_kind TEXT NOT NULL
      CHECK (
        owner_kind IN (
          'task',
          'message',
          'artifact',
          'board_topic',
          'board_post',
          'other'
        )
      ),
    owner_canvas TEXT NOT NULL
      CHECK (length(owner_canvas) BETWEEN 1 AND 256),
    owner_node TEXT NOT NULL
      CHECK (length(owner_node) BETWEEN 1 AND 256),
    owner_record_id TEXT NOT NULL
      CHECK (length(owner_record_id) BETWEEN 1 AND 256),
    created_at TEXT NOT NULL
      CHECK (length(created_at) BETWEEN 1 AND 64),
    FOREIGN KEY (sha256)
      REFERENCES content_objects(sha256)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS content_refs_by_object
    ON content_refs(sha256, created_at, ref_id);

  CREATE INDEX IF NOT EXISTS content_refs_by_owner
    ON content_refs(owner_canvas, owner_node, owner_kind, owner_record_id);

  -- Verification receipts. Only the verified state is durable here; missing /
  -- corrupt / unavailable are computed at read time from object + file state.
  CREATE TABLE IF NOT EXISTS content_receipts (
    sha256 TEXT PRIMARY KEY
      CHECK (
        length(sha256) = 64
        AND sha256 NOT GLOB '*[^a-f0-9]*'
      ),
    verified_sha256 TEXT NOT NULL
      CHECK (
        length(verified_sha256) = 64
        AND verified_sha256 NOT GLOB '*[^a-f0-9]*'
        AND verified_sha256 = sha256
      ),
    verified_byte_length INTEGER NOT NULL
      CHECK (
        typeof(verified_byte_length) = 'integer'
        AND verified_byte_length >= 0
      ),
    verified_at TEXT NOT NULL
      CHECK (length(verified_at) BETWEEN 1 AND 64),
    FOREIGN KEY (sha256)
      REFERENCES content_objects(sha256)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;

  -- Transfer bookkeeping for a future cross-Station data plane. Local ingest
  -- does not require rows; schema exists so the next migration is not blocked.
  CREATE TABLE IF NOT EXISTS content_transfers (
    transfer_id TEXT PRIMARY KEY
      CHECK (length(transfer_id) BETWEEN 1 AND 256),
    sha256 TEXT NOT NULL
      CHECK (
        length(sha256) = 64
        AND sha256 NOT GLOB '*[^a-f0-9]*'
      ),
    byte_length INTEGER NOT NULL
      CHECK (
        typeof(byte_length) = 'integer'
        AND byte_length >= 0
      ),
    state TEXT NOT NULL
      CHECK (
        state IN (
          'pending',
          'receiving',
          'verifying',
          'complete',
          'failed',
          'canceled'
        )
      ),
    direction TEXT NOT NULL
      CHECK (direction IN ('inbound', 'outbound')),
    peer_installation_id TEXT
      CHECK (
        peer_installation_id IS NULL
        OR length(peer_installation_id) BETWEEN 1 AND 128
      ),
    error_reason TEXT
      CHECK (
        error_reason IS NULL
        OR length(error_reason) BETWEEN 1 AND 1024
      ),
    created_at TEXT NOT NULL
      CHECK (length(created_at) BETWEEN 1 AND 64),
    updated_at TEXT NOT NULL
      CHECK (length(updated_at) BETWEEN 1 AND 64)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS content_transfers_by_object
    ON content_transfers(sha256, state, updated_at);
`;
