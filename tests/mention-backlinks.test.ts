// Backlinks (plan 03 section 3): each mail row's mentions are kept in
// `work_mentions` in the transaction that writes the row, the migration's
// rebuild from the rows makes the same table, and the window's read pages
// them newest first. Notices and copies are not where words were written.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import { InstallationId } from "../src/shared/installation-id";
import { NOTICE_SEAT_ID } from "../src/shared/mail-author";
import { mentionKey, mentionLink, type MentionRef } from "../src/shared/mention";
import { MENTION_COPY_OF_KEY, backlinkKeysOf } from "../src/shared/mention-backlinks";
import { asNodeId } from "../src/shared/physics/schema";
import { SUBJECT_NOTICE_KEY } from "../src/shared/subject-notice";
import { THREAD_SUBJECT_KEY } from "../src/shared/thread-subject";
import { ItemId } from "../src/shared/work-ids";
import { IntentFactBasis } from "../src/shared/work-protocol";
import { operatorActorRef } from "../src/shared/work-reference";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import {
  MENTIONABLE_TABLES_V46,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V45_IDENTITY,
  STATE_SCHEMA_V46_IDENTITY,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { MENTIONABLE, readMentions, rebuildMentions } from "../src/main/junto/work/mention-backlinks";
import { listMentions, type MentionIpcPorts } from "../src/main/junto/work/mentions";
import { WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { STATE_SCHEMA_V45_SQL, STATE_SCHEMA_V46_SQL } from "./fixtures/state-v13/schema";
import { seedCanvasRows } from "./support/seed-canvas";
import { canvasOf, page, seat, taskBoard } from "./support/model-nodes";
import { THIS_MACHINE } from "./support/machines";

const root = join(tmpdir(), `junto-mention-backlinks-${randomUUID()}`);
const file = join(root, "junto.db");
const runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(file)));

let repository: Context.Service.Shape<typeof WorkRepository>;
let sql: SqlClient.SqlClient;

const at = "2026-10-21T10:00:00.000Z";
const cc = Schema.decodeUnknownSync(InstallationId)("cc-mention-backlinks");
const basis = Schema.decodeUnknownSync(IntentFactBasis, { onExcessProperty: "error" })({ kind: "canvas", canvasName: "factory", seq: 1 });

const reviewer = asNodeId("agent-reviewer");
const builder = asNodeId("agent-builder");
const board = asNodeId("task-board");
const docs = asNodeId("page-docs");
const nodes = [seat(reviewer), seat(builder), taskBoard(board), page(docs)];
const taskId = Schema.decodeSync(ItemId)("01M5ESZPWMZZM3TZ88P6FVVK33");

const toReviewer: MentionRef = { kind: "seat", nodeId: reviewer };
const toTask: MentionRef = { kind: "task", nodeId: board, taskId };
const toPage: MentionRef = { kind: "page", nodeId: docs };
const link = (ref: MentionRef, label: string) => mentionLink(ref, label, "factory");

const builderRef = { seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${"b".repeat(64)}`), canvasName: "factory", nodeId: builder };

// ULIDs a millisecond apart, in the order written.
const ids = ["01M5FG0000AAAAAAAAAAAAAAA1", "01M5FG0001AAAAAAAAAAAAAAA2", "01M5FG0002AAAAAAAAAAAAAAA3", "01M5FG0003AAAAAAAAAAAAAAA4", "01M5FG0004AAAAAAAAAAAAAAA5", "01M5FG0005AAAAAAAAAAAAAAA6"];

const append = (
  nodeId: string,
  messageId: string,
  text: string,
  metadata: Record<string, unknown> = {},
  sentBy: { seatId: ActorSeatId; canvasName: string; nodeId: string } = builderRef,
) =>
  runtime.runPromise(
    repository.appendMessage({
      sink: { canvasName: "factory", nodeId },
      basis,
      message: { messageId, role: "user", parts: [{ kind: "text", text }], contextId: "factory", metadata: { factoryMail: true, ...metadata } },
      sentBy,
      destination: { kind: "mailbox" },
      originAt: at,
      receivedAt: at,
    }),
  );

const held = () =>
  runtime.runPromise(
    sql.unsafe<{ mention_key: string; node_id: string; message_id: string; at_ms: number }>(
      "SELECT mention_key, node_id, message_id, at_ms FROM work_mentions ORDER BY mention_key, message_id",
    ),
  );

beforeAll(async () => {
  repository = await runtime.runPromise(WorkRepository);
  sql = await runtime.runPromise(SqlClient.SqlClient);
  await runtime.runPromise(
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe("INSERT INTO known_installations(installation_id, registered_at) VALUES (?, ?)", [cc, at]);
        yield* sql.unsafe("INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ?, ?)", [cc, at]);
        yield* sql.unsafe(
          "INSERT INTO machine_configuration(singleton, machine_name, supervised_preferred, configured_at) VALUES (1, ?, 1, ?)",
          [THIS_MACHINE, at],
        );
        yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", { nodes }]]) });
      }),
    ),
  );
  // Seat mail naming a seat and a task, the task twice: one backlink each.
  await append(reviewer, ids[0]!, `${link(toReviewer, "@reviewer")} see ${link(toTask, "#1 tabs")} and ${link(toTask, "#1 again")}`);
  // A comment on the task, naming the page, in a thread.
  await append(board, ids[1]!, `docs at ${link(toPage, "@docs")}`, {
    [THREAD_SUBJECT_KEY]: { kind: "task", nodeId: board, taskId },
    threadId: ids[1],
  });
  // Its notice to the reviewer, and a copy of it: neither is a place.
  await append(reviewer, ids[2]!, `docs at ${link(toPage, "@docs")}`, { [SUBJECT_NOTICE_KEY]: "mention", threadId: ids[1] });
  await append(builder, ids[3]!, `docs at ${link(toPage, "@docs")}`, { [MENTION_COPY_OF_KEY]: ids[1], threadId: ids[1] });
  // The operator names the reviewer, then a node of no mentionable kind and a gone node name nothing.
  await append(builder, ids[4]!, `ask ${link(toReviewer, "@reviewer")}`, {}, operatorActorRef("factory"));
  await append(builder, ids[5]!, `[x](junto://canvas/factory?node=agent-gone) plain words`);
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

describe("state step 45 to 46: the backlinks table", () => {
  it("starts from the version-45 witness and ends at the version-46 one", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V45_SQL)).toEqual(STATE_SCHEMA_V45_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V46_SQL)).toEqual(STATE_SCHEMA_V46_IDENTITY);
  });

  it("backfills from its own frozen kind tables, which are today's at 46", () => {
    expect(MENTIONABLE_TABLES_V46).toEqual(MENTIONABLE);
  });

  it("adds work_mentions and nothing else", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(STATE_SCHEMA_V45_SQL);
      const tables = () => (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
      const before = tables();
      STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 46)!.migrate(database);
      expect(tables().filter((name) => !before.includes(name))).toEqual(["work_mentions"]);
    } finally {
      database.close();
    }
  });
});

