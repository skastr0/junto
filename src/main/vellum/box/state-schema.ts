export const BOX_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS box_resources (
    box_id TEXT PRIMARY KEY
      CHECK (
        length(box_id) = 11
        AND box_id GLOB 'bx_[23456789abcdefghjkmnpqrstuvwxyz][23456789abcdefghjkmnpqrstuvwxyz][23456789abcdefghjkmnpqrstuvwxyz][23456789abcdefghjkmnpqrstuvwxyz][23456789abcdefghjkmnpqrstuvwxyz][23456789abcdefghjkmnpqrstuvwxyz][23456789abcdefghjkmnpqrstuvwxyz][23456789abcdefghjkmnpqrstuvwxyz]'
      ),
    host_id TEXT NOT NULL UNIQUE
      REFERENCES host_registry(id) ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
    machine_ip TEXT,
    machine_state TEXT NOT NULL CHECK (length(machine_state) BETWEEN 1 AND 32),
    provider_created_at TEXT NOT NULL CHECK (length(provider_created_at) > 0),
    provider_updated_at TEXT NOT NULL CHECK (length(provider_updated_at) > 0),
    enrolled_at TEXT NOT NULL CHECK (length(enrolled_at) > 0)
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS box_resources_immutable_identity
  BEFORE UPDATE OF box_id, host_id ON box_resources
  BEGIN
    SELECT RAISE(ABORT, 'Box ownership identity is immutable');
  END;
`;

