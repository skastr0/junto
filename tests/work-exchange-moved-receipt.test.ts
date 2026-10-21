/**
 * A seat that moves between two machines has its mail typed on each, and each
 * machine writes the receipt under the same id: the id names the mail and the
 * seat, never the machine, so any machine can tell the mail was typed. The
 * editing machine holds the first machine's receipt; the second's is a repeat
 * it absorbs, and the link stays open. One id for other mail is refused.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ExchangeClosed, makeRowExchange, type RowExchange } from "../src/main/junto/work/exchange/session";
import { mailboxMessageDeliveryId } from "../src/main/junto/work/mailbox-receipts";
import { WorkRepository, WorkRepositoryLive, workRecordContentSha256 } from "../src/main/junto/work/repository";
import { EXCHANGE_ROWS_PAGE_BYTES } from "../src/shared/exchange-bounds";
import { InstallationId } from "../src/shared/installation-id";
import type { CanvasPlacement, ExchangeFrame, RowsFrame } from "../src/shared/work-exchange";
import { ActorSeatId, type ActorRef } from "../src/shared/work-protocol";
import { seedCanvasRows } from "./support/seed-canvas";
import { seat } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook");
const M2 = id("m2");
const M3 = id("m3");
const at = "2026-10-21T12:00:00.000Z";

/** `lead` lives on the editing machine; `mover` starts on M2 and moves to M3. */
const homes: Record<string, InstallationId> = { lead: EDITOR, mover: M2 };
const actor = (nodeId: string): ActorRef => ({
  seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${(Object.keys(homes).indexOf(nodeId) + 1).toString().repeat(64)}`),
  canvasName: "factory",
  nodeId,
});
const placement: CanvasPlacement = {
  canvasId: "canvas-factory",
  editor: EDITOR,
  holds: () => true,
  seatOf: (nodeId) => (homes[nodeId] === undefined ? undefined : { seatId: actor(nodeId).seatId, machine: homes[nodeId]! }),
};

type Machine = {
  readonly self: InstallationId;
  readonly root: string;
  readonly runtime: ManagedRuntime.ManagedRuntime<WorkRepository | SqlClient.SqlClient, unknown>;
  readonly repository: typeof WorkRepository.Service;
  readonly exchange: RowExchange;
};

const queue: Array<{ readonly from: InstallationId; readonly to: InstallationId; readonly frame: unknown }> = [];
const machines = new Map<InstallationId, Machine>();

const boot = async (self: InstallationId): Promise<Machine> => {
  const root = join(tmpdir(), `junto-moved-receipt-${self}-${randomUUID()}`);
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
            canvases: new Map([["factory", { nodes: Object.keys(homes).map((nodeId, index) => seat(nodeId, { y: index * 120 })) }]]),
          });
        }),
      );
    }),
  );
  const exchange = makeRowExchange({
    self,
    repository,
    canvases: Effect.succeed(["factory"]),
    placement: (canvasName) => Effect.succeed(canvasName === "factory" ? placement : undefined),
    mailArrived: () => {},
    commandArrived: () => {},
    cutCopy: () => Effect.succeed(undefined),
    copySent: () => Effect.void,
    installCopy: () => Effect.die("no copy is sent between these machines"),
    signals: () => Effect.succeed([]),
    takeSignal: () => Effect.die("no signal is stated between these machines"),
  });
  const machine: Machine = { self, root, runtime, repository, exchange };
  machines.set(self, machine);
  return machine;
};

const link = async (left: Machine, right: Machine): Promise<void> => {
  const end = (from: Machine, to: Machine) => ({
    peer: to.self,
    send: (frame: ExchangeFrame) =>
      Effect.sync(() => {
        queue.push({ from: from.self, to: to.self, frame: JSON.parse(JSON.stringify(frame)) });
      }),
  });
  await left.runtime.runPromise(left.exchange.opened(end(left, right)));
  await right.runtime.runPromise(right.exchange.opened(end(right, left)));
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

const send = (on: Machine, from: string, to: string, messageId: string) =>
  on.runtime.runPromise(
    on.repository.appendMessage({
      sink: { canvasName: "factory", nodeId: to },
      basis: { kind: "canvas", canvasName: "factory", seq: on.self === EDITOR ? 1 : 2 },
      message: { messageId, role: "agent", parts: [{ kind: "text", text: `from ${from}` }] },
      sentBy: actor(from),
      destination: { kind: "mailbox" },
      originAt: at,
      receivedAt: at,
    }),
  );

/** The seat's machine types the mail into it and writes the receipt, under the one id every machine derives. */
const typed = (on: Machine, messageId: string, count: number) => {
  const sink = { canvasName: "factory", nodeId: "mover" };
  return on.runtime.runPromise(
    on.repository.acceptDelivery({
      sink,
      basis: { kind: "canvas", canvasName: "factory", seq: count },
      receipt: {
        deliveryId: mailboxMessageDeliveryId("factory", "mover", messageId),
        deliveredItem: { kind: "message", sink, itemId: messageId },
        actor: actor("mover"),
        acceptedAt: at,
      },
      originAt: at,
      receivedAt: at,
    }),
  );
};

const receipts = (on: Machine) =>
  on.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.unsafe<{ delivery_id: string; delivered_item_id: string; fact_event_home: string }>(
        "SELECT delivery_id, delivered_item_id, fact_event_home FROM work_delivery_receipts WHERE delivered_node_id = 'mover' ORDER BY delivered_item_id",
      );
    }),
  );

const inbox = async (on: Machine, nodeId: string): Promise<string[]> =>
  (await on.runtime.runPromise(on.repository.mailbox("factory", nodeId))).map((message) => message.messageId);

const throughOf = async (on: Machine, writer: InstallationId) =>
  (await on.runtime.runPromise(on.repository.exchangeHave("factory"))).find((cursor) => cursor.writer === writer)?.through;

let editor: Machine;
let m2: Machine;
let m3: Machine;

beforeAll(async () => {
  editor = await boot(EDITOR);
  m2 = await boot(M2);
  m3 = await boot(M3);
  const seatsAt = () => Object.keys(homes).map((nodeId) => ({ nodeId, seatId: actor(nodeId).seatId, machine: homes[nodeId]! }));
  for (const target of [M2, M3]) {
    await editor.runtime.runPromise(editor.repository.recordCanvasCopySent({ canvasName: "factory", target, seq: 1, seats: seatsAt(), sentAt: at }));
  }
  // The seat takes its mail on M2, and M2's receipt reaches the editing machine.
  await send(editor, "lead", "mover", "typed-on-both");
  await link(editor, m2);
  await settle();
  await typed(m2, "typed-on-both", 1);
  await m2.runtime.runPromise(m2.exchange.committed("factory"));
  await settle();
  // At count 2 the seat moves to M3, which types the mail again: it never held M2's receipt.
  homes.mover = M3;
  for (const target of [M2, M3]) {
    await editor.runtime.runPromise(editor.repository.recordCanvasCopySent({ canvasName: "factory", target, seq: 2, seats: seatsAt(), sentAt: at }));
  }
  // M3 installs the copy at count 2 (tests/work-exchange-copy.test.ts sends copies).
  await m3.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE canvases SET seq = 2 WHERE canvas_name = 'factory'`;
    }),
  );
  await link(editor, m3);
  await settle();
  await typed(m3, "typed-on-both", 2);
});