describe("backlinks", () => {
  it("keeps one row per thing a written row mentions, and none for notices, copies or names of nothing", async () => {
    expect(await held()).toEqual(
      [
        { mention_key: mentionKey(toPage), node_id: board, message_id: ids[1]!, at_ms: expect.any(Number) },
        { mention_key: mentionKey(toReviewer), node_id: reviewer, message_id: ids[0]!, at_ms: expect.any(Number) },
        { mention_key: mentionKey(toReviewer), node_id: builder, message_id: ids[4]!, at_ms: expect.any(Number) },
        { mention_key: mentionKey(toTask), node_id: reviewer, message_id: ids[0]!, at_ms: expect.any(Number) },
      ].sort((a, b) => a.mention_key.localeCompare(b.mention_key) || a.message_id.localeCompare(b.message_id)),
    );
  });

  it("a resource's notice mentions nothing, whatever its words", () => {
    const words = { kind: "text", text: link(toReviewer, "@reviewer") };
    const kindOf = () => "agent" as const;
    expect(backlinkKeysOf({ actorSeatId: NOTICE_SEAT_ID, parts: [words] }, kindOf)).toEqual([]);
    expect(backlinkKeysOf({ actorSeatId: builderRef.seatId, parts: [words] }, kindOf)).toEqual([mentionKey(toReviewer)]);
  });

  it("rebuilds from the mail rows to exactly what the writers kept", async () => {
    const kept = await held();
    const database = new DatabaseSync(file);
    try {
      database.exec("BEGIN IMMEDIATE");
      rebuildMentions(database);
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    expect(await held()).toEqual(kept);
  });

  it("reads newest first, a page at a time, with who wrote it, its thread and its subject", async () => {
    const ports: MentionIpcPorts = {
      topology: () => Effect.succeed(canvasOf(nodes)),
      read: (canvasName, key, limit, after) => readMentions(sql, canvasName, key, limit, after).pipe(Effect.orDie),
    };
    const first = await runtime.runPromise(listMentions(ports, { canvasName: "factory", target: toReviewer, page: { limit: 1 } }));
    expect(first.entries).toEqual([
      { messageId: ids[4], threadId: ids[4], mailbox: builder, author: { kind: "operator", name: "operator" }, at: expect.any(Number) },
    ]);
    expect(first.next).toBeDefined();
    const second = await runtime.runPromise(
      listMentions(ports, { canvasName: "factory", target: toReviewer, page: { limit: 1, before: first.next! } }),
    );
    expect(second.entries).toEqual([
      {
        messageId: ids[0],
        threadId: ids[0],
        mailbox: reviewer,
        author: { kind: "seat", seatId: builderRef.seatId, nodeId: builder, name: expect.any(String) },
        at: expect.any(Number),
      },
    ]);
    expect(second.next).toBeUndefined();
    expect(second.entries[0]!.at).toBeLessThan(first.entries[0]!.at);

    const onPage = await runtime.runPromise(listMentions(ports, { canvasName: "factory", target: toPage }));
    expect(onPage.entries.map((entry) => [entry.messageId, entry.threadId, entry.mailbox, entry.subject])).toEqual([
      [ids[1], ids[1], board, { kind: "task", nodeId: board, taskId }],
    ]);
  });

  it("refuses a cursor it did not give", async () => {
    const ports: MentionIpcPorts = { topology: () => Effect.die("unread"), read: () => Effect.die("unread") };
    const refused = await runtime.runPromise(
      Effect.flip(listMentions(ports, { canvasName: "factory", target: toReviewer, page: { before: "bm90IGEgY3Vyc29y" } })),
    );
    expect(refused.type).toBe("InputError");
  });
});
