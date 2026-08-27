import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  migrateStateSchema,
  STATE_SCHEMA_V17_IDENTITY,
  STATE_SCHEMA_V20_IDENTITY,
  STATE_SCHEMA_V21_IDENTITY,
} from "../src/main/vellum/state/migrations";
import {
  STATE_SCHEMA_SQL,
  STATE_SCHEMA_V17_SQL,
  STATE_SCHEMA_V20_SQL,
} from "../src/main/vellum/state/schema";
import {
  expectedStateSchemaIdentity,
  verifyAndStampStateSchema,
} from "../src/main/vellum/state/schema-identity";

describe("pad read cursor migration 17 → 18", () => {
  it("freezes v17 and current identities", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V17_SQL)).toEqual(
      STATE_SCHEMA_V17_IDENTITY,
    );
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V20_SQL)).toEqual(
      STATE_SCHEMA_V20_IDENTITY,
    );
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(
      STATE_SCHEMA_V21_IDENTITY,
    );
    expect(CURRENT_STATE_SCHEMA_VERSION).toBe(21);
  });

  it("adds work_pad_read_cursors without dropping pad posts", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(STATE_SCHEMA_V17_SQL);
      verifyAndStampStateSchema(database, STATE_SCHEMA_V17_SQL);
      database.exec("PRAGMA user_version = 17");

      database.exec(`
        INSERT INTO work_pad_meta(canvas_name, node_id, revision, updated_at)
        VALUES ('factory', 'pad-1', 1, '2026-01-01T00:00:00.000Z');
        INSERT INTO work_pad_pins(
          canvas_name, node_id, element_id, x, y, mentions_json
        ) VALUES ('factory', 'pad-1', 'p1', 1, 1, '[]');
        INSERT INTO work_pad_posts(
          canvas_name, node_id, pin_id, post_id, position,
          author_kind, parts_json
        ) VALUES (
          'factory', 'pad-1', 'p1', 'post-1', 0,
          'operator', '[{"kind":"text","text":"hi"}]'
        );
      `);

      const result = migrateStateSchema(database);
      expect(result.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
      expect(result.previousVersion).toBe(17);
      expect(result.actualSchemaSha256).toBe(
        STATE_SCHEMA_V21_IDENTITY.actualSchemaSha256,
      );

      const table = database
        .prepare(
          `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?`,
        )
        .get("work_pad_read_cursors") as { name: string } | undefined;
      expect(table?.name).toBe("work_pad_read_cursors");

      const kept = database
        .prepare(`SELECT post_id FROM work_pad_posts WHERE post_id = 'post-1'`)
        .get() as { post_id: string };
      expect(kept.post_id).toBe("post-1");
    } finally {
      database.close();
    }
  });
});
