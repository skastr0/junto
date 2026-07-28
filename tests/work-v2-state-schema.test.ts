import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { STATION_STATE_SCHEMA_SQL } from "../src/main/vellum/station/state-schema";
import { WORK_STATE_SCHEMA_SQL } from "../src/main/vellum/work/state-schema";

const databases: DatabaseSync[] = [];
const observedAt = "2026-07-27T12:00:00.000Z";
const hash = (digit: string): string => digit.repeat(64);
const seat = (digit: string): string => `seat_${digit.repeat(64)}`;

const makeDatabase = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:", {
    enableForeignKeyConstraints: true,
  });
  databases.push(database);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    ${STATION_STATE_SCHEMA_SQL}
    ${WORK_STATE_SCHEMA_SQL}
  `);
  return database;
};

const registerInstallation = (
  database: DatabaseSync,
  installationId: string,
): void => {
  database
    .prepare(
      `
        INSERT INTO station_known_installations(
          installation_id,
          registered_at
        ) VALUES (?, ?)
      `,
    )
    .run(installationId, observedAt);
};

const registerRoute = (
  database: DatabaseSync,
  eventHome: string,
  entityHome: string,
  lastSeq: string,
): void => {
  database
    .prepare(
      `
        INSERT INTO work_event_sequences(
          event_home,
          entity_home,
          last_seq
        ) VALUES (?, ?, ?)
      `,
    )
    .run(eventHome, entityHome, lastSeq);
};

type RecordFixture = {
  readonly eventHome: string;
  readonly entityHome: string;
  readonly seq: string;
  readonly recordType: "command" | "fact" | "disposition";
  readonly operation:
    | "task.create"
    | "task.claim"
    | "delivery.accepted";
  readonly itemKind: "task" | "delivery";
  readonly itemId: string;
  readonly contentSha256: string;
};

const insertRecord = (
  database: DatabaseSync,
  record: RecordFixture,
): void => {
  database
    .prepare(
      `
        INSERT INTO work_events(
          event_home,
          entity_home,
          seq,
          protocol,
          record_type,
          item_kind,
          item_id,
          item_canvas_name,
          item_node_id,
          operation,
          content_sha256,
          origin_at,
          received_at
        ) VALUES (?, ?, ?, 'vellum/work/v2', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      record.eventHome,
      record.entityHome,
      record.seq,
      record.recordType,
      record.itemKind,
      record.itemId,
      "factory",
      record.itemKind === "task" ? "tasks" : "deliveries",
      record.operation,
      record.contentSha256,
      observedAt,
      observedAt,
    );
};

const insertCommand = (
  database: DatabaseSync,
  record: Omit<RecordFixture, "recordType">,
): void => {
  insertRecord(database, { ...record, recordType: "command" });
  database
    .prepare(
      `
        INSERT INTO work_commands(
          event_home,
          entity_home,
          seq,
          action_json
        ) VALUES (?, ?, ?, ?)
      `,
    )
    .run(record.eventHome, record.entityHome, record.seq, "{}");
};

const insertFact = (
  database: DatabaseSync,
  record: Omit<RecordFixture, "recordType">,
): void => {
  insertRecord(database, { ...record, recordType: "fact" });
  database
    .prepare(
      `
        INSERT INTO work_facts(
          event_home,
          entity_home,
          seq,
          result_json
        ) VALUES (?, ?, ?, ?)
      `,
    )
    .run(record.eventHome, record.entityHome, record.seq, "{}");
};

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

