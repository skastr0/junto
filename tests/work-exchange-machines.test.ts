/**
 * The row exchange between real databases joined by an in-memory link: an
 * editing machine and two others. No mock of the work plane: each machine is
 * its own state engine and work repository, and rows cross only as frames.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ExchangeClosed, makeRowExchange, type RowExchange } from "../src/main/junto/work/exchange/session";
import { mailboxMessageDeliveryId } from "../src/main/junto/work/mailbox-receipts";
import { WorkRepository, WorkRepositoryLive, workRecordContentSha256 } from "../src/main/junto/work/repository";
import { InstallationId } from "../src/shared/installation-id";
import type { CanvasPlacement, ExchangeFrame, RowsFrame } from "../src/shared/work-exchange";
import type { Message } from "../src/shared/work-model";
import { ActorSeatId, type ActorRef } from "../src/shared/work-protocol";
import { seedCanvasRows } from "./support/seed-canvas";
import { seat } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook");
const MINI = id("mini");
const OTHER = id("other-mini");
const at = "2026-10-09T12:00:00.000Z";
const basis = { kind: "canvas" as const, canvasName: "factory", seq: 1 };

/** `lead` lives on the editing machine, `peer` and `peer-two` on the mini, `far` on a third machine. */
const homes: Record<string, InstallationId> = { lead: EDITOR, peer: MINI, "peer-two": MINI, far: OTHER };
const placement: CanvasPlacement = {
  editor: EDITOR,
  holds: (machine) => machine === EDITOR || Object.values(homes).includes(machine),
  seatOf: (nodeId) => (homes[nodeId] === undefined ? undefined : { seatId: actor(nodeId).seatId, machine: homes[nodeId]! }),
};
/** A second canvas that only the editing machine holds: its one seat is `lead`. */
const privatePlacement: CanvasPlacement = {
  editor: EDITOR,
  holds: (machine) => machine === EDITOR,
  seatOf: (nodeId) => (nodeId === "lead" ? { seatId: actor("lead").seatId, machine: EDITOR } : undefined),
};
const actor = (nodeId: string): ActorRef => ({
  seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${(Object.keys(homes).indexOf(nodeId) + 1).toString().repeat(64)}`),
  canvasName: "factory",
  nodeId,
});

type Queued = { readonly from: InstallationId; readonly to: InstallationId; readonly frame: unknown };

type Machine = {
  readonly self: InstallationId;
  readonly root: string;
  readonly runtime: ManagedRuntime.ManagedRuntime<WorkRepository | SqlClient.SqlClient, unknown>;
  readonly repository: Context.Service.Shape<typeof WorkRepository>;
  readonly exchange: RowExchange;
  readonly arrived: Array<{ nodeId: string; messageId: string }>;
};

const queue: Queued[] = [];
const machines = new Map<InstallationId, Machine>();

const boot = async (self: InstallationId, canvases: ReadonlyArray<string> = ["factory"]): Promise<Machine> => {
  const root = join(tmpdir(), `junto-exchange-${self}-${randomUUID()}`);
  const runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(join(root, "junto.db"))));
  const repository = await runtime.runPromise(WorkRepository);
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO station_known_installations(installation_id, registered_at) VALUES (${self}, ${at})`;
          yield* sql`INSERT INTO station_installation(singleton, installation_id, created_at) VALUES (1, ${self}, ${at})`;
          yield* seedCanvasRows({
            seq: 1,
            canvases: new Map(canvases.map((name) => [name, { nodes: Object.keys(homes).map((nodeId, index) => seat(nodeId, { y: index * 120 })) }])),
          });
        }),
      );
    }),
  );
  const arrived: Machine["arrived"] = [];
  const exchange = makeRowExchange({
    self,
    repository,
    canvases: Effect.succeed(canvases),
    placement: (canvasName) =>
      Effect.succeed(!canvases.includes(canvasName) ? undefined : canvasName === "private" ? privatePlacement : placement),
    mailArrived: (_canvas, nodeId, message: Message) => arrived.push({ nodeId, messageId: message.messageId }),
  });
  const machine: Machine = { self, root, runtime, repository, exchange, arrived };
  machines.set(self, machine);
  return machine;
};

