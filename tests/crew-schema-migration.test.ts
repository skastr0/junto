import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  CURRENT_STATE_SCHEMA_IDENTITY,
  migrateStateSchema,
  STATE_SCHEMA_V23_IDENTITY,
} from "../src/main/vellum-command/state/migrations";
import {
  STATE_SCHEMA_SQL,
  STATE_SCHEMA_V23_SQL,
} from "../src/main/vellum-command/state/schema";
import {
  expectedStateSchemaIdentity,
  verifyAndStampStateSchema,
} from "../src/main/vellum-command/state/schema-identity";

const SEAT_A = `seat_${"a".repeat(64)}`;
const SEAT_B = `seat_${"b".repeat(64)}`;
const SEAT_C = `seat_${"c".repeat(64)}`;

const tableSql = (database: DatabaseSync, name: string): string => {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { readonly sql: string } | undefined;
  return row?.sql ?? "";
};

const tableNames = (database: DatabaseSync): ReadonlySet<string> => {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as unknown as ReadonlyArray<{ readonly name: string }>;
  return new Set(rows.map((r) => r.name));
};

/** A v23 database with one installation and one work_events row of history. */
const buildV23WithHistory = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:");
  database.exec(STATE_SCHEMA_V23_SQL);
  verifyAndStampStateSchema(database, STATE_SCHEMA_V23_SQL);
  database.exec("PRAGMA user_version = 23");
  database.exec(`
    INSERT INTO station_known_installations(installation_id, registered_at)
    VALUES ('cc-crew', '2026-01-01T00:00:00.000Z');
    INSERT INTO work_event_sequences(event_home, entity_home, last_seq)
    VALUES ('cc-crew', 'cc-crew', '1');
    INSERT INTO work_events(
      event_home, entity_home, seq, protocol, record_type,
      item_kind, item_id, item_canvas_name, item_node_id,
      operation, content_sha256, origin_at, received_at
    ) VALUES (
      'cc-crew', 'cc-crew', '1', 'vellum/work/v2', 'fact',
      'message', 'm1', 'factory', 'agent-1',
      'message.append', '${"a".repeat(64)}',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
  `);
  return database;
};