describe("Work v2 exact-current SQLite schema", () => {
  test("stores full InstallationId routes and rejects unknown homes", () => {
    const database = makeDatabase();
    registerInstallation(database, "cc-installation");
    registerInstallation(database, "remote-a");
    registerInstallation(database, "remote-b");

    database
      .prepare(
        `
          INSERT INTO station_received_cursors(
            event_home,
            entity_home,
            through_sequence,
            updated_at
          ) VALUES (?, ?, ?, ?), (?, ?, ?, ?)
        `,
      )
      .run(
        "cc-installation",
        "remote-a",
        "1",
        observedAt,
        "cc-installation",
        "remote-b",
        "1",
        observedAt,
      );
    database
      .prepare(
        `
          INSERT INTO station_peer_ack_cursors(
            peer_installation_id,
            event_home,
            entity_home,
            through_sequence,
            acknowledged_at
          ) VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(
        "remote-a",
        "cc-installation",
        "remote-a",
        "1",
        observedAt,
      );

    expect(
      database
        .prepare(
          `
            SELECT event_home, entity_home, through_sequence
            FROM station_received_cursors
            ORDER BY entity_home
          `,
        )
        .all(),
    ).toEqual([
      {
        event_home: "cc-installation",
        entity_home: "remote-a",
        through_sequence: "1",
      },
      {
        event_home: "cc-installation",
        entity_home: "remote-b",
        through_sequence: "1",
      },
    ]);

    expect(() =>
      registerRoute(database, "cc-installation", "host-not-registered", "0"),
    ).toThrow(/FOREIGN KEY constraint failed/u);
  });

  test("normalizes the common envelope and closed record variants", () => {
    const database = makeDatabase();
    registerInstallation(database, "cc-installation");
    registerInstallation(database, "remote-a");
    registerRoute(database, "cc-installation", "remote-a", "1");
    registerRoute(database, "remote-a", "remote-a", "2");

    insertCommand(database, {
      eventHome: "cc-installation",
      entityHome: "remote-a",
      seq: "1",
      operation: "task.claim",
      itemKind: "task",
      itemId: "task-1",
      contentSha256: hash("1"),
    });
    insertFact(database, {
      eventHome: "remote-a",
      entityHome: "remote-a",
      seq: "1",
      operation: "task.claim",
      itemKind: "task",
      itemId: "task-1",
      contentSha256: hash("2"),
    });
    insertRecord(database, {
      eventHome: "remote-a",
      entityHome: "remote-a",
      seq: "2",
      recordType: "disposition",
      operation: "task.claim",
      itemKind: "task",
      itemId: "task-1",
      contentSha256: hash("3"),
    });
    database
      .prepare(
        `
          INSERT INTO work_dispositions(
            event_home,
            entity_home,
            seq,
            status,
            command_event_home,
            command_entity_home,
            command_seq,
            command_sha256,
            fact_event_home,
            fact_entity_home,
            fact_seq,
            fact_sha256
          ) VALUES (?, ?, ?, 'applied', ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        "remote-a",
        "remote-a",
        "2",
        "cc-installation",
        "remote-a",
        "1",
        hash("1"),
        "remote-a",
        "remote-a",
        "1",
        hash("2"),
      );

    expect(
      database
        .prepare(
          `
            SELECT record_type, operation, item_kind, item_id
            FROM work_events
            ORDER BY
              CASE record_type
                WHEN 'command' THEN 1
                WHEN 'fact' THEN 2
                ELSE 3
              END
          `,
        )
        .all(),
    ).toEqual([
      {
        record_type: "command",
        operation: "task.claim",
        item_kind: "task",
        item_id: "task-1",
      },
      {
        record_type: "fact",
        operation: "task.claim",
        item_kind: "task",
        item_id: "task-1",
      },
      {
        record_type: "disposition",
        operation: "task.claim",
        item_kind: "task",
        item_id: "task-1",
      },
    ]);
    expect(
      database
        .prepare("SELECT status FROM work_dispositions")
        .get(),
    ).toEqual({ status: "applied" });

    const eventColumns = database
      .prepare("PRAGMA table_info(work_events)")
      .all()
      .map((row) => (row as { readonly name: string }).name);
    expect(eventColumns).not.toContain("payload_json");
    expect(WORK_STATE_SCHEMA_SQL).not.toMatch(
      /home_station|vellum:command-center|payload_json/u,
    );
  });

  test("reserves at most one unresolved task claim per item and actor seat", () => {
    const database = makeDatabase();
    registerInstallation(database, "cc-installation");
    registerInstallation(database, "remote-a");
    registerRoute(database, "cc-installation", "remote-a", "3");
    registerRoute(database, "remote-a", "remote-a", "2");

    for (const command of [
      { seq: "1", itemId: "task-1", digest: "1" },
      { seq: "2", itemId: "task-1", digest: "2" },
      { seq: "3", itemId: "task-2", digest: "3" },
    ]) {
      insertCommand(database, {
        eventHome: "cc-installation",
        entityHome: "remote-a",
        seq: command.seq,
        operation: "task.claim",
        itemKind: "task",
        itemId: command.itemId,
        contentSha256: hash(command.digest),
      });
    }

    const insertPending = database.prepare(
      `
        INSERT INTO work_pending_commands(
          event_home,
          entity_home,
          seq,
          operation,
          item_kind,
          item_canvas_name,
          item_node_id,
          item_id,
          claim_actor_seat_id,
          created_at
        ) VALUES (?, ?, ?, 'task.claim', 'task', 'factory', 'tasks', ?, ?, ?)
      `,
    );
    expect(() =>
      insertPending.run(
        "cc-installation",
        "remote-a",
        "1",
        "task-1",
        hash("a"),
        observedAt,
      ),
    ).toThrow(/CHECK constraint failed/u);
    expect(() =>
      insertPending.run(
        "cc-installation",
        "remote-a",
        "1",
        "task-1",
        seat("a").toUpperCase(),
        observedAt,
      ),
    ).toThrow(/CHECK constraint failed/u);
    insertPending.run(
      "cc-installation",
      "remote-a",
      "1",
      "task-1",
      seat("a"),
      observedAt,
    );

    expect(() =>
      insertPending.run(
        "cc-installation",
        "remote-a",
        "2",
        "task-1",
        seat("b"),
        observedAt,
      ),
    ).toThrow(/UNIQUE constraint failed/u);
    expect(() =>
      insertPending.run(
        "cc-installation",
        "remote-a",
        "3",
        "task-2",
        seat("a"),
        observedAt,
      ),
    ).toThrow(/UNIQUE constraint failed/u);

    insertFact(database, {
      eventHome: "remote-a",
      entityHome: "remote-a",
      seq: "1",
      operation: "task.claim",
      itemKind: "task",
      itemId: "task-1",
      contentSha256: hash("4"),
    });
    insertRecord(database, {
      eventHome: "remote-a",
      entityHome: "remote-a",
      seq: "2",
      recordType: "disposition",
      operation: "task.claim",
      itemKind: "task",
      itemId: "task-1",
      contentSha256: hash("5"),
    });
    database
      .prepare(
        `
          INSERT INTO work_dispositions(
            event_home,
            entity_home,
            seq,
            status,
            command_event_home,
            command_entity_home,
            command_seq,
            command_sha256,
            fact_event_home,
            fact_entity_home,
            fact_seq,
            fact_sha256
          ) VALUES (
            'remote-a',
            'remote-a',
            '2',
            'applied',
            'cc-installation',
            'remote-a',
            '1',
            ?,
            'remote-a',
            'remote-a',
            '1',
            ?
          )
        `,
      )
      .run(hash("1"), hash("4"));
    database
      .prepare(
        `
          UPDATE work_pending_commands
          SET
            resolution_status = 'applied',
            resolution_event_home = 'remote-a',
            resolution_entity_home = 'remote-a',
            resolution_seq = '2',
            resolved_at = ?
          WHERE event_home = 'cc-installation'
            AND entity_home = 'remote-a'
            AND seq = '1'
        `,
      )
      .run(observedAt);

    expect(() =>
      database
        .prepare(
          `
            INSERT INTO work_pending_commands(
              event_home,
              entity_home,
              seq,
              operation,
              item_kind,
              item_canvas_name,
              item_node_id,
              item_id,
              claim_actor_seat_id,
              resolution_status,
              resolution_event_home,
              resolution_entity_home,
              resolution_seq,
              created_at,
              resolved_at
            ) VALUES (
              'cc-installation',
              'remote-a',
              '2',
              'task.claim',
              'task',
              'factory',
              'tasks',
              'task-1',
              ?,
              'applied',
              'remote-a',
              'remote-a',
              '2',
              ?,
              ?
            )
          `,
        )
        .run(seat("b"), observedAt, observedAt),
    ).toThrow(/causal disposition/u);

    expect(() =>
      insertPending.run(
        "cc-installation",
        "remote-a",
        "2",
        "task-1",
        seat("b"),
        observedAt,
      ),
    ).not.toThrow();
  });

  test("enforces first claim adoption and one active task per ActorSeatId", () => {
    const database = makeDatabase();
    registerInstallation(database, "cc-installation");
    registerInstallation(database, "remote-a");
    registerInstallation(database, "remote-b");
    registerRoute(database, "cc-installation", "cc-installation", "1");
    registerRoute(database, "remote-a", "remote-a", "3");
    registerRoute(database, "remote-b", "remote-b", "1");

    insertFact(database, {
      eventHome: "remote-a",
      entityHome: "remote-a",
      seq: "1",
      operation: "task.claim",
      itemKind: "task",
      itemId: "active-1",
      contentSha256: hash("1"),
    });
    insertFact(database, {
      eventHome: "remote-a",
      entityHome: "remote-a",
      seq: "2",
      operation: "task.claim",
      itemKind: "task",
      itemId: "active-2",
      contentSha256: hash("2"),
    });

    const insertTask = database.prepare(
      `
        INSERT INTO work_tasks(
          canvas_name,
          node_id,
          task_id,
          entity_home,
          actor_seat_id,
          fact_event_home,
          fact_entity_home,
          fact_seq,
          state,
          brief_message_id,
          created_at,
          updated_at,
          origin_at,
          received_at
        ) VALUES (
          'factory',
          'tasks',
          ?,
          'remote-a',
          ?,
          'remote-a',
          'remote-a',
          ?,
          ?,
          'brief',
          ?,
          ?,
          ?,
          ?
        )
      `,
    );
    insertTask.run(
      "active-1",
      seat("a"),
      "1",
      "working",
      observedAt,
      observedAt,
      observedAt,
      observedAt,
    );
    expect(() =>
      insertTask.run(
        "active-2",
        seat("a"),
        "2",
        "input-required",
        observedAt,
        observedAt,
        observedAt,
        observedAt,
      ),
    ).toThrow(/UNIQUE constraint failed/u);
    expect(() =>
      insertTask.run(
        "active-2",
        seat("a"),
        "2",
        "completed",
        observedAt,
        observedAt,
        observedAt,
        observedAt,
      ),
    ).not.toThrow();

    insertFact(database, {
      eventHome: "cc-installation",
      entityHome: "cc-installation",
      seq: "1",
      operation: "task.create",
      itemKind: "task",
      itemId: "adopted",
      contentSha256: hash("3"),
    });
    database
      .prepare(
        `
          INSERT INTO work_tasks(
            canvas_name,
            node_id,
            task_id,
            entity_home,
            fact_event_home,
            fact_entity_home,
            fact_seq,
            state,
            brief_message_id,
            created_at,
            updated_at,
            origin_at,
            received_at
          ) VALUES (
            'factory',
            'tasks',
            'adopted',
            'cc-installation',
            'cc-installation',
            'cc-installation',
            '1',
            'submitted',
            'brief',
            ?,
            ?,
            ?,
            ?
          )
        `,
      )
      .run(observedAt, observedAt, observedAt, observedAt);
    insertFact(database, {
      eventHome: "remote-a",
      entityHome: "remote-a",
      seq: "3",
      operation: "task.claim",
      itemKind: "task",
      itemId: "adopted",
      contentSha256: hash("4"),
    });
    database
      .prepare(
        `
          UPDATE work_tasks
          SET
            entity_home = 'remote-a',
            actor_seat_id = ?,
            fact_event_home = 'remote-a',
            fact_entity_home = 'remote-a',
            fact_seq = '3',
            state = 'working',
            updated_at = ?
          WHERE canvas_name = 'factory'
            AND node_id = 'tasks'
            AND task_id = 'adopted'
        `,
      )
      .run(seat("b"), observedAt);

    insertFact(database, {
      eventHome: "remote-b",
      entityHome: "remote-b",
      seq: "1",
      operation: "task.claim",
      itemKind: "task",
      itemId: "adopted",
      contentSha256: hash("5"),
    });
    expect(() =>
      database
        .prepare(
          `
            UPDATE work_tasks
            SET
              entity_home = 'remote-b',
              fact_event_home = 'remote-b',
              fact_entity_home = 'remote-b',
              fact_seq = '1',
              updated_at = ?
            WHERE canvas_name = 'factory'
              AND node_id = 'tasks'
              AND task_id = 'adopted'
          `,
        )
        .run(observedAt),
    ).toThrow(/home is immutable except for first claim adoption/u);
  });

  test("persists delivery acceptance as an actor-bound fact receipt", () => {
    const database = makeDatabase();
    registerInstallation(database, "remote-a");
    registerRoute(database, "remote-a", "remote-a", "1");
    insertFact(database, {
      eventHome: "remote-a",
      entityHome: "remote-a",
      seq: "1",
      operation: "delivery.accepted",
      itemKind: "delivery",
      itemId: "delivery-1",
      contentSha256: hash("1"),
    });

    const insertReceipt = database.prepare(
      `
        INSERT INTO work_delivery_receipts(
          delivery_id,
          delivered_item_kind,
          delivered_item_id,
          delivered_canvas_name,
          delivered_node_id,
          actor_seat_id,
          actor_canvas_name,
          actor_node_id,
          entity_home,
          fact_event_home,
          fact_entity_home,
          fact_seq,
          accepted_at,
          received_at
        ) VALUES (
          'delivery-1',
          'task',
          'task-1',
          'factory',
          'tasks',
          ?,
          'factory',
          'agent',
          'remote-a',
          'remote-a',
          'remote-a',
          '1',
          ?,
          ?
        )
      `,
    );
    insertReceipt.run(seat("a"), observedAt, observedAt);

    expect(
      database
        .prepare(
          `
            SELECT delivery_id, actor_seat_id, entity_home
            FROM work_delivery_receipts
          `,
        )
        .get(),
    ).toEqual({
      delivery_id: "delivery-1",
      actor_seat_id: seat("a"),
      entity_home: "remote-a",
    });
    expect(() =>
      insertReceipt.run(seat("a"), observedAt, observedAt),
    ).toThrow(/UNIQUE constraint failed/u);
  });
});
