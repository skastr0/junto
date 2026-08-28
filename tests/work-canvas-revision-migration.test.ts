// Per-canvas Work revision counter: migration 18 -> 19 and the trigger contract.
//
// The runtime projection's invalidation identity used to be a count(*) over a
// seven-table UNION ALL, scanned on every canvas read. This proves the counter
// that replaced it: installed rows survive the upgrade, the seeded value is the
// one the retired count would have returned, and the counter moves for every
// durable Work change the projection can see — including the in-place UPDATEs
// a row count could not.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  migrateStateSchema,
  STATE_SCHEMA_V18_IDENTITY,
  STATE_SCHEMA_V19_IDENTITY,
  CURRENT_STATE_SCHEMA_IDENTITY,
} from "../src/main/vellum/state/migrations";
import {
  STATE_SCHEMA_SQL,
  STATE_SCHEMA_V18_SQL,
  STATE_SCHEMA_V19_SQL,
} from "../src/main/vellum/state/schema";
import {
  expectedStateSchemaIdentity,
  verifyAndStampStateSchema,
} from "../src/main/vellum/state/schema-identity";

const revision = (
  database: DatabaseSync,
  canvasName: string,
): number | undefined =>
  (
    database
      .prepare(
        `SELECT revision FROM work_canvas_revisions WHERE canvas_name = ?`,
      )
      .get(canvasName) as { revision: number } | undefined
  )?.revision;

const openV18 = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:");
  database.exec(STATE_SCHEMA_V18_SQL);
  verifyAndStampStateSchema(database, STATE_SCHEMA_V18_SQL);
  database.exec("PRAGMA user_version = 18");
  return database;
};

describe("work canvas revision migration 18 -> 19", () => {
  it("freezes v18, v19 and current identities", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V18_SQL)).toEqual(
      STATE_SCHEMA_V18_IDENTITY,
    );
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V19_SQL)).toEqual(
      STATE_SCHEMA_V19_IDENTITY,
    );
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(
      CURRENT_STATE_SCHEMA_IDENTITY,
    );
  });

  it("seeds installed canvases at the retired count and keeps their rows", () => {
    const database = openV18();
    try {
      database.exec(`
        INSERT INTO work_pad_meta(canvas_name, node_id, revision, updated_at)
        VALUES ('factory', 'pad-1', 7, '2026-01-01T00:00:00.000Z');
        INSERT INTO work_pad_read_cursors(
          canvas_name, node_id, pin_id, principal_key,
          last_read_position, updated_at
        ) VALUES (
          'factory', 'pad-1', 'p1', 'operator', 3,
          '2026-01-01T00:00:00.000Z'
        );
        INSERT INTO work_pad_meta(canvas_name, node_id, revision, updated_at)
        VALUES ('other', 'pad-9', 1, '2026-01-01T00:00:00.000Z');
      `);

      const result = migrateStateSchema(database);
      expect(result.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
      expect(result.previousVersion).toBe(18);
      expect(result.actualSchemaSha256).toBe(
        CURRENT_STATE_SCHEMA_IDENTITY.actualSchemaSha256,
      );

      // Rows the migration must not touch.
      const pad = database
        .prepare(
          `SELECT revision FROM work_pad_meta WHERE canvas_name = 'factory'`,
        )
        .get() as { revision: number };
      expect(pad.revision).toBe(7);

      // Seeded at exactly the value the retired UNION ALL count returned:
      // one work_pad_meta row + one work_pad_read_cursors row on "factory".
      // 19 -> 20 adds triggers only, so the seeded values are untouched.
      expect(revision(database, "factory")).toBe(2);
      expect(revision(database, "other")).toBe(1);
    } finally {
      database.close();
    }
  });

  it("starts a fresh install with no counter row, so the projection reads 0", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(STATE_SCHEMA_SQL);
      expect(revision(database, "factory")).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("moves on insert, in-place update, and delete of every projected table", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(STATE_SCHEMA_SQL);
      database.exec(`
        INSERT INTO work_board_topics(
          canvas_name, node_id, topic_id, title, state, author_kind,
          parts_json, post_count, last_activity_at, created_at, updated_at
        ) VALUES (
          'factory', 'board-1', 'topic-1', 'first', 'open', 'operator',
          '[]', 0, '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );
      `);
      const afterInsert = revision(database, "factory");
      expect(afterInsert).toBe(1);

      // The case a row count structurally cannot see: nothing added, nothing
      // removed, but the projected topic changed.
      database.exec(`
        UPDATE work_board_topics
        SET title = 'retitled'
        WHERE canvas_name = 'factory' AND node_id = 'board-1';
      `);
      const afterUpdate = revision(database, "factory")!;
      expect(afterUpdate).toBeGreaterThan(afterInsert!);

      database.exec(`
        INSERT INTO work_board_posts(
          canvas_name, node_id, topic_id, post_id, position,
          author_kind, parts_json, created_at
        ) VALUES (
          'factory', 'board-1', 'topic-1', 'post-1', 0,
          'operator', '[{"kind":"text","text":"hi"}]',
          '2026-01-01T00:00:00.000Z'
        );
      `);
      const afterPost = revision(database, "factory")!;
      expect(afterPost).toBeGreaterThan(afterUpdate);

      database.exec(`
        DELETE FROM work_board_posts WHERE canvas_name = 'factory';
      `);
      const afterDelete = revision(database, "factory")!;
      expect(afterDelete).toBeGreaterThan(afterPost);

      // Another canvas's traffic never moves this canvas's revision.
      database.exec(`
        INSERT INTO work_pad_meta(canvas_name, node_id, revision, updated_at)
        VALUES ('elsewhere', 'pad-1', 1, '2026-01-01T00:00:00.000Z');
      `);
      expect(revision(database, "factory")).toBe(afterDelete);
      expect(revision(database, "elsewhere")).toBe(1);
    } finally {
      database.close();
    }
  });
});
