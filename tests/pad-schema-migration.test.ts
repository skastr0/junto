import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  migrateStateSchema,
  STATE_SCHEMA_V16_IDENTITY,
  STATE_SCHEMA_V17_IDENTITY,
  STATE_SCHEMA_V20_IDENTITY,
  CURRENT_STATE_SCHEMA_IDENTITY,
} from "../src/main/junto/state/migrations";
import {
  STATE_SCHEMA_SQL,
  STATE_SCHEMA_V16_SQL,
  STATE_SCHEMA_V17_SQL,
  STATE_SCHEMA_V20_SQL,
} from "../src/main/junto/state/schema";
import {
  expectedStateSchemaIdentity,
  verifyAndStampStateSchema,
} from "../src/main/junto/state/schema-identity";

describe("pad schema migration 16 → 17", () => {
  it("freezes v16, v17, and current identities", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V16_SQL)).toEqual(
      STATE_SCHEMA_V16_IDENTITY,
    );
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V17_SQL)).toEqual(
      STATE_SCHEMA_V17_IDENTITY,
    );
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V20_SQL)).toEqual(
      STATE_SCHEMA_V20_IDENTITY,
    );
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(
      CURRENT_STATE_SCHEMA_IDENTITY,
    );
  });

  it("adds pad tables and pad.patch vocab without dropping work events", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(STATE_SCHEMA_V16_SQL);
      verifyAndStampStateSchema(database, STATE_SCHEMA_V16_SQL);
      database.exec("PRAGMA user_version = 16");

      database.exec(`
        INSERT INTO station_known_installations(installation_id, registered_at)
        VALUES ('cc-pad', '2026-01-01T00:00:00.000Z');
        INSERT INTO work_event_sequences(event_home, entity_home, last_seq)
        VALUES ('cc-pad', 'cc-pad', '1');
        INSERT INTO work_events(
          event_home, entity_home, seq, protocol, record_type,
          item_kind, item_id, item_canvas_name, item_node_id,
          operation, content_sha256, origin_at, received_at
        ) VALUES (
          'cc-pad', 'cc-pad', '1', 'vellum/work/v2', 'fact',
          'topic', 't1', 'factory', 'board-1',
          'board.topic.create', '${"a".repeat(64)}',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );
      `);

      const result = migrateStateSchema(database);
      expect(result.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
      expect(result.previousVersion).toBe(16);
      expect(result.actualSchemaSha256).toBe(
        CURRENT_STATE_SCHEMA_IDENTITY.actualSchemaSha256,
      );

      for (const table of [
        "work_pad_meta",
        "work_pad_images",
        "work_pad_shapes",
        "work_pad_edges",
        "work_pad_inks",
        "work_pad_pins",
        "work_pad_posts",
        "work_pad_read_cursors",
      ]) {
        const row = database
          .prepare(
            `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?`,
          )
          .get(table) as { name: string } | undefined;
        expect(row?.name).toBe(table);
      }

      const kept = database
        .prepare(`SELECT item_id FROM work_events WHERE seq = '1'`)
        .get() as { item_id: string };
      expect(kept.item_id).toBe("t1");

      const eventsSql = database
        .prepare(
          `SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'work_events'`,
        )
        .get() as { sql: string };
      expect(eventsSql.sql).toContain("pad.patch");
      expect(eventsSql.sql).toContain("'pad'");
    } finally {
      database.close();
    }
  });
});