describe("crew schema migration 23 → 24", () => {
  it("freezes v23 and the current (v24) head identity", () => {
    expect(CURRENT_STATE_SCHEMA_VERSION).toBe(24);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V23_SQL)).toEqual(
      STATE_SCHEMA_V23_IDENTITY,
    );
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(
      CURRENT_STATE_SCHEMA_IDENTITY,
    );
  });

  it("a fresh install already carries the crew tables", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(STATE_SCHEMA_SQL);
      const names = tableNames(database);
      expect(names.has("work_mail_attempts")).toBe(true);
      expect(names.has("work_review_verdicts")).toBe(true);
      expect(names.has("work_review_receipts")).toBe(true);
      expect(names.has("work_review_checkout_observations")).toBe(true);
    } finally {
      database.close();
    }
  });

  it("adds the crew tables, reaches v24, and leaves existing history intact", () => {
    const database = buildV23WithHistory();
    try {
      // The two mail tables the E2E lane reads must be byte-identical after.
      const before = {
        messages: tableSql(database, "work_messages"),
        receipts: tableSql(database, "work_delivery_receipts"),
      };
      expect(tableNames(database).has("work_mail_attempts")).toBe(false);

      const result = migrateStateSchema(database);
      expect(result.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
      expect(result.previousVersion).toBe(23);
      expect(result.actualSchemaSha256).toBe(
        CURRENT_STATE_SCHEMA_IDENTITY.actualSchemaSha256,
      );

      const names = tableNames(database);
      for (const table of [
        "work_mail_attempts",
        "work_review_verdicts",
        "work_review_receipts",
        "work_review_checkout_observations",
      ]) {
        expect(names.has(table)).toBe(true);
      }

      // Existing definitions unchanged (p1H depends on these staying readable).
      expect(tableSql(database, "work_messages")).toBe(before.messages);
      expect(tableSql(database, "work_delivery_receipts")).toBe(before.receipts);

      // Existing row survived the migration.
      const event = database
        .prepare(
          "SELECT operation, content_sha256 FROM work_events WHERE seq = '1'",
        )
        .get() as { readonly operation: string; readonly content_sha256: string };
      expect(event.operation).toBe("message.append");
    } finally {
      database.close();
    }
  });

  it("enforces the crew table constraints on real writes", () => {
    const database = buildV23WithHistory();
    try {
      migrateStateSchema(database);

      // A well-formed attempt row inserts.
      database.exec(`
        INSERT INTO work_mail_attempts(
          canvas_name, node_id, message_id, recipient_seat_id,
          recipient_generation, policy, queued_at, updated_at
        ) VALUES (
          'factory', 'agent-1', 'm1', '${SEAT_A}',
          'gen-1', 'notice', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
        );
      `);
      const attempt = database
        .prepare(
          "SELECT policy, notified_at FROM work_mail_attempts WHERE message_id = 'm1'",
        )
        .get() as { readonly policy: string; readonly notified_at: string | null };
      expect(attempt.policy).toBe("notice");
      expect(attempt.notified_at).toBeNull();

      // A bad policy and a bad refusal reason are rejected by CHECK.
      expect(() =>
        database.exec(
          `INSERT INTO work_mail_attempts(canvas_name, node_id, message_id, recipient_seat_id, recipient_generation, policy, queued_at, updated_at) VALUES ('c','n','m2','${SEAT_A}','g','shout','2026-01-02T00:00:00.000Z','2026-01-02T00:00:00.000Z')`,
        ),
      ).toThrow();
      expect(() =>
        database.exec(
          `INSERT INTO work_mail_attempts(canvas_name, node_id, message_id, recipient_seat_id, recipient_generation, policy, queued_at, refused_reason, updated_at) VALUES ('c','n','m3','${SEAT_A}','g','notice','2026-01-02T00:00:00.000Z','because','2026-01-02T00:00:00.000Z')`,
        ),
      ).toThrow();

      // A task verdict needs its full identity; a commit verdict must not carry one.
      database.exec(`
        INSERT INTO work_review_verdicts(
          verdict_id, kind, reviewer_seat_id, author_seat_id, subject_kind,
          subject_task_installation, subject_task_canvas, subject_task_node,
          subject_task_item, subject_epoch, subject_hash, epoch,
          findings_json, refs_json, posted_at_ms
        ) VALUES (
          'v1', 'green', '${SEAT_B}', '${SEAT_C}', 'task',
          'cc-crew', 'factory', 'agent-1', 't1', 0, 'hash-1', 0,
          '[]', '[]', 1000
        );
      `);
      const verdict = database
        .prepare("SELECT kind FROM work_review_verdicts WHERE verdict_id = 'v1'")
        .get() as { readonly kind: string };
      expect(verdict.kind).toBe("green");

      // Commit subject carrying a task identity violates the XOR check.
      expect(() =>
        database.exec(
          `INSERT INTO work_review_verdicts(verdict_id, kind, reviewer_seat_id, author_seat_id, subject_kind, subject_sha, subject_task_canvas, subject_hash, epoch, findings_json, refs_json, posted_at_ms) VALUES ('v2','green','${SEAT_B}','${SEAT_C}','commit','abc','factory','h',0,'[]','[]',1)`,
        ),
      ).toThrow();

      // A shared-checkout observation may record a null seat (never attributed).
      database.exec(`
        INSERT INTO work_review_checkout_observations(checkout_key, sha, observed_at)
        VALUES ('/repo', 'deadbeef', '2026-01-02T00:00:00.000Z');
      `);
      const obs = database
        .prepare(
          "SELECT seat_id FROM work_review_checkout_observations WHERE sha = 'deadbeef'",
        )
        .get() as { readonly seat_id: string | null };
      expect(obs.seat_id).toBeNull();
    } finally {
      database.close();
    }
  });
});
