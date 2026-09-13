/**
 * Provider credential bindings — lifecycle records only.
 *
 * Secret values never live in SQLite. This table records which OS-vault
 * generation currently represents an operator override so settings JSON can
 * stay non-secret and product backups can omit credential material.
 */

export const PROVIDER_CREDENTIAL_SLOT_VALUES = [
  "openrouter/apiKey",
  "openrouter/managementApiKey",
  "synthetic/apiKey",
  "kimi/authToken",
  "kimi/apiKey",
  "devin/bearerToken",
  "opencodeGo/apiKey",
  "copilot/token",
  "ollama/sessionCookie",
  "ollama/apiKey",
  "cursor/cookieHeader",
] as const;

const SLOT_SQL_LIST = PROVIDER_CREDENTIAL_SLOT_VALUES.map(
  (slot) => `'${slot}'`,
).join(", ");

export const PROVIDER_CREDENTIAL_BINDINGS_SQL = `
  CREATE TABLE IF NOT EXISTS provider_credential_bindings (
    credential_id TEXT PRIMARY KEY
      CHECK (
        length(credential_id) = 36
        AND credential_id GLOB '*-*-*-*-*'
      ),
    slot TEXT NOT NULL
      CHECK (slot IN (${SLOT_SQL_LIST})),
    lifecycle TEXT NOT NULL
      CHECK (lifecycle IN ('staged', 'active', 'delete_pending')),
    created_at TEXT NOT NULL
      CHECK (length(created_at) > 0)
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS provider_credential_bindings_one_active_slot
    ON provider_credential_bindings(slot)
    WHERE lifecycle = 'active';
`;

/** Added in schema 23; the released provider slot constraint stays frozen. */
export const OPENAI_CREDENTIAL_SLOT_VALUES = ["openai/apiKey"] as const;

export const OPENAI_CREDENTIAL_BINDINGS_SQL = `
  CREATE TABLE IF NOT EXISTS openai_credential_bindings (
    credential_id TEXT PRIMARY KEY
      CHECK (
        length(credential_id) = 36
        AND credential_id GLOB '*-*-*-*-*'
      ),
    slot TEXT NOT NULL CHECK (slot IN ('openai/apiKey')),
    lifecycle TEXT NOT NULL
      CHECK (lifecycle IN ('staged', 'active', 'delete_pending')),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0)
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS openai_credential_bindings_one_active_slot
    ON openai_credential_bindings(slot)
    WHERE lifecycle = 'active';
`;
