import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Result, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { withSqlRead } from "../src/main/junto/state/sql-read";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import { serializeCanvas, type CanvasDoc } from "../src/shared/canvas";
import { ContentRef } from "../src/shared/content";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/installation-id";
import {
  WorkAuthorityError,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/junto/work/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { IntentFactBasis } from "../src/shared/work-protocol";
import { authorialMaterialForTest } from "./helpers/authorial-material";
import { seedCanvasAuthority } from "./helpers/canvas-authority-material";

const root = join(tmpdir(), `junto-work-v2-${randomUUID()}`);
const runtime = ManagedRuntime.make(
  Layer.provideMerge(
    WorkRepositoryLive,
    makeStateEngineLive(join(root, "junto.db")),
  ),
);

let repository: Context.Service.Shape<typeof WorkRepository>;
let sql: SqlClient.SqlClient;

const observedAt = "2026-07-27T18:00:00.000Z";
const cc = Schema.decodeUnknownSync(InstallationId)("cc-repository");
const remote = Schema.decodeUnknownSync(InstallationId)("remote-repository");
const fixtureSeatNodeIds: ReadonlyArray<string> = [
  "builder",
  "inbox",
  "content-mailbox",
  "unconfigured-inbox",
  "basis-rejections",
  "basis-roundtrip",
  "inbox-authority",
  "notification-mailbox",
];
const fixtureSeatNode = (
  id: string,
  index: number,
): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  x: 0,
  y: index * 120,
  width: 240,
  height: 100,
  text: id,
  ether: { entity: { kind: "agent", name: `local:${id}` } },
});
const fixtureTopology: CanvasDoc = {
  nodes: fixtureSeatNodeIds.map(fixtureSeatNode),
  edges: [],
};
const fixtureTopologyBody = serializeCanvas(fixtureTopology);
const currentIntentSha256 = authorialMaterialForTest({
  generation: "1",
  documents: new Map([
    ["factory", { document: fixtureTopology, rawBody: fixtureTopologyBody }],
  ]),
}).intentSha256;
const decodeIntentFactBasis = Schema.decodeUnknownSync(IntentFactBasis, {
  onExcessProperty: "error",
});
const authorialBasis = decodeIntentFactBasis({
  kind: "authorial-intent",
  generation: "1",
  contentSha256: currentIntentSha256,
});
const staleAuthorialBasis = decodeIntentFactBasis({
  kind: "authorial-intent",
  generation: "0",
  contentSha256: currentIntentSha256,
});
const wrongAuthorialBasis = decodeIntentFactBasis({
  kind: "authorial-intent",
  generation: "1",
  contentSha256: "f".repeat(64),
});
const projectedBasis = decodeIntentFactBasis({
  kind: "projected-intent",
  generation: "1",
  contentSha256: currentIntentSha256,
});

