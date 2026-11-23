/**
 * A seat's answer to the operator from a machine that does not edit the
 * canvas (docs/machines.md rule 4, docs/security-doctrine.md). Two real
 * stores, the editing machine and the mini, under a temporary home: the
 * operator's mail is written on the editing machine and crosses to the seat's
 * machine, the seat's answer is written there and crosses back. One rule
 * (src/shared/operator-reply.ts) decides an answer on both sides: the mini's
 * write refuses what the editing machine's frame loop would close the link on.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { monotonicFactory } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/core/state/engine";
import { makeRowExchange, type RowExchange } from "../src/core/work/exchange/session";
import { WorkRepository, WorkRepositoryLive, workRecordContentSha256 } from "../src/core/work/repository";
import { InstallationId } from "../src/shared/installation-id";
import { isPendingDelivery } from "../src/shared/message-delivery";
import { seatMailThreads } from "../src/shared/mail-threads";
import { OPERATOR_REPLY_REFUSAL, operatorReplyFault } from "../src/shared/operator-reply";
import { threadSubjectMetadata } from "../src/shared/thread-subject";
import { encodeExchangeFrame, type CanvasPlacement, type ExchangeFact, type ExchangeFrame, type RowsFrame } from "../src/shared/work-exchange";
import type { Message } from "../src/shared/work-model";
import { ActorSeatId, WORK_PROTOCOL, type ActorRef } from "../src/shared/work-protocol";
import { OPERATOR_SEAT_ID, operatorActorRef } from "../src/shared/work-reference";
import { seedCanvasRows } from "./support/seed-canvas";
import { seat, taskBoard } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook");
const MINI = id("mini");
const at = "2026-11-23T12:00:00.000Z";
const basis = { kind: "canvas" as const, canvasName: "factory", seq: 1 };
const ulid = monotonicFactory();

/** `lead` lives on the editing machine, `peer` and `peer-two` on the mini. */
const homes: Record<string, InstallationId> = { lead: EDITOR, peer: MINI, "peer-two": MINI };
/** The seats' names as the editing machine's canvas gives them. */
const NAMES: Record<string, string> = { lead: "lead", peer: "Peer on the mini", "peer-two": "Second peer" };
const actor = (nodeId: string): ActorRef => ({
  seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${(Object.keys(homes).indexOf(nodeId) + 1).toString().repeat(64)}`),
  canvasName: "factory",
  nodeId,
});
const placement: CanvasPlacement = {
  canvasId: "canvas-factory",
  editor: EDITOR,
  holds: (machine) => machine === EDITOR || machine === MINI,
  seatOf: (nodeId) => (homes[nodeId] === undefined ? undefined : { seatId: actor(nodeId).seatId, machine: homes[nodeId]! }),
};

type Machine = {
  readonly self: InstallationId;
  readonly root: string;
  readonly runtime: ManagedRuntime.ManagedRuntime<WorkRepository | SqlClient.SqlClient, unknown>;
  readonly repository: Context.Service.Shape<typeof WorkRepository>;
  readonly exchange: RowExchange;
  readonly arrived: Array<Message>;
};

const queue: Array<{ readonly from: InstallationId; readonly to: InstallationId; readonly frame: unknown }> = [];
const machines = new Map<InstallationId, Machine>();

const boot = async (self: InstallationId): Promise<Machine> => {
  const root = join(tmpdir(), `junto-operator-reply-${self}-${randomUUID()}`);
  const runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(join(root, "junto.db"))));
  const repository = await runtime.runPromise(WorkRepository);
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${self}, ${at})`;
          yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${self}, ${at})`;
          yield* seedCanvasRows({
            seq: 1,
            canvases: new Map([["factory", {
              nodes: [...Object.keys(homes).map((nodeId, index) => seat(nodeId, { y: index * 120 })), taskBoard("board", { y: 1200 })],
            }]]),
          });
        }),
      );
    }),
  );
  const arrived: Machine["arrived"] = [];
  const exchange = makeRowExchange({
    self,
    repository,
    canvases: Effect.succeed(["factory"]),
    placement: () => Effect.succeed(placement),
    mailArrived: (_canvas, _nodeId, message: Message) => arrived.push(message),
    commandArrived: () => undefined,
    cutCopy: () => Effect.succeed(undefined),
    copySent: () => Effect.void,
    installCopy: () => Effect.die("no copy is sent between these machines"),
    signals: () => Effect.succeed([]),
    takeSignal: () => Effect.die("no signal is stated between these machines"),
  });
  const machine: Machine = { self, root, runtime, repository, exchange, arrived };
  machines.set(self, machine);
  return machine;
};

const link = async (left: Machine, right: Machine): Promise<void> => {
  const end = (from: Machine, to: Machine) => ({
    peer: to.self,
    send: (frame: ExchangeFrame) =>
      Effect.sync(() => {
        queue.push({ from: from.self, to: to.self, frame: JSON.parse(JSON.stringify(encodeExchangeFrame(frame))) });
      }),
  });
  await left.runtime.runPromise(left.exchange.opened(end(left, right)));
  await right.runtime.runPromise(right.exchange.opened(end(right, left)));
};

const unlink = (left: Machine, right: Machine): void => {
  left.exchange.closed(right.self);
  right.exchange.closed(left.self);
};

const settle = async (): Promise<void> => {
  const quiet = async () => {
    for (const machine of machines.values()) await machine.runtime.runPromise(machine.exchange.quiet);
  };
  for (await quiet(); queue.length > 0; await quiet()) {
    const next = queue.shift()!;
    const to = machines.get(next.to)!;
    if (to.exchange.linked(next.from)) await to.runtime.runPromise(to.exchange.receive(next.from, next.frame));
  }
};

const mailbox = async (on: Machine, nodeId: string): Promise<ReadonlyArray<Message>> =>
  on.runtime.runPromise(on.repository.mailbox("factory", nodeId));

const write = (on: Machine, sentBy: ActorRef, mailboxNode: string, message: Message) =>
  on.runtime.runPromise(
    on.repository.appendMessage({
      sink: { canvasName: "factory", nodeId: mailboxNode },
      basis,
      message,
      sentBy,
      destination: { kind: "mailbox" },
      originAt: at,
      receivedAt: at,
    }).pipe(Effect.result),
  );

/** The operator's mail into a seat, as the window writes it on the editing machine. */
const operatorMail = (messageId: string, extra: Record<string, unknown> = {}): Message => ({
  messageId,
  role: "user",
  parts: [{ kind: "text", text: "what is left?" }],
  contextId: "factory",
  metadata: { factoryMail: true, senderName: "operator", ...extra },
});

/** A seat's answer to the operator, as `junto msg reply` writes it on the seat's machine. */
const answer = (parent: string, extra: Record<string, unknown> = {}, shape: Partial<Message> = {}): Message => ({
  messageId: ulid(),
  role: "agent",
  parts: [{ kind: "text", text: "nothing, done" }],
  contextId: "factory",
  metadata: { factoryMail: true, senderName: "peer", toNodeId: "operator", inReplyTo: parent, threadId: parent, ...extra },
  ...shape,
});

const counts = (on: Machine) =>
  on.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe<{ facts: number; mail: number; receipts: number; cursor: string | null }>(
        `SELECT (SELECT count(*) FROM work_facts) AS facts, (SELECT count(*) FROM work_messages) AS mail,
          (SELECT count(*) FROM work_delivery_receipts) AS receipts,
          (SELECT through FROM work_exchange_cursors WHERE canvas_name = 'factory' AND writer = '${MINI}') AS cursor`,
      );
      return rows[0]!;
    }),
  );

/** One row the mini says it wrote, past every row the editing machine holds from it, its hash matching. */
const miniRow = async (sentBy: ActorRef, mailboxNode: string, message: Message): Promise<RowsFrame> => {
  const through = (await counts(editor)).cursor ?? "0";
  const seq = String(BigInt(through) + 1n);
  const semantic = {
    protocol: WORK_PROTOCOL,
    id: { route: { eventHome: MINI, entityHome: MINI }, seq },
    recordType: "fact",
    basis,
    item: { kind: "message", itemId: message.messageId, sink: { canvasName: "factory", nodeId: mailboxNode } },
    operation: "message.append",
    predecessor: null,
    body: { operation: "message.append", message, sentBy, destination: { kind: "mailbox" } },
  };
  const fact = { ...semantic, originAt: at, contentSha256: workRecordContentSha256(semantic as never) } as unknown as ExchangeFact;
  return { kind: "rows", canvasName: "factory", canvasId: "canvas-factory", writer: MINI, after: through, facts: [fact], through: seq } as RowsFrame;
};

/** Does the editing machine's frame loop take the row from the mini? A refusal writes nothing and moves no cursor. */
const editorTakes = async (sentBy: ActorRef, mailboxNode: string, message: Message): Promise<{ taken: boolean; refusal?: string }> => {
  const before = await counts(editor);
  const frame = await miniRow(sentBy, mailboxNode, message);
  const outcome = await editor.runtime.runPromise(
    editor.repository.applyExchangeRows({ peer: MINI, frame, placement, receivedAt: at }).pipe(Effect.result),
  );
  if (outcome._tag === "Success") return { taken: true };
  expect(await counts(editor)).toEqual(before);
  return { taken: false, refusal: String((outcome.failure as { message?: unknown }).message) };
};

let editor: Machine;
let mini: Machine;
/** Mail the editing machine wrote, crossed to the mini before any case runs. */
const ASKED = { peer: ulid(), other: ulid(), task: ulid(), seat: ulid() };

beforeAll(async () => {
  editor = await boot(EDITOR);
  mini = await boot(MINI);
  await editor.runtime.runPromise(
    editor.repository.recordCanvasCopySent({
      canvasName: "factory",
      target: MINI,
      seq: 1,
      seats: Object.keys(homes).map((nodeId) => ({ nodeId, seatId: actor(nodeId).seatId, machine: homes[nodeId]! })),
      sentAt: at,
    }),
  );
  const operator = operatorActorRef("factory");
  for (const [sentBy, node, message] of [
    [operator, "peer", operatorMail(ASKED.peer)],
    [operator, "peer-two", operatorMail(ASKED.other)],
    [operator, "peer", operatorMail(ASKED.task, threadSubjectMetadata({ kind: "task", nodeId: "board", taskId: "01M5ESR42S7P9YNR8FEH0TD2QC" } as never))],
    [actor("lead"), "peer", { ...operatorMail(ASKED.seat), metadata: { factoryMail: true } }],
  ] as const) {
    const written = await write(editor, sentBy, node, message);
    expect(written._tag).toBe("Success");
  }
  await link(editor, mini);
  await settle();
  unlink(editor, mini);
  expect((await mailbox(mini, "peer")).map((message) => message.messageId)).toEqual([ASKED.peer, ASKED.task, ASKED.seat]);
});

afterAll(async () => {
  for (const machine of machines.values()) {
    await machine.runtime.dispose();
    await rm(machine.root, { recursive: true, force: true });
  }
});

describe("a seat on the mini answers the operator", () => {
  it("is accepted on the mini with the link down, and shows in the operator's thread, unread, when a link opens", async () => {
    const reply = answer(ASKED.peer);
    expect((await write(mini, actor("peer"), "peer", reply))._tag).toBe("Success");
    expect((await mailbox(editor, "peer")).map((message) => message.messageId)).not.toContain(reply.messageId);

    await link(editor, mini);
    await settle();
    unlink(editor, mini);

    const held = await mailbox(editor, "peer");
    expect(held.map((message) => message.messageId)).toContain(reply.messageId);
    const threads = seatMailThreads({ mailboxes: [{ nodeId: "peer", messages: held }], nameOf: (nodeId) => NAMES[nodeId] }, "peer");
    const thread = threads.find((summary) => summary.threadId === ASKED.peer)!;
    expect(thread.messageCount).toBe(2);
    expect(thread.unread).toBe(1);
    expect(thread.last).toMatchObject({ messageId: reply.messageId, from: { kind: "seat", nodeId: "peer", name: "Peer on the mini" }, to: [{ kind: "operator" }] });
    // Never typed into a seat: delivery takes no agent-role row, so no receipt is written on either machine.
    const arrived = editor.arrived.find((message) => message.messageId === reply.messageId)!;
    expect(isPendingDelivery(arrived)).toBe(false);
    expect((await counts(editor)).receipts).toBe(0);
    expect((await counts(mini)).receipts).toBe(0);
  });

  it("is stored as the seat's, whatever its metadata says of its sender, and named from the editing machine's canvas", async () => {
    const reply = answer(ASKED.peer, { senderName: "operator", fromSeat: OPERATOR_SEAT_ID, senderNodeId: "operator" });
    expect((await write(mini, actor("peer"), "peer", reply))._tag).toBe("Success");
    await link(editor, mini);
    await settle();
    unlink(editor, mini);
    const held = await mailbox(editor, "peer");
    const row = held.find((message) => message.messageId === reply.messageId)!;
    expect(row.metadata).toMatchObject({ fromSeat: actor("peer").seatId, senderNodeId: "peer" });
    const thread = seatMailThreads({ mailboxes: [{ nodeId: "peer", messages: held }], nameOf: (nodeId) => NAMES[nodeId] }, "peer")
      .find((summary) => summary.threadId === ASKED.peer)!;
    expect(thread.last).toMatchObject({ messageId: reply.messageId, from: { kind: "seat", nodeId: "peer", name: "Peer on the mini" }, mine: false });
  });
});

describe("a row that is no answer to the operator's mail: the mini refuses to write it, and the editing machine closes the link on it", () => {
  const peer = () => actor("peer");
  const table: ReadonlyArray<readonly [string, () => readonly [ActorRef, string, Message]]> = [
    ["names no mail it answers", () => {
      const { inReplyTo: _named, ...metadata } = answer(ASKED.peer).metadata!;
      return [peer(), "peer", { ...answer(ASKED.peer), metadata }];
    }],
    ["answers a seat's mail", () => [peer(), "peer", answer(ASKED.seat)]],
    ["answers the operator's mail in another seat's mailbox", () => [peer(), "peer", answer(ASKED.other)]],
    ["is not in the thread of the mail it answers", () => [peer(), "peer", answer(ASKED.peer, { threadId: ASKED.task })]],
    ["answers mail in a task's thread", () => [peer(), "peer", answer(ASKED.task, { threadId: ASKED.task })]],
    ["names a task", () => [peer(), "peer", answer(ASKED.peer, {}, { taskId: "task-1" })]],
    ["carries attachments", () => [peer(), "peer", answer(ASKED.peer, { attachments: [] })]],
    [
      "carries a part that is not text",
      () => [peer(), "peer", answer(ASKED.peer, {}, { parts: [{ kind: "text", text: "see" }, { kind: "url", url: "https://example.com/a" }] })],
    ],
    ["names the signal it is the mail of by an id that is not one", () => [peer(), "peer", answer(ASKED.peer, { raisedSignalId: "not-a-signal" })]],
    ["names the signal it is the mail of by more than one id", () => [peer(), "peer", answer(ASKED.peer, { raisedSignalId: [ASKED.peer] })]],
    ["names the operator from another seat's mailbox", () => [actor("peer-two"), "peer", answer(ASKED.peer)]],
    ["is user mail that names the operator", () => [peer(), "peer", answer(ASKED.peer, {}, { role: "user" })]],
  ];

  it.each(table)("%s", async (_case, row) => {
    const [sentBy, node, message] = row();
    const beforeMini = await counts(mini);
    const local = await write(mini, sentBy, node, message);
    expect(local._tag).toBe("Failure");
    expect(String((local as { failure?: { message?: unknown } }).failure?.message)).toBe(OPERATOR_REPLY_REFUSAL);
    expect(await counts(mini)).toEqual(beforeMini);

    const remote = await editorTakes(sentBy, node, message);
    expect(remote).toEqual({ taken: false, refusal: OPERATOR_REPLY_REFUSAL });
  });

  it("takes the honest answer on both sides with the same rule", async () => {
    const reply = answer(ASKED.peer);
    expect(operatorReplyFault({ mailbox: "peer", author: "peer", message: reply }, {
      actorSeatId: OPERATOR_SEAT_ID,
      message: (await mailbox(mini, "peer")).find((message) => message.messageId === ASKED.peer)!,
    })).toBeUndefined();
    expect(await editorTakes(actor("peer"), "peer", reply)).toEqual({ taken: true });
  });

  it("takes an answer that is the mail of a signal, named by one id", async () => {
    const reply = answer(ASKED.peer, { raisedSignalId: ulid() });
    expect((await write(mini, actor("peer"), "peer", reply))._tag).toBe("Success");
    expect(await editorTakes(actor("peer"), "peer", reply)).toEqual({ taken: true });
  });
});
