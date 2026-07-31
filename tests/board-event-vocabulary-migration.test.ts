import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V9_IDENTITY,
  migrateStateSchema,
} from "../src/main/vellum/state/migrations";
import {
  STATE_SCHEMA_SQL,
  STATE_SCHEMA_V9_SQL,
} from "../src/main/vellum/state/schema";
import {
  expectedStateSchemaIdentity,
  verifyAndStampStateSchema,
} from "../src/main/vellum/state/schema-identity";

const openDatabase = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:", {
    open: true,
    readOnly: false,
    allowExtension: false,
    enableForeignKeyConstraints: true,
  });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
};

describe("board event vocabulary migration (9 → 10)", () => {
  it("STATE_SCHEMA_V9_IDENTITY matches composed V9 SQL", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V9_SQL)).toEqual(
      STATE_SCHEMA_V9_IDENTITY,
    );
  });

  it("expands CHECK domain and stamps current identity", () => {
    const database = openDatabase();
    try {
      database.exec(STATE_SCHEMA_V9_SQL);
      verifyAndStampStateSchema(database, STATE_SCHEMA_V9_SQL);
      database.exec("PRAGMA user_version = 9");

      // Prove pre-migration CHECK rejects board ops.
      expect(() => {
        database
          .prepare(
            `
              INSERT INTO work_events(
                event_home, entity_home, seq, protocol, record_type,
                item_kind, item_id, item_canvas_name, item_node_id,
                operation, content_sha256, origin_at, received_at
              ) VALUES (
                'cc', 'cc', '1', 'vellum/work/v2', 'fact',
                'topic', 't1', 'factory', 'board',
                'board.topic.create', ?, '2026-01-01T00:00:00.000Z',
                '2026-01-01T00:00:00.000Z'
              )
            `,
          )
          .run("a".repeat(64));
      }).toThrow(/CHECK|constraint/i);

      // Full plan; database is already stamped at V9 so only 9→10 runs.
      migrateStateSchema(database);

      expect(
        (
          database.prepare("PRAGMA user_version").get() as {
            readonly user_version: number;
          }
        ).user_version,
      ).toBe(10);

      // After expand, board vocabulary inserts are accepted at the CHECK layer.
      // Full FK chain is not required for this unit — only the CHECK domain.
      const sql = database
        .prepare(
          `
            SELECT sql FROM sqlite_schema
            WHERE type = 'table' AND name = 'work_events'
          `,
        )
        .get() as { readonly sql: string };
      expect(sql.sql).toContain("board.topic.create");
      expect(sql.sql).toContain("'topic'");
      expect(sql.sql).toContain("'post'");

      const pendingSql = database
        .prepare(
          `
            SELECT sql FROM sqlite_schema
            WHERE type = 'table' AND name = 'work_pending_commands'
          `,
        )
        .get() as { readonly sql: string };
      expect(pendingSql.sql).toContain("board.post.append");
    } finally {
      database.close();
    }
  });
});
