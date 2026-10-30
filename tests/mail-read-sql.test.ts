/**
 * The mail read worker's reads (`mail-read-sql.ts`) answer what the
 * repository's do: the same mailbox, oldest first, and the same sent mail,
 * each with the same receipts stamped. Both run here on one database file,
 * the worker's side over its own read-only connection, as it runs in the app.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { Command } from "../src/shared/model";
import { ModelLive } from "../src/main/junto/model/layer";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { ModelService } from "../src/main/junto/model/service";
import { ModelActorRefs } from "../src/main/junto/model/actor-refs";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { mailboxMessageDeliveryId, mailboxMessageReadId } from "../src/main/junto/work/mailbox-receipts";
import { canvasReceiptBasis, stampMailboxDeliveryReceipt } from "../src/main/junto/work/delivery-receipts";
import { readInbox, readInboxPage, readSentBy, readSentByPage, pageOfInbox, pageOfSent } from "../src/main/junto/work/mail-read-sql";
import { THIS_MACHINE } from "./support/machines";
import { NoTasksLive } from "./support/no-tasks";

it("the worker's mailbox and sent-mail reads equal the repository's on one database", async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-mail-read-sql-"));
  const path = join(root, "junto.db");
  const modelLive = Layer.provideMerge(Layer.provide(ModelLive, ModelDependents.empty), makeStateEngineLive(path));
  const runtime = ManagedRuntime.make(Layer.provideMerge(Layer.mergeAll(WorkRepositoryLive, NoTasksLive), modelLive));
  try {
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    await runtime.runPromise(sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO known_installations VALUES ('read-home','2026-10-29')`;
      yield* sql`INSERT INTO installation VALUES (1,'read-home','2026-10-29')`;
      yield* sql`INSERT INTO machine_configuration(singleton, machine_name, supervised_preferred, configured_at) VALUES (1, ${THIS_MACHINE}, 1, '2026-10-29')`;
    })));
    const model = await runtime.runPromise(ModelService);
    const repo = await runtime.runPromise(WorkRepository);
    const refs = await runtime.runPromise(ModelActorRefs);
    const command = Schema.decodeUnknownSync(Command);
    await runtime.runPromise(model.command(command({ _tag: "CreateCanvas", canvas: "factory" }), "operator"));
    await runtime.runPromise(model.command(command({ _tag: "Add", canvas: "factory", nodes: ["ada", "bo", "cy"].map((id) => ({
      kind: "agent", id, x: 0, y: 0, width: 200, height: 100, z: 0, label: id,
      agentKey: `local:${id}`, bindingId: `binding-${id}`, host: THIS_MACHINE, harness: "claude", overseer: false,
    })), wires: [] }), "operator"));
    const actors = await runtime.runPromise(refs.read("factory"));
    const actor = (id: string) => actors.find((ref) => ref.nodeId === id)!;
    const send = (from: string, to: string, messageId: string, extra: Record<string, unknown> = {}) =>
      runtime.runPromise(repo.appendMessage({
        sink: { canvasName: "factory", nodeId: to },
        basis: canvasReceiptBasis({ canvasName: "factory", seq: 1 }),
        sentBy: actor(from), destination: { kind: "mailbox" },
        message: {
          messageId, role: "user", parts: [{ kind: "text", text: `${from} to ${to}` }],
          contextId: "factory", metadata: { senderNodeId: from, fromSeat: actor(from).seatId, ...extra },
        },
      }));
    await send("ada", "bo", "01M65000000000000000000001");
    await send("bo", "ada", "01M65000000000000000000002", { threadId: "01M65000000000000000000001" });
    await send("ada", "cy", "01M65000000000000000000003");
    await send("cy", "bo", "01M65000000000000000000004");
    await send("ada", "bo", "01M65000000000000000000005");
    // Receipts on mail ada sent: delivered and read on one, delivered on another.
    for (const [node, id, receipt] of [
      ["bo", "01M65000000000000000000001", mailboxMessageDeliveryId],
      ["bo", "01M65000000000000000000001", mailboxMessageReadId],
      ["cy", "01M65000000000000000000003", mailboxMessageDeliveryId],
      ["ada", "01M65000000000000000000002", mailboxMessageDeliveryId],
    ] as const) {
      expect(await runtime.runPromise(stampMailboxDeliveryReceipt({
        canvas: "factory", nodeId: node, messageId: id, deliveryId: receipt("factory", node, id),
      }))).toBe(true);
    }

    const database = new DatabaseSync(path, { open: true, readOnly: true });
    try {
      for (const nodeId of ["ada", "bo", "cy"]) {
        expect(readInbox(database, "factory", nodeId)).toEqual(await runtime.runPromise(repo.mailbox("factory", nodeId)));
      }
      const byId = <T extends { readonly message: { readonly messageId: string } }>(rows: ReadonlyArray<T>) =>
        [...rows].sort((a, b) => a.message.messageId.localeCompare(b.message.messageId));
      for (const sender of ["ada", "bo", "cy"]) {
        expect(byId(readSentBy(database, "factory", sender))).toEqual(byId(await runtime.runPromise(repo.mailSentBy("factory", sender))));
      }
      const adaSent = readSentBy(database, "factory", "ada");
      expect(adaSent.map((row) => row.message.messageId).sort()).toEqual([
        "01M65000000000000000000001", "01M65000000000000000000003", "01M65000000000000000000005",
      ]);
      const first = adaSent.find((row) => row.message.messageId === "01M65000000000000000000001")!;
      expect(first.message.metadata?.deliveredAt).toBeTypeOf("number");
      expect(first.message.metadata?.readAt).toBeTypeOf("number");
    } finally {
      database.close();
    }
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it("the worker's page reads answer the page of the whole read, stamps included", async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-mail-read-page-"));
  const path = join(root, "junto.db");
  const modelLive = Layer.provideMerge(Layer.provide(ModelLive, ModelDependents.empty), makeStateEngineLive(path));
  const runtime = ManagedRuntime.make(Layer.provideMerge(Layer.mergeAll(WorkRepositoryLive, NoTasksLive), modelLive));
  try {
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    await runtime.runPromise(sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO known_installations VALUES ('read-home','2026-10-29')`;
      yield* sql`INSERT INTO installation VALUES (1,'read-home','2026-10-29')`;
      yield* sql`INSERT INTO machine_configuration(singleton, machine_name, supervised_preferred, configured_at) VALUES (1, ${THIS_MACHINE}, 1, '2026-10-29')`;
    })));
    const model = await runtime.runPromise(ModelService);
    const repo = await runtime.runPromise(WorkRepository);
    const refs = await runtime.runPromise(ModelActorRefs);
    const command = Schema.decodeUnknownSync(Command);
    await runtime.runPromise(model.command(command({ _tag: "CreateCanvas", canvas: "factory" }), "operator"));
    await runtime.runPromise(model.command(command({ _tag: "Add", canvas: "factory", nodes: ["ada", "bo", "cy"].map((id) => ({
      kind: "agent", id, x: 0, y: 0, width: 200, height: 100, z: 0, label: id,
      agentKey: `local:${id}`, bindingId: `binding-${id}`, host: THIS_MACHINE, harness: "claude", overseer: false,
    })), wires: [] }), "operator"));
    const actors = await runtime.runPromise(refs.read("factory"));
    const actor = (id: string) => actors.find((ref) => ref.nodeId === id)!;
    const send = (from: string, to: string, messageId: string) =>
      runtime.runPromise(repo.appendMessage({
        sink: { canvasName: "factory", nodeId: to },
        basis: canvasReceiptBasis({ canvasName: "factory", seq: 1 }),
        sentBy: actor(from), destination: { kind: "mailbox" },
        message: {
          messageId, role: "user", parts: [{ kind: "text", text: `${from} to ${to}` }],
          contextId: "factory", metadata: { senderNodeId: from, fromSeat: actor(from).seatId },
        },
      }));
    const ids = [
      "01M65000000000000000000011", "01M65000000000000000000012", "01M65000000000000000000013",
      "01M65000000000000000000014", "01M65000000000000000000015",
    ];
    for (const id of ids) await send("ada", "bo", id);
    await send("bo", "ada", "01M65000000000000000000016");
    for (const id of ids.slice(-2)) {
      expect(await runtime.runPromise(stampMailboxDeliveryReceipt({
        canvas: "factory", nodeId: "bo", messageId: id,
        deliveryId: mailboxMessageDeliveryId("factory", "bo", id),
      }))).toBe(true);
    }

    const database = new DatabaseSync(path, { open: true, readOnly: true });
    try {
      const query = { limit: 2, filter: {} } as const;
      const whole = pageOfInbox(readInbox(database, "factory", "bo"), { limit: 2, filter: {} });
      const page = readInboxPage(database, "factory", "bo", { limit: 2, filter: {} });
      expect(page).toEqual(whole);
      expect(page.items).toHaveLength(2);
      expect(page).toMatchObject({ more: true, remaining: 3 });
      // The page carries its stamps: delivered on the two mailed first, nil on the rest.
      for (const item of page.items) expect(item.metadata?.deliveredAt).toBeTypeOf("number");

      const cursor = page.items[1]?.messageId;
      const next = readInboxPage(database, "factory", "bo", { limit: 2, before: cursor, filter: {} });
      expect(next).toEqual(pageOfInbox(readInbox(database, "factory", "bo"), { limit: 2, before: cursor, filter: {} }));

      expect(readSentByPage(database, "factory", "ada", query)).toEqual(
        pageOfSent(readSentBy(database, "factory", "ada"), query),
      );
      // The keyset pages the same order and remainder as the whole read, with
      // the cursor too: 5 sent, 2 a page, 3 left.
      const sentPage = readSentByPage(database, "factory", "ada", { limit: 2, filter: {} });
      expect(sentPage).toEqual(pageOfSent(readSentBy(database, "factory", "ada"), { limit: 2, filter: {} }));
      expect(sentPage.items).toHaveLength(2);
      expect(sentPage).toMatchObject({ more: true, remaining: 3 });
      const afterCursor = readSentByPage(database, "factory", "ada", {
        limit: 2, before: sentPage.items[1]!.message.messageId, filter: {},
      });
      expect(afterCursor).toEqual(pageOfSent(readSentBy(database, "factory", "ada"), {
        limit: 2, before: sentPage.items[1]!.message.messageId, filter: {},
      }));
      expect(afterCursor).toMatchObject({ more: true, remaining: 1 });
      const lastPage = readSentByPage(database, "factory", "ada", {
        limit: 2, before: afterCursor.items[1]!.message.messageId, filter: {},
      });
      expect(lastPage).toMatchObject({ more: false, remaining: 0 });
      expect(lastPage.items).toHaveLength(1);
      const filtered = readInboxPage(database, "factory", "bo", { limit: 50, filter: { text: "ada to bo" } });
      expect(filtered.items).toHaveLength(5);
      expect(filtered).toEqual(pageOfInbox(readInbox(database, "factory", "bo"), { limit: 50, filter: { text: "ada to bo" } }));
    } finally {
      database.close();
    }
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