/** Open a link between two machines; frames cross as plain JSON. */
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

const unlink = (left: Machine, right: Machine): void => {
  left.exchange.closed(right.self);
  right.exchange.closed(left.self);
};

/** Deliver queued frames until none is left. */
const settle = async (): Promise<void> => {
  while (queue.length > 0) {
    const next = queue.shift()!;
    const to = machines.get(next.to)!;
    if (to.exchange.linked(next.from)) await to.runtime.runPromise(to.exchange.receive(next.from, next.frame));
  }
};

const send = (on: Machine, from: string, to: string, messageId: string) =>
  on.runtime.runPromise(
    on.repository.appendMessage({
      sink: { canvasName: "factory", nodeId: to },
      basis,
      message: { messageId, role: "agent", parts: [{ kind: "text", text: `from ${from}` }] },
      sentBy: actor(from),
      destination: { kind: "mailbox" },
      originAt: at,
      receivedAt: at,
    }),
  );

const inbox = async (on: Machine, nodeId: string): Promise<string[]> =>
  (await on.runtime.runPromise(on.repository.mailbox("factory", nodeId))).map((message) => message.messageId);

const cursors = (on: Machine) => on.runtime.runPromise(on.repository.exchangeHave("factory"));

const counts = (on: Machine) =>
  on.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe<{ facts: number; mail: number; cursors: number; known: number }>(
        `SELECT (SELECT count(*) FROM work_facts) AS facts, (SELECT count(*) FROM work_messages) AS mail,
          (SELECT count(*) FROM work_exchange_cursors) AS cursors, (SELECT count(*) FROM station_known_installations) AS known`,
      );
      return rows[0]!;
    }),
  );

/** The frame the editing machine would send the mini for its own rows, to tamper with. */
const frameFrom = async (from: Machine): Promise<RowsFrame> => {
  const page = await from.runtime.runPromise(
    from.repository.exchangeRows({ canvasName: "factory", writer: from.self, after: "0", limit: 64 }),
  );
  return JSON.parse(
    JSON.stringify({ kind: "rows", canvasName: "factory", writer: from.self, facts: page.rows.map((row) => row.fact), through: page.through }),
  ) as RowsFrame;
};

const refused = async (on: Machine, peer: InstallationId, frame: unknown): Promise<void> => {
  const before = await counts(on);
  await expect(on.runtime.runPromise(on.exchange.receive(peer, frame))).rejects.toBeInstanceOf(ExchangeClosed);
  expect(await counts(on)).toEqual(before);
};

let editor: Machine;
let mini: Machine;
let other: Machine;

beforeAll(async () => {
  editor = await boot(EDITOR, ["factory", "private"]);
  mini = await boot(MINI);
  other = await boot(OTHER);
});

afterAll(async () => {
  for (const machine of machines.values()) {
    await machine.runtime.dispose();
    await rm(machine.root, { recursive: true, force: true });
  }
});

