import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  migrateStateSchema,
  STATE_SCHEMA_V14_IDENTITY,
  STATE_SCHEMA_V15_IDENTITY,
} from "../src/main/vellum/state/migrations";
import {
  STATE_SCHEMA_SQL,
  STATE_SCHEMA_V14_SQL,
} from "../src/main/vellum/state/schema";
import {
  expectedStateSchemaIdentity,
  verifyAndStampStateSchema,
} from "../src/main/vellum/state/schema-identity";

describe("task archived schema migration 14 → 15", () => {
  it("freezes v14 and current identities", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V14_SQL)).toEqual(
      STATE_SCHEMA_V14_IDENTITY,
    );
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(
      STATE_SCHEMA_V15_IDENTITY,
    );
    expect(CURRENT_STATE_SCHEMA_VERSION).toBe(15);
  });

  it("migrates work_tasks rows and accepts archived state", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(STATE_SCHEMA_V14_SQL);
      verifyAndStampStateSchema(database, STATE_SCHEMA_V14_SQL);
      database.exec("PRAGMA user_version = 14");

      // Minimal installation so FK-backed task rows can land if needed.
      // Migration only copy-forwards existing rows; empty shelf is valid.
      const result = migrateStateSchema(database);
      expect(result.schemaVersion).toBe(15);
      expect(result.previousVersion).toBe(14);
      expect(result.actualSchemaSha256).toBe(
        STATE_SCHEMA_V15_IDENTITY.actualSchemaSha256,
      );

      // Live DDL must accept archived (CHECK expanded).
      const sql = database
        .prepare(
          `SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'work_tasks'`,
        )
        .get() as { sql: string };
      expect(sql.sql).toContain("'archived'");

      const transitionSql = database
        .prepare(
          `SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'work_task_transitions'`,
        )
        .get() as { sql: string };
      expect(transitionSql.sql).toContain("'archived'");
    } finally {
      database.close();
    }
  });
});
