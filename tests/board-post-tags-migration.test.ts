import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  migrateStateSchema,
  STATE_SCHEMA_V15_IDENTITY,
  STATE_SCHEMA_V16_IDENTITY,
  STATE_SCHEMA_V17_IDENTITY,
} from "../src/main/vellum/state/migrations";
import {
  STATE_SCHEMA_SQL,
  STATE_SCHEMA_V15_SQL,
  STATE_SCHEMA_V16_SQL,
} from "../src/main/vellum/state/schema";
import {
  expectedStateSchemaIdentity,
  verifyAndStampStateSchema,
} from "../src/main/vellum/state/schema-identity";

describe("board post tags schema migration 15 → 16", () => {
  it("freezes v15 and current identities", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V15_SQL)).toEqual(
      STATE_SCHEMA_V15_IDENTITY,
    );
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V16_SQL)).toEqual(
      STATE_SCHEMA_V16_IDENTITY,
    );
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(
      STATE_SCHEMA_V17_IDENTITY,
    );
    expect(CURRENT_STATE_SCHEMA_VERSION).toBe(17);
  });

  it("adds tags_json without dropping historical posts", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(STATE_SCHEMA_V15_SQL);
      verifyAndStampStateSchema(database, STATE_SCHEMA_V15_SQL);
      database.exec("PRAGMA user_version = 15");

      // Minimal board shelf so ADD COLUMN can land.
      database.exec(`
        INSERT INTO work_board_topics(
          canvas_name, node_id, topic_id, title, state,
          author_kind, parts_json, post_count, last_activity_at, created_at, updated_at
        ) VALUES (
          'c', 'board-1', 't1', 'hello', 'open',
          'operator', '[]', 1, '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );
        INSERT INTO work_board_posts(
          canvas_name, node_id, topic_id, post_id, position,
          author_kind, parts_json, created_at
        ) VALUES (
          'c', 'board-1', 't1', 'p1', 0,
          'operator', '[{"kind":"text","text":"hi"}]', '2026-01-01T00:00:00.000Z'
        );
      `);

      const result = migrateStateSchema(database);
      expect(result.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
      expect(result.previousVersion).toBe(15);
      expect(result.actualSchemaSha256).toBe(
        STATE_SCHEMA_V17_IDENTITY.actualSchemaSha256,
      );

      const cols = database
        .prepare(`PRAGMA table_info(work_board_posts)`)
        .all() as unknown as ReadonlyArray<{ name: string }>;
      expect(cols.some((c) => c.name === "tags_json")).toBe(true);

      const row = database
        .prepare(
          `SELECT tags_json FROM work_board_posts WHERE post_id = 'p1'`,
        )
        .get() as { tags_json: string | null };
      expect(row.tags_json).toBeNull();

      database.exec(`
        INSERT INTO work_board_posts(
          canvas_name, node_id, topic_id, post_id, position,
          author_kind, parts_json, tags_json, created_at
        ) VALUES (
          'c', 'board-1', 't1', 'p2', 1,
          'actor', '[{"kind":"text","text":"tagged"}]',
          '["agent-a"]', '2026-01-01T00:00:01.000Z'
        );
      `);
      const tagged = database
        .prepare(
          `SELECT tags_json FROM work_board_posts WHERE post_id = 'p2'`,
        )
        .get() as { tags_json: string };
      expect(JSON.parse(tagged.tags_json)).toEqual(["agent-a"]);
    } finally {
      database.close();
    }
  });
});