describe("mail between machines", () => {
  it("holds mail written while no link is open, and hands it over when one opens", async () => {
    await send(editor, "lead", "peer", "held-for-the-mini");
    await send(mini, "peer", "lead", "held-for-the-editor");
    expect(await inbox(mini, "peer")).toEqual([]);

    await link(editor, mini);
    await settle();

    expect(await inbox(mini, "peer")).toEqual(["held-for-the-mini"]);
    expect(await inbox(editor, "lead")).toEqual(["held-for-the-editor"]);
    expect(mini.arrived).toEqual([{ nodeId: "peer", messageId: "held-for-the-mini" }]);
    expect(editor.arrived).toEqual([{ nodeId: "lead", messageId: "held-for-the-editor" }]);
    expect((await cursors(mini)).map((cursor) => cursor.writer)).toEqual([EDITOR]);
    expect((await cursors(editor)).map((cursor) => cursor.writer)).toEqual([MINI]);
  });

  it("pushes a local commit to an open link, in both directions", async () => {
    await send(editor, "lead", "peer", "live-to-the-mini");
    await editor.runtime.runPromise(editor.exchange.committed("factory"));
    await send(mini, "peer", "lead", "live-to-the-editor");
    await mini.runtime.runPromise(mini.exchange.committed("factory"));
    await settle();

    expect(await inbox(mini, "peer")).toEqual(["held-for-the-mini", "live-to-the-mini"]);
    expect(await inbox(editor, "lead")).toEqual(["held-for-the-editor", "live-to-the-editor"]);
  });

  it("gives a machine only the mail of its own seats, and the editing machine everything", async () => {
    // Mail between two seats on the mini is local there and still reaches the editing machine.
    await send(mini, "peer", "peer-two", "inside-the-mini");
    await mini.runtime.runPromise(mini.exchange.committed("factory"));
    // The operator's mail to a seat on the editing machine is none of the mini's.
    await send(editor, "lead", "lead", "inside-the-editor");
    await editor.runtime.runPromise(editor.exchange.committed("factory"));
    await settle();

    expect(await inbox(mini, "peer-two")).toEqual(["inside-the-mini"]);
    expect(await inbox(editor, "peer-two")).toEqual(["inside-the-mini"]);
    // The mini holds the mail its own seat sent to `lead`, and not the editing machine's own.
    expect(await inbox(mini, "lead")).toEqual(["held-for-the-editor", "live-to-the-editor"]);
    // The mini is still caught up through the row it was not given.
    const through = (await cursors(mini)).find((cursor) => cursor.writer === EDITOR)!.through;
    const own = await editor.runtime.runPromise(
      editor.repository.exchangeRows({ canvasName: "factory", writer: EDITOR, after: "0", limit: 64 }),
    );
    expect(through).toBe(own.through);
  });

  it("brings a receipt back to the machine that holds the mail", async () => {
    const sink = { canvasName: "factory", nodeId: "peer" };
    await mini.runtime.runPromise(
      mini.repository.acceptDelivery({
        sink,
        basis,
        receipt: {
          deliveryId: mailboxMessageDeliveryId("factory", "peer", "held-for-the-mini"),
          deliveredItem: { kind: "message", sink, itemId: "held-for-the-mini" },
          actor: actor("peer"),
          acceptedAt: at,
        },
        originAt: at,
        receivedAt: at,
      }),
    );
    await mini.runtime.runPromise(mini.exchange.committed("factory"));
    await settle();

    const held = (await editor.runtime.runPromise(editor.repository.mailbox("factory", "peer"))).find(
      (message) => message.messageId === "held-for-the-mini",
    );
    expect(held?.metadata).toMatchObject({ deliveredAt: Date.parse(at) });
  });

  it("changes nothing when the same rows arrive again", async () => {
    const before = [await counts(editor), await counts(mini)];
    unlink(editor, mini);
    await link(editor, mini);
    await settle();
    const frame = await frameFrom(editor);
    await mini.runtime.runPromise(mini.exchange.receive(EDITOR, { ...frame, facts: frame.facts.filter((fact) => fact.item.sink.nodeId === "peer") }));
    expect([await counts(editor), await counts(mini)]).toEqual(before);
  });

  it("relays mail between two other machines through the one that edits the canvas", async () => {
    await send(mini, "peer", "far", "mini-to-the-far-machine");
    await mini.runtime.runPromise(mini.exchange.committed("factory"));
    await link(editor, other);
    await settle();

    expect(await inbox(other, "far")).toEqual(["mini-to-the-far-machine"]);
    // The far machine took the mini's row from the editing machine, and nothing else of the mini's.
    expect((await cursors(other)).map((cursor) => cursor.writer).sort()).toEqual([EDITOR, MINI].sort());
    expect(await inbox(other, "peer-two")).toEqual([]);
    expect((await counts(other)).mail).toBe(1);
  });
});

describe("a canvas a machine does not hold", () => {
  it("is never named to that machine, and never offered to it", async () => {
    unlink(editor, mini);
    queue.length = 0;
    await link(editor, mini);
    const said = queue.filter((queued) => queued.from === EDITOR).map((queued) => JSON.stringify(queued.frame));
    expect(said.length).toBeGreaterThan(0);
    for (const frame of said) expect(frame).not.toContain("private");
    await settle();

    // The mini claims the canvas anyway: it is offered nothing of it.
    await editor.runtime.runPromise(
      editor.exchange.receive(MINI, { kind: "have", canvases: [{ canvasName: "private", writers: [] }, { canvasName: "factory", writers: [] }] }),
    );
    for (const queued of queue) expect(JSON.stringify(queued.frame)).not.toContain("private");
    await settle();
  });

  it("takes no rows for it from that machine, not even an empty frame", async () => {
    await refused(editor, MINI, { kind: "rows", canvasName: "private", writer: MINI, facts: [], through: "9" });
  });
});

