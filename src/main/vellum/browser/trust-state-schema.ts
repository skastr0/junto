/**
 * Browser delegation trust is an immutable ledger in the app-owned database.
 *
 * Origin rows retain private Ed25519 custody only on their Command Center.
 * Pinned rows contain public material only and are safe to project through the
 * configure seam. Both ledgers are append-only so generation identity can
 * never be rewritten after it has authorized a request.
 */
export const BROWSER_TRUST_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS browser_origin_keys (
    generation INTEGER PRIMARY KEY
      CHECK (generation BETWEEN 1 AND 1000000000),
    key_id TEXT NOT NULL UNIQUE
      CHECK (
        length(key_id) BETWEEN 1 AND 64
        AND substr(key_id, 1, 1) GLOB '[A-Za-z0-9]'
        AND key_id NOT GLOB '*[^A-Za-z0-9._-]*'
      ),
    origin_installation_id TEXT NOT NULL
      CHECK (
        length(origin_installation_id) BETWEEN 1 AND 128
        AND substr(origin_installation_id, 1, 1) GLOB '[A-Za-z0-9]'
        AND origin_installation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
      ),
    created_at INTEGER NOT NULL
      CHECK (created_at BETWEEN 0 AND 9007199254740991),
    private_key_pkcs8 BLOB NOT NULL
      CHECK (
        typeof(private_key_pkcs8) = 'blob'
        AND length(private_key_pkcs8) BETWEEN 16 AND 1024
      ),
    public_key_spki BLOB NOT NULL
      CHECK (
        typeof(public_key_spki) = 'blob'
        AND length(public_key_spki) BETWEEN 16 AND 1024
      )
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS browser_origin_keys_append_only_update
  BEFORE UPDATE ON browser_origin_keys
  BEGIN
    SELECT RAISE(ABORT, 'browser origin key generations are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS browser_origin_keys_append_only_delete
  BEFORE DELETE ON browser_origin_keys
  BEGIN
    SELECT RAISE(ABORT, 'browser origin key generations are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS browser_origin_keys_contiguous
  BEFORE INSERT ON browser_origin_keys
  WHEN NEW.generation <> (
    SELECT coalesce(max(generation), 0) + 1 FROM browser_origin_keys
  )
  BEGIN
    SELECT RAISE(ABORT, 'browser origin key generation is not contiguous');
  END;

  CREATE TRIGGER IF NOT EXISTS browser_origin_keys_stable_origin
  BEFORE INSERT ON browser_origin_keys
  WHEN EXISTS (
    SELECT 1
      FROM browser_origin_keys
     WHERE origin_installation_id <> NEW.origin_installation_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'browser origin key is pinned to another installation');
  END;

  CREATE TABLE IF NOT EXISTS browser_pinned_origin_trust (
    generation INTEGER PRIMARY KEY
      CHECK (generation BETWEEN 1 AND 1000000000),
    key_id TEXT NOT NULL
      CHECK (
        length(key_id) BETWEEN 1 AND 64
        AND substr(key_id, 1, 1) GLOB '[A-Za-z0-9]'
        AND key_id NOT GLOB '*[^A-Za-z0-9._-]*'
      ),
    origin_installation_id TEXT NOT NULL
      CHECK (
        length(origin_installation_id) BETWEEN 1 AND 128
        AND substr(origin_installation_id, 1, 1) GLOB '[A-Za-z0-9]'
        AND origin_installation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
      ),
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    public_key_spki BLOB,
    replaces_key_id TEXT,
    updated_at INTEGER NOT NULL
      CHECK (updated_at BETWEEN 0 AND 9007199254740991),
    CHECK (
      (
        status = 'active'
        AND typeof(public_key_spki) = 'blob'
        AND length(public_key_spki) BETWEEN 16 AND 1024
      )
      OR (
        status = 'revoked'
        AND public_key_spki IS NULL
      )
    ),
    CHECK (
      replaces_key_id IS NULL
      OR (
        length(replaces_key_id) BETWEEN 1 AND 64
        AND substr(replaces_key_id, 1, 1) GLOB '[A-Za-z0-9]'
        AND replaces_key_id NOT GLOB '*[^A-Za-z0-9._-]*'
      )
    )
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS browser_pinned_origin_trust_append_only_update
  BEFORE UPDATE ON browser_pinned_origin_trust
  BEGIN
    SELECT RAISE(ABORT, 'browser pinned trust generations are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS browser_pinned_origin_trust_append_only_delete
  BEFORE DELETE ON browser_pinned_origin_trust
  BEGIN
    SELECT RAISE(ABORT, 'browser pinned trust generations are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS browser_pinned_origin_trust_monotonic
  BEFORE INSERT ON browser_pinned_origin_trust
  WHEN EXISTS (
    SELECT 1
      FROM browser_pinned_origin_trust
     WHERE generation >= NEW.generation
  )
  BEGIN
    SELECT RAISE(ABORT, 'browser pinned trust generation is not newer');
  END;

  CREATE TRIGGER IF NOT EXISTS browser_pinned_origin_trust_stable_origin
  BEFORE INSERT ON browser_pinned_origin_trust
  WHEN EXISTS (
    SELECT 1
      FROM browser_pinned_origin_trust
     WHERE origin_installation_id <> NEW.origin_installation_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'browser pinned trust origin installation changed');
  END;

  CREATE TRIGGER IF NOT EXISTS browser_pinned_origin_trust_irreversible_revoke
  BEFORE INSERT ON browser_pinned_origin_trust
  WHEN EXISTS (
    SELECT 1
      FROM browser_pinned_origin_trust
     WHERE status = 'revoked'
  )
  BEGIN
    SELECT RAISE(ABORT, 'browser pinned trust revocation is irreversible');
  END;

  CREATE TRIGGER IF NOT EXISTS browser_pinned_origin_trust_continuity
  BEFORE INSERT ON browser_pinned_origin_trust
  WHEN EXISTS (SELECT 1 FROM browser_pinned_origin_trust)
   AND NOT (
     (
       NEW.status = 'active'
       AND NEW.key_id <> (
         SELECT key_id
           FROM browser_pinned_origin_trust
          ORDER BY generation DESC
          LIMIT 1
       )
       AND NEW.replaces_key_id = (
         SELECT key_id
           FROM browser_pinned_origin_trust
          ORDER BY generation DESC
          LIMIT 1
       )
     )
     OR
     (
       NEW.status = 'revoked'
       AND NEW.key_id = (
         SELECT key_id
           FROM browser_pinned_origin_trust
          ORDER BY generation DESC
          LIMIT 1
       )
       AND NEW.replaces_key_id = NEW.key_id
     )
   )
  BEGIN
    SELECT RAISE(ABORT, 'browser pinned trust replacement is discontinuous');
  END;
`;
