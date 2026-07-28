/**
 * Installation-local licensing state.
 *
 * The full activation record is intentionally main-process-only. This module
 * remains SQL-only so StateEngine can compose it into the installation's one
 * durable schema without importing the licensing repository or network client.
 */
export const LICENSE_STATE_LEGACY_RECORD_VERSION = 1;
export const LICENSE_STATE_RECORD_VERSION = 2;
export const LICENSE_STATE_JSON_MAX_BYTES = 16 * 1_024;

/**
 * Frozen version-one license representation introduced by state schema v2.
 * It is retained as inert migration evidence; current code never reads or
 * writes this table because those rows did not bind the Dodo seller/product.
 */
export const LICENSE_STATE_V1_SCHEMA_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS license_activation (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      record_version INTEGER NOT NULL
        CHECK (record_version = ${LICENSE_STATE_LEGACY_RECORD_VERSION}),
      activated_license_json TEXT NOT NULL
        CHECK (
          length(CAST(activated_license_json AS BLOB)) BETWEEN 2
            AND ${LICENSE_STATE_JSON_MAX_BYTES}
          AND json_valid(activated_license_json)
          AND json_type(activated_license_json) = 'object'
        ),
      updated_at TEXT NOT NULL
        CHECK (length(updated_at) BETWEEN 20 AND 64)
    ) STRICT, WITHOUT ROWID
  `,
] as const;

export const LICENSE_STATE_V1_SCHEMA_SQL =
  `${LICENSE_STATE_V1_SCHEMA_STATEMENTS.join(";\n")};\n`;

/**
 * Seller/product-bound representation introduced by state schema v3. The new
 * durable name is intentional: expand-only migration preserves every v1 byte
 * while making unbound activations impossible to read as current entitlement.
 */
export const LICENSE_STATE_V2_SCHEMA_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS license_entitlement (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      record_version INTEGER NOT NULL
        CHECK (record_version = ${LICENSE_STATE_RECORD_VERSION}),
      activated_license_json TEXT NOT NULL
        CHECK (
          length(CAST(activated_license_json AS BLOB)) BETWEEN 2
            AND ${LICENSE_STATE_JSON_MAX_BYTES}
          AND json_valid(activated_license_json)
          AND json_type(activated_license_json) = 'object'
        ),
      updated_at TEXT NOT NULL
        CHECK (length(updated_at) BETWEEN 20 AND 64)
    ) STRICT, WITHOUT ROWID
  `,
] as const;

export const LICENSE_STATE_V2_SCHEMA_SQL =
  `${LICENSE_STATE_V2_SCHEMA_STATEMENTS.join(";\n")};\n`;

export const LICENSE_STATE_SCHEMA_STATEMENTS = [
  ...LICENSE_STATE_V1_SCHEMA_STATEMENTS,
  ...LICENSE_STATE_V2_SCHEMA_STATEMENTS,
] as const;

export const LICENSE_STATE_SCHEMA_SQL =
  `${LICENSE_STATE_SCHEMA_STATEMENTS.join(";\n")};\n`;