afterAll(async () => {
  for (const machine of machines.values()) {
    await machine.runtime.dispose();
    await rm(machine.root, { recursive: true, force: true });
  }
});

describe("a seat that moves from M2 to M3", () => {
  it("keeps the link open: M3's receipt is absorbed as a repeat, and what M3 writes next reaches the editing machine", async () => {
    const held = await receipts(editor);
    expect(held).toEqual([
      { delivery_id: mailboxMessageDeliveryId("factory", "mover", "typed-on-both"), delivered_item_id: "typed-on-both", fact_event_home: M2 },
    ]);

    await m3.runtime.runPromise(m3.exchange.committed("factory"));
    await settle();
    // The seat raises something on M3 after the receipt: it crosses on the same link.
    await send(m3, "mover", "lead", "raised-on-m3");
    await m3.runtime.runPromise(m3.exchange.committed("factory"));
    await settle();

    expect(editor.exchange.linked(M3)).toBe(true);
    expect(m3.exchange.linked(EDITOR)).toBe(true);
    expect(await inbox(editor, "lead")).toContain("raised-on-m3");
    // M3's own receipt, sent straight to the editing machine, changed nothing: M2's row is the one held.
    expect(await receipts(editor)).toEqual(held);
    const own = await m3.runtime.runPromise(
      m3.repository.exchangeRows({ canvasName: "factory", writer: M3, after: "0", limit: 64, bytes: EXCHANGE_ROWS_PAGE_BYTES }),
    );
    expect(await throughOf(editor, M3)).toBe(own.through);
  });

  it("refuses a receipt under a held id for other mail", async () => {
    await send(editor, "lead", "mover", "other-mail");
    await settle();
    const page = await m3.runtime.runPromise(
      m3.repository.exchangeRows({ canvasName: "factory", writer: M3, after: "0", limit: 64, bytes: EXCHANGE_ROWS_PAGE_BYTES }),
    );
    const base = page.rows.map((row) => row.fact).find((fact) => fact.body.operation === "delivery.accepted")!;
    type Receipt = { receipt: { deliveredItem: { itemId: string } } };
    const body = base.body as unknown as Receipt;
    const seq = (BigInt(page.through) + 1n).toString();
    const { contentSha256: _hash, originAt, ...semantic } = {
      ...base,
      id: { ...base.id, seq },
      body: { ...body, receipt: { ...body.receipt, deliveredItem: { ...body.receipt.deliveredItem, itemId: "other-mail" } } },
    };
    const forged = { ...semantic, originAt, contentSha256: workRecordContentSha256(semantic as never) };
    const frame = { kind: "rows", canvasName: "factory", canvasId: "canvas-factory", writer: M3, facts: [forged], through: seq } as unknown as RowsFrame;

    const through = await throughOf(editor, M3);
    await expect(editor.runtime.runPromise(editor.exchange.receive(M3, frame))).rejects.toBeInstanceOf(ExchangeClosed);
    expect(await throughOf(editor, M3)).toBe(through);
    expect(await receipts(editor)).toEqual([
      { delivery_id: mailboxMessageDeliveryId("factory", "mover", "typed-on-both"), delivered_item_id: "typed-on-both", fact_event_home: M2 },
    ]);
  });
});
