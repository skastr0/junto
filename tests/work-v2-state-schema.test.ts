import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { CANVAS_AUTHORITY_SCHEMA_SQL } from "../src/main/junto/canvas/state-schema";
import { STATION_STATE_SCHEMA_SQL } from "../src/main/junto/station/state-schema";
import { WORK_STATE_SCHEMA_HEAD_BASIS_SQL } from "../src/main/junto/work/state-schema";

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
    ${CANVAS_AUTHORITY_SCHEMA_SQL}
    ${STATION_STATE_SCHEMA_SQL}
    ${WORK_STATE_SCHEMA_HEAD_BASIS_SQL}
  `);
  database
    .prepare(
      `
        INSERT INTO canvas_portfolio_head(
          singleton,
          generation,
          intent_sha256,
          created_at,
          updated_at
        ) VALUES (1, '1', ?, ?, ?)
      `,
    )
    .run(hash("f"), observedAt, observedAt);
  database
    .prepare(
      `
        INSERT INTO canvas_documents(
          canvas_id,
          canvas_name,
          revision_sha256,
          created_at,
          modified_at
        ) VALUES ('canvas-factory', 'factory', ?, ?, ?)
      `,
    )
    .run(hash("e"), observedAt, observedAt);
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

const configureLocalInstallation = (
  database: DatabaseSync,
  installationId: string,
  role: "command-center" | "remote",
  commandCenterInstallationId?: string,
): void => {
  database
    .prepare(
      `
        INSERT INTO station_installation(
          singleton,
          installation_id,
          created_at
        ) VALUES (1, ?, ?)
      `,
    )
    .run(installationId, observedAt);
  database
    .prepare(
      `
        INSERT INTO station_configuration(
          singleton,
          role,
          host_id,
          agent_host_id,
          command_center_installation_id,
          supervised_preferred,
          configured_at
        ) VALUES (1, ?, ?, ?, ?, 1, ?)
      `,
    )
    .run(
      role,
      role === "command-center" ? "local" : "remote",
      role === "command-center" ? null : "remote",
      role === "command-center"
        ? null
        : (commandCenterInstallationId ?? null),
      observedAt,
    );
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
  readonly operation: "message.append" | "delivery.accepted";
  readonly itemKind: "message" | "delivery";
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
        ) VALUES (?, ?, ?, 'junto/work/v1', ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      record.itemKind === "message" ? "messages" : "deliveries",
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
  const command = database
    .prepare(
      `
        SELECT event_home, entity_home, seq, content_sha256
        FROM work_events
        WHERE record_type = 'command'
          AND entity_home = ?
          AND operation = ?
          AND item_kind = ?
          AND item_id = ?
        ORDER BY length(seq), seq
        LIMIT 1
      `,
    )
    .get(
      record.entityHome,
      record.operation,
      record.itemKind,
      record.itemId,
    ) as
    | {
        readonly event_home: string;
        readonly entity_home: string;
        readonly seq: string;
        readonly content_sha256: string;
      }
    | undefined;
  database
    .prepare(
      `
        INSERT INTO work_facts(
          event_home,
          entity_home,
          seq,
          basis_kind,
          basis_authorial_generation,
          basis_authorial_content_sha256,
          basis_command_event_home,
          basis_command_entity_home,
          basis_command_seq,
          basis_command_sha256,
          result_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      record.eventHome,
      record.entityHome,
      record.seq,
      command === undefined ? "authorial-intent" : "command",
      command === undefined ? "1" : null,
      command === undefined ? hash("f") : null,
      command?.event_home ?? null,
      command?.entity_home ?? null,
      command?.seq ?? null,
      command?.content_sha256 ?? null,
      "{}",
    );
};

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

