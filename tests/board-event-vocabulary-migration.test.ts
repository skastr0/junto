import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  STATE_SCHEMA_V9_IDENTITY,
  migrateStateSchema,
} from "../src/main/vellum/state/migrations";
import {
  STATE_SCHEMA_SQL,
  STATE_SCHEMA_V9_SQL,
} from "../src/main/vellum/state/schema";
import {
  expectedStateSchemaIdentity,
  readRecordedStateSchemaIdentity,
  verifyAndStampStateSchema,
} from "../src/main/vellum/state/schema-identity";

const observedAt = "2026-01-01T00:00:00.000Z";
const contentSha = "a".repeat(64);

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

const seedV9Baseline = (database: DatabaseSync): void => {
  database.exec(STATE_SCHEMA_V9_SQL);
  verifyAndStampStateSchema(database, STATE_SCHEMA_V9_SQL);
  database.exec("PRAGMA user_version = 9");
};

/** Minimal Work graph that holds ON DELETE RESTRICT children of work_events. */
const seedWorkGraph = (database: DatabaseSync): void => {
  database
    .prepare(
      `
        INSERT INTO station_known_installations(installation_id, registered_at)
        VALUES (?, ?), (?, ?)
      `,
    )
    .run("cc", observedAt, "remote", observedAt);

  database
    .prepare(
      `
        INSERT INTO work_event_sequences(event_home, entity_home, last_seq)
        VALUES (?, ?, ?)
      `,
    )
    .run("remote", "cc", "1");

  database
    .prepare(
      `
        INSERT INTO work_events(
          event_home, entity_home, seq, protocol, record_type,
          item_kind, item_id, item_canvas_name, item_node_id,
          operation, content_sha256, origin_at, received_at
        ) VALUES (
          'remote', 'cc', '1', 'vellum/work/v2', 'command',
          'task', 'task-seed', 'factory', 'tasks',
          'task.create', ?, ?, ?
        )
      `,
    )
    .run(contentSha, observedAt, observedAt);

  database
    .prepare(
      `
        INSERT INTO work_commands(
          event_home, entity_home, seq, action_json
        ) VALUES ('remote', 'cc', '1', ?)
      `,
    )
    .run(JSON.stringify({ operation: "task.create" }));

  database
    .prepare(
      `
        INSERT INTO work_pending_commands(
          event_home, entity_home, seq, operation, item_kind,
          item_canvas_name, item_node_id, item_id,
          claim_actor_seat_id, resolution_status,
          resolution_event_home, resolution_entity_home, resolution_seq,
          created_at, resolved_at
        ) VALUES (
          'remote', 'cc', '1', 'task.create', 'task',
          'factory', 'tasks', 'task-seed',
          NULL, NULL,
          NULL, NULL, NULL,
          ?, NULL
        )
      `,
    )
    .run(observedAt);
};

const countTable = (database: DatabaseSync, table: string): number => {
  const row = database
    .prepare(`SELECT count(*) AS n FROM ${table}`)
    .get() as { readonly n: number };
  return Number(row.n);
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
      seedV9Baseline(database);

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
                'board.topic.create', ?, ?, ?
              )
            `,
          )
          .run(contentSha, observedAt, observedAt);
      }).toThrow(/CHECK|constraint/i);

      migrateStateSchema(database);

      expect(
        (
          database.prepare("PRAGMA user_version").get() as {
            readonly user_version: number;
          }
        ).user_version,
      ).toBe(CURRENT_STATE_SCHEMA_VERSION);

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

  it("copy-forwards a live Work graph through DROP of RESTRICT parents", () => {
    const database = openDatabase();
    try {
      seedV9Baseline(database);
      seedWorkGraph(database);

      const eventsBefore = countTable(database, "work_events");
      const commandsBefore = countTable(database, "work_commands");
      const pendingBefore = countTable(database, "work_pending_commands");
      expect(eventsBefore).toBe(1);
      expect(commandsBefore).toBe(1);
      expect(pendingBefore).toBe(1);

      // Without the outer FK-off window this throws FOREIGN KEY constraint failed.
      const result = migrateStateSchema(database);

      expect(result.schemaVersion).toBe(10);
      expect(result.previousVersion).toBe(9);
      expect(countTable(database, "work_events")).toBe(eventsBefore);
      expect(countTable(database, "work_commands")).toBe(commandsBefore);
      expect(countTable(database, "work_pending_commands")).toBe(
        pendingBefore,
      );

      const preserved = database
        .prepare(
          `
            SELECT item_id, operation, content_sha256
            FROM work_events
            WHERE event_home = 'remote' AND entity_home = 'cc' AND seq = '1'
          `,
        )
        .get() as {
        readonly item_id: string;
        readonly operation: string;
        readonly content_sha256: string;
      };
      expect(preserved).toEqual({
        item_id: "task-seed",
        operation: "task.create",
        content_sha256: contentSha,
      });

      // Board vocabulary accepted after expand.
      database
        .prepare(
          `
            INSERT INTO work_event_sequences(event_home, entity_home, last_seq)
            VALUES ('cc', 'cc', '1')
          `,
        )
        .run();
      database
        .prepare(
          `
            INSERT INTO work_events(
              event_home, entity_home, seq, protocol, record_type,
              item_kind, item_id, item_canvas_name, item_node_id,
              operation, content_sha256, origin_at, received_at
            ) VALUES (
              'cc', 'cc', '1', 'vellum/work/v2', 'fact',
              'topic', 'topic-after', 'factory', 'board',
              'board.topic.create', ?, ?, ?
            )
          `,
        )
        .run("b".repeat(64), observedAt, observedAt);

      expect(
        (
          database.prepare("PRAGMA foreign_key_check").all() as unknown[]
        ).length,
      ).toBe(0);

      expect(
        (
          database.prepare("PRAGMA foreign_keys").get() as {
            readonly foreign_keys: number;
          }
        ).foreign_keys,
      ).toBe(1);

      expect(readRecordedStateSchemaIdentity(database)).toMatchObject(
        expectedStateSchemaIdentity(STATE_SCHEMA_SQL),
      );
    } finally {
      database.close();
    }
  });
});