describe("what a machine refuses, writing nothing", () => {
  it("refuses a machine passing on another writer's rows for a canvas it does not edit", async () => {
    const frame = await frameFrom(editor);
    // The far machine sends the mini the editing machine's rows.
    await link(mini, other);
    await settle();
    await refused(mini, OTHER, frame);
    unlink(mini, other);
  });

  it("refuses mail that claims a seat living on another machine", async () => {
    const frame = await frameFrom(mini);
    const forged = frame.facts.find((fact) => fact.body.operation === "message.append")!;
    const body = forged.body as { sentBy: { nodeId: string } };
    await refused(editor, MINI, {
      ...frame,
      facts: [{ ...forged, body: { ...body, sentBy: { ...actor("lead") } } }],
    });
  });

  it("refuses a row whose content does not match its hash, and one that changed since it was taken", async () => {
    const frame = await frameFrom(editor);
    const first = frame.facts.find((fact) => fact.item.sink.nodeId === "peer")!;
    const body = first.body as { message: Message };
    const tampered = { ...first, body: { ...body, message: { ...body.message, parts: [{ kind: "text", text: "changed on the way" }] } } };
    await link(editor, mini);
    await settle();
    await refused(mini, EDITOR, { ...frame, facts: [tampered] });
  });

  it("refuses a row for a seat that is not its own, and a row for a canvas it does not hold", async () => {
    await link(editor, mini);
    await settle();
    const frame = await frameFrom(editor);
    const notForTheMini = frame.facts.find((fact) => fact.item.sink.nodeId === "lead")!;
    await refused(mini, EDITOR, { ...frame, facts: [notForTheMini] });
    await link(editor, mini);
    await refused(mini, EDITOR, { ...frame, canvasName: "another-canvas", facts: [] });
  });

  it("refuses a receipt that points at another canvas, even with a matching hash", async () => {
    const frame = await frameFrom(mini);
    const taken = frame.facts.find((fact) => fact.body.operation === "delivery.accepted")!;
    const body = taken.body as { receipt: { actor: object; deliveredItem: { sink: object } } };
    const elsewhere = { canvasName: "private", nodeId: "peer" };
    const { contentSha256: _hash, originAt, ...semantic } = {
      ...taken,
      body: {
        ...body,
        receipt: { ...body.receipt, actor: { ...body.receipt.actor, canvasName: "private" }, deliveredItem: { ...body.receipt.deliveredItem, sink: elsewhere } },
      },
    };
    const rehashed = { ...semantic, originAt, contentSha256: workRecordContentSha256(semantic as never) };
    await link(editor, mini);
    await settle();
    await refused(editor, MINI, { ...frame, facts: [rehashed] });
  });

  it("refuses mail written under another seat's identity", async () => {
    const frame = await frameFrom(mini);
    const sent = frame.facts.find((fact) => fact.body.operation === "message.append" && fact.item.sink.nodeId === "lead")!;
    const body = sent.body as { sentBy: object };
    const { contentSha256: _hash, originAt, ...semantic } = { ...sent, body: { ...body, sentBy: { ...actor("peer"), seatId: actor("peer-two").seatId } } };
    await link(editor, mini);
    await settle();
    await refused(editor, MINI, { ...frame, facts: [{ ...semantic, originAt, contentSha256: workRecordContentSha256(semantic as never) }] });
  });

  it("refuses a frame it does not know and a kind of row that never crosses", async () => {
    await link(editor, mini);
    await settle();
    await refused(mini, EDITOR, { kind: "claim", canvasName: "factory" });
    const frame = await frameFrom(editor);
    await refused(mini, EDITOR, { ...frame, facts: [{ ...frame.facts[0]!, operation: "task.create" }] });
  });
});