describe("Work exact-current SQLite schema", () => {
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
    registerRoute(database, "remote-a", "cc-installation", "1");
    registerRoute(database, "cc-installation", "cc-installation", "2");

    insertCommand(database, {
      eventHome: "remote-a",
      entityHome: "cc-installation",
      seq: "1",
      operation: "message.append",
      itemKind: "message",
      itemId: "message-1",
      contentSha256: hash("1"),
    });
    insertFact(database, {
      eventHome: "cc-installation",
      entityHome: "cc-installation",
      seq: "1",
      operation: "message.append",
      itemKind: "message",
      itemId: "message-1",
      contentSha256: hash("2"),
    });
    insertRecord(database, {
      eventHome: "cc-installation",
      entityHome: "cc-installation",
      seq: "2",
      recordType: "disposition",
      operation: "message.append",
      itemKind: "message",
      itemId: "message-1",
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
        "cc-installation",
        "cc-installation",
        "2",
        "remote-a",
        "cc-installation",
        "1",
        hash("1"),
        "cc-installation",
        "cc-installation",
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
        operation: "message.append",
        item_kind: "message",
        item_id: "message-1",
      },
      {
        record_type: "fact",
        operation: "message.append",
        item_kind: "message",
        item_id: "message-1",
      },
      {
        record_type: "disposition",
        operation: "message.append",
        item_kind: "message",
        item_id: "message-1",
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
    const messageActorSeat = database
      .prepare("PRAGMA table_info(work_messages)")
      .all()
      .find(
        (row) =>
          (row as { readonly name: string }).name === "actor_seat_id",
      ) as
      | { readonly name: string; readonly type: string; readonly notnull: number }
      | undefined;
    expect(messageActorSeat).toMatchObject({
      name: "actor_seat_id",
      type: "TEXT",
      notnull: 1,
    });
    expect(WORK_STATE_SCHEMA_HEAD_BASIS_SQL).not.toMatch(
      /home_station|junto:command-center|payload_json/u,
    );
  });

  test("requires one resolvable closed basis group on every fact", () => {
    const database = makeDatabase();
    registerInstallation(database, "cc-installation");
    registerInstallation(database, "remote-installation");
    registerRoute(database, "cc-installation", "cc-installation", "3");
    registerRoute(
      database,
      "remote-installation",
      "remote-installation",
      "1",
    );

    const factVariant = database.prepare(
      `
        INSERT INTO work_facts(
          event_home,
          entity_home,
          seq,
          basis_kind,
          basis_authorial_generation,
          basis_authorial_content_sha256,
          basis_projected_generation,
          basis_projected_content_sha256,
          result_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')
      `,
    );

    insertRecord(database, {
      eventHome: "cc-installation",
      entityHome: "cc-installation",
      seq: "1",
      recordType: "fact",
      operation: "message.append",
      itemKind: "message",
      itemId: "message-1",
      contentSha256: hash("1"),
    });
    expect(() =>
      database
        .prepare(
          `
            INSERT INTO work_facts(
              event_home,
              entity_home,
              seq,
              result_json
            ) VALUES ('cc-installation', 'cc-installation', '1', '{}')
          `,
        )
        .run(),
    ).toThrow(/NOT NULL constraint failed/u);
    factVariant.run(
      "cc-installation",
      "cc-installation",
      "1",
      "authorial-intent",
      "1",
      hash("f"),
      null,
      null,
    );

    insertRecord(database, {
      eventHome: "cc-installation",
      entityHome: "cc-installation",
      seq: "2",
      recordType: "fact",
      operation: "message.append",
      itemKind: "message",
      itemId: "message-2",
      contentSha256: hash("2"),
    });
    expect(() =>
      factVariant.run(
        "cc-installation",
        "cc-installation",
        "2",
        "authorial-intent",
        "1",
        hash("0"),
        null,
        null,
      ),
    ).toThrow(
      /authorial fact basis must resolve its exact sink canvas head/u,
    );

    database
      .prepare(
        `
          INSERT INTO station_projection_versions(
            generation,
            content_sha256,
            source_canvas_generation,
            source_intent_sha256,
            body,
            created_at,
            received_at
          ) VALUES ('7', ?, '1', ?, '{}', ?, ?)
        `,
      )
      .run(hash("7"), hash("f"), observedAt, observedAt);
    insertRecord(database, {
      eventHome: "remote-installation",
      entityHome: "remote-installation",
      seq: "1",
      recordType: "fact",
      operation: "message.append",
      itemKind: "message",
      itemId: "message-3",
      contentSha256: hash("3"),
    });
    factVariant.run(
      "remote-installation",
      "remote-installation",
      "1",
      "projected-intent",
      null,
      null,
      "7",
      hash("7"),
    );

    insertRecord(database, {
      eventHome: "cc-installation",
      entityHome: "cc-installation",
      seq: "3",
      recordType: "fact",
      operation: "message.append",
      itemKind: "message",
      itemId: "message-4",
      contentSha256: hash("4"),
    });
    expect(() =>
      factVariant.run(
        "cc-installation",
        "cc-installation",
        "3",
        "authorial-intent",
        "1",
        hash("f"),
        "7",
        hash("7"),
      ),
    ).toThrow(/CHECK constraint failed/u);
  });

  test("requires immutable canonical sender seats on material mailbox rows", () => {
    const database = makeDatabase();
    registerInstallation(database, "cc-installation");
    configureLocalInstallation(
      database,
      "cc-installation",
      "command-center",
    );
    registerRoute(database, "cc-installation", "cc-installation", "1");
    insertFact(database, {
      eventHome: "cc-installation",
      entityHome: "cc-installation",
      seq: "1",
      operation: "message.append",
      itemKind: "message",
      itemId: "message-1",
      contentSha256: hash("a"),
    });

    const append = database.prepare(`
      INSERT INTO work_messages(
        canvas_name,
        node_id,
        message_id,
        position,
        entity_home,
        actor_seat_id,
        fact_event_home,
        fact_entity_home,
        fact_seq,
        role,
        parts_json,
        origin_at,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    expect(() =>
      append.run(
        "factory",
        "messages",
        "message-1",
        0,
        "cc-installation",
        "not-a-seat",
        "cc-installation",
        "cc-installation",
        "1",
        "agent",
        "[]",
        observedAt,
        observedAt,
      ),
    ).toThrow();
    append.run(
      "factory",
      "messages",
      "message-1",
      0,
      "cc-installation",
      seat("a"),
      "cc-installation",
      "cc-installation",
      "1",
      "agent",
      "[]",
      observedAt,
      observedAt,
    );
    expect(
      database
        .prepare(
          `
            SELECT actor_seat_id
            FROM work_messages
            WHERE canvas_name = 'factory'
              AND node_id = 'messages'
              AND message_id = 'message-1'
          `,
        )
        .get(),
    ).toEqual({ actor_seat_id: seat("a") });
    expect(() =>
      database
        .prepare(
          `
            UPDATE work_messages
            SET actor_seat_id = ?
            WHERE canvas_name = 'factory'
              AND node_id = 'messages'
              AND message_id = 'message-1'
          `,
        )
        .run(seat("b")),
    ).toThrow(/work message actor seat is immutable/u);
  });

  test("restricts every mailbox row to the configured Command Center home", () => {
    const unconfigured = makeDatabase();
    registerInstallation(unconfigured, "unconfigured-installation");
    unconfigured
      .prepare(
        `
          INSERT INTO station_installation(
            singleton,
            installation_id,
            created_at
          ) VALUES (1, ?, ?)
        `,
      )
      .run("unconfigured-installation", observedAt);
    registerRoute(
      unconfigured,
      "unconfigured-installation",
      "unconfigured-installation",
      "1",
    );
    insertFact(unconfigured, {
      eventHome: "unconfigured-installation",
      entityHome: "unconfigured-installation",
      seq: "1",
      operation: "message.append",
      itemKind: "message",
      itemId: "unconfigured-message",
      contentSha256: hash("b"),
    });

    const insertMessage = (
      database: DatabaseSync,
      values: {
        readonly messageId: string;
        readonly entityHome: string;
        readonly factEventHome: string;
        readonly factEntityHome: string;
      },
    ) =>
      database
        .prepare(
          `
            INSERT INTO work_messages(
              canvas_name,
              node_id,
              message_id,
              position,
              entity_home,
              actor_seat_id,
              fact_event_home,
              fact_entity_home,
              fact_seq,
              role,
              parts_json,
              origin_at,
              received_at
            ) VALUES (
              'factory',
              'messages',
              ?,
              (SELECT count(*) FROM work_messages),
              ?,
              ?,
              ?,
              ?,
              '1',
              'agent',
              '[]',
              ?,
              ?
            )
          `,
        )
        .run(
          values.messageId,
          values.entityHome,
          seat("b"),
          values.factEventHome,
          values.factEntityHome,
          observedAt,
          observedAt,
        );
    expect(() =>
      insertMessage(unconfigured, {
        messageId: "unconfigured-message",
        entityHome: "unconfigured-installation",
        factEventHome: "unconfigured-installation",
        factEntityHome: "unconfigured-installation",
      }),
    ).toThrow(/work mailbox messages must be Command Center-homed/u);

    const remote = makeDatabase();
    registerInstallation(remote, "cc-installation");
    registerInstallation(remote, "remote-installation");
    configureLocalInstallation(
      remote,
      "remote-installation",
      "remote",
      "cc-installation",
    );
    registerRoute(
      remote,
      "remote-installation",
      "remote-installation",
      "1",
    );
    registerRoute(remote, "cc-installation", "cc-installation", "1");
    insertFact(remote, {
      eventHome: "remote-installation",
      entityHome: "remote-installation",
      seq: "1",
      operation: "message.append",
      itemKind: "message",
      itemId: "remote-message",
      contentSha256: hash("c"),
    });
    insertFact(remote, {
      eventHome: "cc-installation",
      entityHome: "cc-installation",
      seq: "1",
      operation: "message.append",
      itemKind: "message",
      itemId: "cc-message",
      contentSha256: hash("d"),
    });

    expect(() =>
      insertMessage(remote, {
        messageId: "remote-message",
        entityHome: "remote-installation",
        factEventHome: "remote-installation",
        factEntityHome: "remote-installation",
      }),
    ).toThrow(/work mailbox messages must be Command Center-homed/u);
    expect(
      remote
        .prepare(
          `
            SELECT message_id, entity_home
            FROM work_messages
            ORDER BY message_id
          `,
        )
        .all(),
    ).toEqual([]);
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
          'message',
          'message-1',
          'factory',
          'messages',
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