const actor = {
  seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${"a".repeat(64)}`),
  canvasName: "factory",
  nodeId: "builder",
};

const message = (messageId: string, role: "user" | "agent", text: string) => ({
  messageId,
  role,
  parts: [{ kind: "text" as const, text }],
  contextId: "factory",
});

const seedInstallations = (
  installations: ReadonlyArray<InstallationIdValue>,
  local: InstallationIdValue,
  client: SqlClient.SqlClient = sql,
) =>
  client.withTransaction(
    Effect.gen(function* () {
      for (const installation of installations) {
        yield* client.unsafe(
          `
          INSERT INTO station_known_installations(
            installation_id,
            registered_at
          ) VALUES (?, ?)
        `,
          [installation, observedAt],
        );
      }
      yield* client.unsafe(
        `
        INSERT INTO station_installation(
          singleton,
          installation_id,
          created_at
        ) VALUES (1, ?, ?)
      `,
        [local, observedAt],
      );
      yield* client.unsafe(
        `
        INSERT INTO station_configuration(
          singleton,
          role,
          host_id,
          agent_host_id,
          command_center_installation_id,
          supervised_preferred,
          configured_at
        ) VALUES (1, 'command-center', 'local', NULL, NULL, 1, ?)
      `,
        [observedAt],
      );
      // Head-only relational authority: only the current generation "1" exists.
      // The stale generation "0" survives solely as literal basis values whose
      // rejection ("causal-conflict") is asserted below — a stale basis is
      // unresolvable by construction in the head-only world.
      yield* seedCanvasAuthority({
        generation: "1",
        documents: new Map([["factory", fixtureTopology]]),
        at: observedAt,
      });
    }),
  );

beforeAll(async () => {
  repository = await runtime.runPromise(WorkRepository);
  sql = await runtime.runPromise(SqlClient.SqlClient);
  await runtime.runPromise(seedInstallations([cc, remote], cc));
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

describe("WorkRepository v2 local authority", () => {
  it("notifies only after the outer commit and discards rolled-back savepoints", async () => {
    const sink = { canvasName: "factory", nodeId: "notification-mailbox" };
    const notifications: string[] = [];
    const unsubscribe = repository.subscribeChanges((canvasName, nodeId) => {
      notifications.push(`${canvasName}/${nodeId}`);
    });
    const append = (id: string) =>
      repository.appendMessage({
        sink,
        basis: authorialBasis,
        message: message(id, "agent", id),
        sentBy: actor,
        destination: { kind: "mailbox" },
        originAt: observedAt,
        receivedAt: observedAt,
      });
    try {
      const rolledBack = await runtime.runPromise(
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* append("outer-rollback");
              expect(notifications).toEqual([]);
              return yield* Effect.fail("outer rollback");
            }),
          )
          .pipe(Effect.result),
      );
      expect(rolledBack).toMatchObject({
        _tag: "Failure",
        failure: "outer rollback",
      });
      expect(notifications).toEqual([]);
      await runtime.runPromise(
        sql.withTransaction(
          Effect.gen(function* () {
            const failed = yield* Effect.result(
              sql.withTransaction(
                Effect.gen(function* () {
                  yield* append("savepoint-rollback");
                  return yield* Effect.fail("savepoint rollback");
                }),
              ),
            );
            expect(failed).toMatchObject({
              _tag: "Failure",
              failure: "savepoint rollback",
            });
            yield* append("outer-commit");
            expect(notifications).toEqual([]);
          }),
        ),
      );
      expect(notifications).toEqual(["factory/notification-mailbox"]);
      expect(
        (
          await runtime.runPromise(
            repository.readSnapshot(sink.canvasName, sink.nodeId),
          )
        ).messages.items.map((item) => item.messageId),
      ).toEqual(["outer-commit"]);
    } finally {
      unsubscribe();
    }
  });

  it("persists ContentRef parts on new mail", async () => {
    const contentRef = Schema.decodeUnknownSync(ContentRef)({
      sha256: "1".repeat(64),
      byteLength: 12_345,
      mediaType: "video/mp4",
      displayName: "clip.mp4",
    });
    const mailbox = { canvasName: "factory", nodeId: "content-mailbox" };
    const contentMessage = {
      messageId: "content-message-1",
      role: "agent" as const,
      parts: [
        { kind: "text" as const, text: "Review the clip" },
        { kind: "content" as const, ref: contentRef },
      ],
      contextId: "factory",
    };
    await runtime.runPromise(
      repository.appendMessage({
        sink: mailbox,
        basis: authorialBasis,
        message: contentMessage,
        sentBy: actor,
        destination: { kind: "mailbox" },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const snapshot = await runtime.runPromise(
      repository.readSnapshot(mailbox.canvasName, mailbox.nodeId),
    );
    expect(snapshot.messages.items[0]?.parts).toEqual(contentMessage.parts);
    const storedMessageParts = await runtime.runPromise(
      sql
        .unsafe<{ readonly parts_json: string }>(
          `SELECT parts_json FROM work_messages
           WHERE canvas_name = ? AND node_id = ? AND message_id = ?`,
          [mailbox.canvasName, mailbox.nodeId, contentMessage.messageId],
        )
        .pipe(Effect.map((rows) => rows[0]?.parts_json)),
    );
    expect(storedMessageParts).toContain('"kind":"content"');
    expect(storedMessageParts).not.toContain("bytesBase64");
    const storedMessageFact = await runtime.runPromise(
      sql
        .unsafe<{ readonly result_json: string }>(
          `SELECT facts.result_json
           FROM work_facts AS facts
           JOIN work_events AS events
             ON events.event_home = facts.event_home
            AND events.entity_home = facts.entity_home
            AND events.seq = facts.seq
           WHERE events.operation = 'message.append'
             AND events.item_id = ?`,
          [contentMessage.messageId],
        )
        .pipe(Effect.map((rows) => rows[0]?.result_json)),
    );
    expect(storedMessageFact).toContain('"kind":"content"');
    expect(storedMessageFact).not.toContain("bytesBase64");
  });

  it("rejects unconfigured local mutation without writing any Work row", async () => {
    const unconfiguredRoot = join(
      tmpdir(),
      `junto-work-v2-unconfigured-${randomUUID()}`,
    );
    const unconfiguredRuntime = ManagedRuntime.make(
      Layer.provideMerge(
        WorkRepositoryLive,
        makeStateEngineLive(join(unconfiguredRoot, "junto.db")),
      ),
    );
    try {
      const unconfiguredRepository =
        await unconfiguredRuntime.runPromise(WorkRepository);
      const unconfiguredSql = await unconfiguredRuntime.runPromise(
        SqlClient.SqlClient,
      );
      const unconfiguredInstallation = Schema.decodeUnknownSync(InstallationId)(
        "unconfigured-repository",
      );
      await unconfiguredRuntime.runPromise(
        unconfiguredSql.withTransaction(
          Effect.gen(function* () {
            yield* unconfiguredSql.unsafe(
              `
                INSERT INTO station_known_installations(
                  installation_id,
                  registered_at
                ) VALUES (?, ?)
              `,
              [unconfiguredInstallation, observedAt],
            );
            yield* unconfiguredSql.unsafe(
              `
                INSERT INTO station_installation(
                  singleton,
                  installation_id,
                  created_at
                ) VALUES (1, ?, ?)
              `,
              [unconfiguredInstallation, observedAt],
            );
          }),
        ),
      );

      const result = await unconfiguredRuntime.runPromise(
        unconfiguredRepository
          .appendMessage({
            sink: { canvasName: "factory", nodeId: "unconfigured-inbox" },
            basis: authorialBasis,
            message: message(
              "must-not-exist",
              "agent",
              "deny before configuration",
            ),
            sentBy: actor,
            destination: { kind: "mailbox" },
            originAt: observedAt,
            receivedAt: observedAt,
          })
          .pipe(Effect.result),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(WorkAuthorityError);
        expect(result.failure).toMatchObject({
          reason: "authority-mismatch",
        });
      }
      expect(
        await unconfiguredRuntime.runPromise(
          withSqlRead(
            unconfiguredSql,
            Effect.gen(function* () {
              return {
                sequences: (yield* unconfiguredSql.unsafe<{
                  readonly count: number;
                }>("SELECT count(*) AS count FROM work_event_sequences"))[0]!
                  .count,
                records: (yield* unconfiguredSql.unsafe<{
                  readonly count: number;
                }>("SELECT count(*) AS count FROM work_events"))[0]!.count,
                messages: (yield* unconfiguredSql.unsafe<{
                  readonly count: number;
                }>("SELECT count(*) AS count FROM work_messages"))[0]!.count,
              };
            }),
          ),
        ),
      ).toEqual({ sequences: 0, records: 0, messages: 0 });
    } finally {
      await unconfiguredRuntime.dispose();
      await rm(unconfiguredRoot, { recursive: true, force: true });
    }
  });

  it("rejects stale, mismatched, and role-wrong intent bases transactionally", async () => {
    const sink = { canvasName: "factory", nodeId: "basis-rejections" };
    const persistedState = () =>
      withSqlRead(
        sql,
        Effect.gen(function* () {
          return {
            lastSequence:
              (yield* sql.unsafe<{ readonly last_seq: string }>(
                `
              SELECT last_seq
              FROM work_event_sequences
              WHERE event_home = ? AND entity_home = ?
            `,
                [cc, cc],
              ))[0]?.last_seq ?? null,
            events: (yield* sql.unsafe<{ readonly count: number }>(
              `
            SELECT count(*) AS count
            FROM work_events
            WHERE item_canvas_name = ? AND item_node_id = ?
          `,
              [sink.canvasName, sink.nodeId],
            ))[0]!.count,
            messages: (yield* sql.unsafe<{ readonly count: number }>(
              `
            SELECT count(*) AS count
            FROM work_messages
            WHERE canvas_name = ? AND node_id = ?
          `,
              [sink.canvasName, sink.nodeId],
            ))[0]!.count,
          };
        }),
      );
    const before = await runtime.runPromise(persistedState());

    for (const [messageId, basis, reason] of [
      ["stale-basis-mail", staleAuthorialBasis, "causal-conflict"],
      ["wrong-hash-mail", wrongAuthorialBasis, "causal-conflict"],
      ["wrong-role-mail", projectedBasis, "authority-mismatch"],
    ] as const) {
      const result = await runtime.runPromise(
        repository
          .appendMessage({
            sink,
            basis,
            message: message(messageId, "agent", "must not commit"),
            sentBy: actor,
            destination: { kind: "mailbox" },
            originAt: observedAt,
            receivedAt: observedAt,
          })
          .pipe(Effect.result),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "WorkAuthorityError",
          reason,
        },
      });
    }

    expect(await runtime.runPromise(persistedState())).toEqual(before);
  });

  it("roundtrips the exact immutable intent basis on an emitted fact", async () => {
    const sink = { canvasName: "factory", nodeId: "basis-roundtrip" };
    const created = await runtime.runPromise(
      repository.appendMessage({
        sink,
        basis: authorialBasis,
        message: message(
          "basis-roundtrip-mail",
          "agent",
          "retain the admitting intent",
        ),
        sentBy: actor,
        destination: { kind: "mailbox" },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    expect(created.record.basis).toEqual(authorialBasis);
    const stored = (
      await runtime.runPromise(
        repository.recordsAfter({
          route: created.record.id.route,
        }),
      )
    ).find(
      (record) =>
        record.id.seq === created.record.id.seq &&
        record.contentSha256 === created.record.contentSha256,
    );
    expect(stored).toEqual(created.record);
    expect(stored?.recordType).toBe("fact");
    if (stored?.recordType === "fact") {
      expect(stored.basis).toEqual(authorialBasis);
    }
  });

  it("normalizes inbox messages and their delivery receipts", async () => {
    const inbox = { canvasName: "factory", nodeId: "inbox" };
    await runtime.runPromise(
      repository.appendMessage({
        sink: inbox,
        basis: authorialBasis,
        message: message("mail-1", "agent", "hello"),
        sentBy: actor,
        destination: { kind: "mailbox" },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(
      await runtime.runPromise(
        repository.hasAcceptedDelivery(inbox, "delivery-1"),
      ),
    ).toBe(false);
    await runtime.runPromise(
      repository.acceptDelivery({
        sink: inbox,
        basis: authorialBasis,
        receipt: {
          deliveryId: "delivery-1",
          deliveredItem: { kind: "message", itemId: "mail-1", sink: inbox },
          actor,
          acceptedAt: observedAt,
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(
      await runtime.runPromise(
        repository.hasAcceptedDelivery(inbox, "delivery-1"),
      ),
    ).toBe(true);

    expect(
      (
        await runtime.runPromise(
          repository.readSnapshot(inbox.canvasName, inbox.nodeId),
        )
      ).messages.items,
    ).toEqual([message("mail-1", "agent", "hello")]);
    expect(
      await runtime.runPromise(
        sql
          .unsafe<{ readonly actor_seat_id: string }>(
            `
                SELECT actor_seat_id
                FROM work_messages
                WHERE canvas_name = ? AND node_id = ? AND message_id = ?
              `,
            [inbox.canvasName, inbox.nodeId, "mail-1"],
          )
          .pipe(Effect.map((rows) => rows[0]?.actor_seat_id)),
      ),
    ).toBe(actor.seatId);
  });

  it("derives fact authority from the database singleton, never caller input", async () => {
    const sink = { canvasName: "factory", nodeId: "inbox-authority" };
    const attemptedOverride = {
      localInstallationId: remote,
      sink,
      basis: authorialBasis,
      message: message("mail-authority", "agent", "use canonical authority"),
      sentBy: actor,
      destination: { kind: "mailbox" as const },
      originAt: observedAt,
      receivedAt: observedAt,
    };
    const created = await runtime.runPromise(
      repository.appendMessage(attemptedOverride),
    );

    expect(created.record.id.route).toEqual({
      eventHome: cc,
      entityHome: cc,
    });
    expect(
      await runtime.runPromise(
        sql
          .unsafe<{ readonly entity_home: string }>(
            `
              SELECT entity_home
              FROM work_messages
              WHERE canvas_name = ? AND node_id = ? AND message_id = ?
            `,
            [sink.canvasName, sink.nodeId, "mail-authority"],
          )
          .pipe(Effect.map((rows) => rows[0]?.entity_home)),
      ),
    ).toBe(cc);
  });
});
