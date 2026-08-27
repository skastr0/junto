/**
 * Schema version 22: Command Center authoring change tail and envelope
 * provenance columns beside frozen schema-21 relational tables.
 */
export const CANVAS_AUTHORING_TAIL_SCHEMA_SQL = `
  ALTER TABLE canvas_commit_envelopes
    ADD COLUMN origin TEXT
      CHECK (origin IS NULL OR length(origin) BETWEEN 1 AND 64);

  ALTER TABLE canvas_commit_envelopes
    ADD COLUMN admitted_base_generation TEXT
      CHECK (
        admitted_base_generation IS NULL
        OR (
          length(admitted_base_generation) > 0
          AND admitted_base_generation NOT GLOB '*[^0-9]*'
        )
      );

  ALTER TABLE canvas_commit_envelopes
    ADD COLUMN admitted_base_body_hash TEXT
      CHECK (
        admitted_base_body_hash IS NULL
        OR (
          length(admitted_base_body_hash) = 64
          AND admitted_base_body_hash NOT GLOB '*[^a-f0-9]*'
        )
      );

  ALTER TABLE canvas_commit_envelopes
    ADD COLUMN codec_family TEXT
      CHECK (codec_family IS NULL OR length(codec_family) BETWEEN 1 AND 64);

  ALTER TABLE canvas_commit_envelopes
    ADD COLUMN codec_version INTEGER
      CHECK (codec_version IS NULL OR codec_version >= 1);

  ALTER TABLE canvas_commit_envelopes
    ADD COLUMN payload_hash TEXT
      CHECK (
        payload_hash IS NULL
        OR (
          length(payload_hash) = 64
          AND payload_hash NOT GLOB '*[^a-f0-9]*'
        )
      );

  ALTER TABLE canvas_commit_envelopes
    ADD COLUMN changed_object_hashes_json TEXT
      CHECK (
        changed_object_hashes_json IS NULL
        OR json_valid(changed_object_hashes_json)
      );

  ALTER TABLE canvas_commit_envelopes
    ADD COLUMN change_id TEXT
      CHECK (change_id IS NULL OR length(change_id) BETWEEN 1 AND 256);

  CREATE TABLE IF NOT EXISTS canvas_change_tail (
    change_id TEXT PRIMARY KEY
      CHECK (length(change_id) BETWEEN 1 AND 256),
    parent_change_id TEXT
      CHECK (
        parent_change_id IS NULL
        OR length(parent_change_id) BETWEEN 1 AND 256
      ),
    canvas_id TEXT NOT NULL
      REFERENCES canvas_documents(canvas_id) ON DELETE RESTRICT,
    generation TEXT NOT NULL
      REFERENCES canvas_generations(generation) ON DELETE CASCADE,
    operation_kind TEXT NOT NULL
      CHECK (operation_kind = 'document.replace/v1'),
    codec_family TEXT NOT NULL
      CHECK (codec_family = 'vellum-command-authoring'),
    codec_version INTEGER NOT NULL
      CHECK (codec_version = 1),
    payload_hash TEXT NOT NULL
      CHECK (
        length(payload_hash) = 64
        AND payload_hash NOT GLOB '*[^a-f0-9]*'
      ),
    body_hash TEXT NOT NULL
      CHECK (
        length(body_hash) = 64
        AND body_hash NOT GLOB '*[^a-f0-9]*'
      ),
    admitted_base_generation TEXT
      CHECK (
        admitted_base_generation IS NULL
        OR (
          length(admitted_base_generation) > 0
          AND admitted_base_generation NOT GLOB '*[^0-9]*'
        )
      ),
    admitted_base_body_hash TEXT
      CHECK (
        admitted_base_body_hash IS NULL
        OR (
          length(admitted_base_body_hash) = 64
          AND admitted_base_body_hash NOT GLOB '*[^a-f0-9]*'
        )
      ),
    changed_object_hashes_json TEXT
      CHECK (
        changed_object_hashes_json IS NULL
        OR json_valid(changed_object_hashes_json)
      ),
    origin TEXT NOT NULL
      CHECK (origin = 'command-center'),
    created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS canvas_change_tail_generation
    ON canvas_change_tail(generation, canvas_id);

  CREATE TRIGGER IF NOT EXISTS canvas_change_tail_immutable_update
  BEFORE UPDATE ON canvas_change_tail
  BEGIN
    SELECT RAISE(ABORT, 'canvas change tail is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS canvas_change_tail_immutable_delete
  BEFORE DELETE ON canvas_change_tail
  BEGIN
    SELECT RAISE(ABORT, 'canvas change tail is immutable');
  END;

  CREATE TABLE IF NOT EXISTS canvas_authoring_tail_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    tail_floor_generation TEXT NOT NULL
      CHECK (
        length(tail_floor_generation) > 0
        AND tail_floor_generation NOT GLOB '*[^0-9]*'
      ),
    tail_floor_change_id TEXT
      CHECK (
        tail_floor_change_id IS NULL
        OR length(tail_floor_change_id) BETWEEN 1 AND 256
      ),
    retained_checkpoint_sha256 TEXT
      CHECK (
        retained_checkpoint_sha256 IS NULL
        OR (
          length(retained_checkpoint_sha256) = 64
          AND retained_checkpoint_sha256 NOT GLOB '*[^a-f0-9]*'
        )
      )
  ) STRICT;
`;
