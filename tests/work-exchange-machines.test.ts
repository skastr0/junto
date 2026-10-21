/**
 * The row exchange between real databases joined by an in-memory link: an
 * editing machine and two others. No mock of the work plane: each machine is
 * its own state engine and work repository, and rows cross only as frames.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Deferred, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ExchangeClosed, makeRowExchange, type RowExchange } from "../src/main/junto/work/exchange/session";
import { mailboxMessageDeliveryId } from "../src/main/junto/work/mailbox-receipts";
import { WorkRepository, WorkRepositoryLive, workRecordContentSha256 } from "../src/main/junto/work/repository";
import { InstallationId } from "../src/shared/installation-id";
import { COMMAND_ROW_MAX_BYTES } from "../src/shared/resource-command";
import { EXCHANGE_ROWS_PAGE_BYTES, LINK_FRAME_MAX_BYTES, workRowTooLargeIn } from "../src/shared/exchange-bounds";
import { encodeExchangeFrame, type CanvasPlacement, type ExchangeFrame, type RowsFrame } from "../src/shared/work-exchange";
import type { Message } from "../src/shared/work-model";
import { ActorSeatId, type ActorRef } from "../src/shared/work-protocol";
import { seedCanvasRows } from "./support/seed-canvas";
import { seat, taskBoard } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook");
const MINI = id("mini");
const OTHER = id("other-mini");
const at = "2026-10-09T12:00:00.000Z";
const basis = { kind: "canvas" as const, canvasName: "factory", seq: 1 };

/** `lead` lives on the editing machine, `peer` and `peer-two` on the mini, `far` on a third machine. */
const homes: Record<string, InstallationId> = { lead: EDITOR, peer: MINI, "peer-two": MINI, far: OTHER };
const placement: CanvasPlacement = {
  canvasId: "canvas-factory",
  editor: EDITOR,
  holds: (machine) => machine === EDITOR || Object.values(homes).includes(machine),
  seatOf: (nodeId) => (homes[nodeId] === undefined ? undefined : { seatId: actor(nodeId).seatId, machine: homes[nodeId]! }),
};
/** A second canvas that only the editing machine holds: its one seat is `lead`. */
const privatePlacement: CanvasPlacement = {
  canvasId: "canvas-private",
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
  /** Canvases a ruler was woken for: commands arrived. */
  readonly commanded: Array<string>;
  /** How often the exchange looked for a copy to send, and where a canvas's seats are. */
  readonly calls: { cuts: number; placements: number };
};

const queue: Queued[] = [];
/** Each rows frame's bytes as the link writes it, the event around the encoded frame. */
const rowsFrameBytes: number[] = [];
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
          yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${self}, ${at})`;
          yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${self}, ${at})`;
          yield* seedCanvasRows({
            seq: 1,
            canvases: new Map(canvases.map((name) => [name, {
              nodes: [...Object.keys(homes).map((nodeId, index) => seat(nodeId, { y: index * 120 })), taskBoard("board", { y: 1200 })],
            }])),
          });
        }),
      );
    }),
  );
  const arrived: Machine["arrived"] = [];
  const commanded: Machine["commanded"] = [];
  const calls: Machine["calls"] = { cuts: 0, placements: 0 };
  const exchange = makeRowExchange({
    self,
    repository,
    canvases: Effect.succeed(canvases),
    placement: (canvasName) =>
      Effect.sync(() => {
        calls.placements += 1;
        return !canvases.includes(canvasName) ? undefined : canvasName === "private" ? privatePlacement : placement;
      }),
    mailArrived: (_canvas, nodeId, message: Message) => arrived.push({ nodeId, messageId: message.messageId }),
    commandArrived: (canvasName) => commanded.push(canvasName),
    // These machines already hold their canvases; tests/work-exchange-copy.test.ts sends copies.
    cutCopy: () =>
      Effect.sync(() => {
        calls.cuts += 1;
        return undefined;
      }),
    copySent: () => Effect.void,
    installCopy: () => Effect.die("no copy is sent between these machines"),
    signals: () => Effect.succeed([]),
    takeSignal: () => Effect.die("no signal is stated between these machines"),
  });
  const machine: Machine = { self, root, runtime, repository, exchange, arrived, commanded, calls };
  machines.set(self, machine);
  return machine;
};

/** Open a link between two machines; frames cross as plain JSON. */
const link = async (left: Machine, right: Machine): Promise<void> => {
  const end = (from: Machine, to: Machine) => ({
    peer: to.self,
    send: (frame: ExchangeFrame) =>
      Effect.sync(() => {
        if (frame.kind === "rows") rowsFrameBytes.push(Buffer.byteLength(JSON.stringify({ type: "event", channel: "rows", payload: encodeExchangeFrame(frame) })));
        queue.push({ from: from.self, to: to.self, frame: JSON.parse(JSON.stringify(frame)) });
      }),
  });
  await left.runtime.runPromise(left.exchange.opened(end(left, right)));
  await right.runtime.runPromise(right.exchange.opened(end(right, left)));
  await quiet();
};

const unlink = (left: Machine, right: Machine): void => {
  left.exchange.closed(right.self);
  right.exchange.closed(left.self);
};

/** Deliver queued frames until none is left. */
const quiet = async (): Promise<void> => {
  for (const machine of machines.values()) await machine.runtime.runPromise(machine.exchange.quiet);
};

const settle = async (): Promise<void> => {
  for (await quiet(); queue.length > 0; await quiet()) {
    const next = queue.shift()!;
    const to = machines.get(next.to)!;
    if (to.exchange.linked(next.from)) await to.runtime.runPromise(to.exchange.receive(next.from, next.frame));
  }
};

const append = (on: Machine, from: string, to: string, messageId: string, text = `from ${from}`) =>
    on.repository.appendMessage({
      sink: { canvasName: "factory", nodeId: to },
      basis,
      message: { messageId, role: "agent", parts: [{ kind: "text", text }] },
      sentBy: actor(from),
      destination: { kind: "mailbox" },
      originAt: at,
      receivedAt: at,
    });

const send = (on: Machine, from: string, to: string, messageId: string, text?: string) => on.runtime.runPromise(append(on, from, to, messageId, text));

const inbox = async (on: Machine, nodeId: string): Promise<string[]> =>
  (await on.runtime.runPromise(on.repository.mailbox("factory", nodeId))).map((message) => message.messageId);

const cursors = (on: Machine) => on.runtime.runPromise(on.repository.exchangeHave("factory"));

const counts = (on: Machine) =>
  on.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe<{ facts: number; mail: number; cursors: number; known: number }>(
        `SELECT (SELECT count(*) FROM work_facts) AS facts, (SELECT count(*) FROM work_messages) AS mail,
          (SELECT count(*) FROM work_exchange_cursors) AS cursors, (SELECT count(*) FROM known_installations) AS known`,
      );
      return rows[0]!;
    }),
  );

/** The frame the editing machine would send the mini for its own rows, to tamper with. */
const frameFrom = async (from: Machine): Promise<RowsFrame> => {
  const page = await from.runtime.runPromise(
    from.repository.exchangeRows({ canvasName: "factory", writer: from.self, after: "0", limit: 64, bytes: EXCHANGE_ROWS_PAGE_BYTES }),
  );
  return JSON.parse(
    JSON.stringify({
      kind: "rows",
      canvasName: "factory",
      canvasId: "canvas-factory",
      writer: from.self,
      facts: page.rows.map((row) => row.fact),
      through: page.through,
    }),
  ) as RowsFrame;
};

/** One row at a sequence its writer never used, with a hash that matches its content. */
const fresh = (fact: RowsFrame["facts"][number], seq: string): unknown => {
  const { contentSha256: _hash, originAt, ...semantic } = { ...fact, id: { ...fact.id, seq } };
  return { ...semantic, originAt, contentSha256: workRecordContentSha256(semantic as never) };
};

const refused = async (on: Machine, peer: InstallationId, frame: unknown): Promise<void> => {
  const before = await counts(on);
  await expect(on.runtime.runPromise(on.exchange.receive(peer, frame))).rejects.toBeInstanceOf(ExchangeClosed);
  expect(await counts(on)).toEqual(before);
};

let editor: Machine;
let mini: Machine;
let other: Machine;

/** Where every seat is, as the editing machine records it with a copy it sends. */
const seatsAt = (moved: Record<string, InstallationId> = {}) =>
  Object.keys(homes).map((nodeId) => ({ nodeId, seatId: actor(nodeId).seatId, machine: moved[nodeId] ?? homes[nodeId]! }));

const copySent = async (seq: number, moved: Record<string, InstallationId> = {}): Promise<void> => {
  for (const target of [MINI, OTHER]) {
    await editor.runtime.runPromise(
      editor.repository.recordCanvasCopySent({ canvasName: "factory", target, seq, seats: seatsAt(moved), sentAt: at }),
    );
  }
};

beforeAll(async () => {
  editor = await boot(EDITOR, ["factory", "private"]);
  mini = await boot(MINI);
  other = await boot(OTHER);
  await copySent(1);
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

  it("wakes the editing machine's ruler when a seat's command arrives, and no other machine", async () => {
    await mini.runtime.runPromise(
      mini.repository.queueCommand({
        command: {
          opId: "01M5EXW0000000000000000001",
          canvasName: "factory",
          actor: { kind: "seat", seatId: actor("peer").seatId, nodeId: "peer" },
          target: { kind: "task", nodeId: "board" },
          basis: null,
          after: [],
          op: { kind: "start" },
        } as never,
        basis,
        originAt: at,
        receivedAt: at,
      }),
    );
    await mini.runtime.runPromise(mini.exchange.committed("factory"));
    await settle();
    expect(editor.commanded).toEqual(["factory"]);
    expect(mini.commanded).toEqual([]);
  });

  it("keeps the link up when an automation ruling the editing machine made arrives, and keeps the ruling", async () => {
    const opId = "01M5F3B0000000000000000001";
    await editor.runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.withTransaction(
          editor.repository.recordRuling({
            canvasName: "factory",
            writer: EDITOR,
            command: { opId, actor: { kind: "operator" }, target: { kind: "automation", nodeId: "board" } } as never,
            kind: "automation",
            record: { kind: "applied", automationId: "01M5F3B000000000000000000A" },
            ruling: { kind: "applied", opId, facts: [{ fact: "automation.archived", automationId: "01M5F3B000000000000000000A" }] } as never,
          }),
        )),
    );
    await editor.runtime.runPromise(editor.exchange.committed("factory"));
    await settle();
    expect(mini.exchange.linked(EDITOR)).toBe(true);
    expect(editor.exchange.linked(MINI)).toBe(true);
    const kept = await mini.runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.unsafe<{ n: number }>("SELECT count(*) AS n FROM work_events WHERE item_kind = 'ruling' AND item_id = ?", [opId])),
    );
    expect(kept[0]!.n).toBe(1);
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
      editor.repository.exchangeRows({ canvasName: "factory", writer: EDITOR, after: "0", limit: 64, bytes: EXCHANGE_ROWS_PAGE_BYTES }),
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
      editor.exchange.receive(MINI, {
        kind: "have",
        canvases: [
          { canvasName: "private", canvasId: "canvas-private", writers: [] },
          { canvasName: "factory", canvasId: "canvas-factory", writers: [] },
        ],
      }),
    );
    for (const queued of queue) expect(JSON.stringify(queued.frame)).not.toContain("private");
    // Nor is it reported caught up on it.
    const known = editor.exchange.status().find((status) => status.peer === MINI)!;
    expect(known.caughtUp.map((entry) => entry.canvasName)).not.toContain("private");
    await settle();
  });

  it("takes no rows for it from that machine, not even an empty frame", async () => {
    await refused(editor, MINI, { kind: "rows", canvasName: "private", canvasId: "canvas-private", writer: MINI, facts: [], through: "9" });
  });

  it("keeps apart two canvases of one name: another canvas's word is not kept, and its rows are refused", async () => {
    // The mini speaks of a canvas named factory that is not the one the editing machine holds.
    await editor.runtime.runPromise(
      editor.exchange.receive(MINI, { kind: "have", canvases: [{ canvasName: "factory", canvasId: "another-factory", writers: [] }] }),
    );
    expect(queue).toEqual([]);
    expect(editor.exchange.status().find((status) => status.peer === MINI)!.caughtUp).toEqual([]);
    const honest = await frameFrom(mini);
    await refused(editor, MINI, { ...honest, canvasId: "another-factory" });
    // The mini says what it really holds again, and the exchange goes on.
    await editor.runtime.runPromise(
      editor.exchange.receive(MINI, { kind: "have", canvases: [{ canvasName: "factory", canvasId: "canvas-factory", writers: await cursors(mini) }] }),
    );
    await settle();
  });
});

describe("where a seat was when its mail was written", () => {
  /** Mail the mini says it wrote, at a fresh sequence, under the canvas count it states. */
  const miniMail = async (seq: string, messageId: string, from: string, count: number): Promise<RowsFrame> => {
    const frame = await frameFrom(mini);
    const base = frame.facts.find((fact) => fact.body.operation === "message.append" && fact.item.sink.nodeId === "lead")!;
    const body = base.body as unknown as { message: { messageId: string } };
    const row = fresh(
      {
        ...base,
        basis: { kind: "canvas", canvasName: "factory", seq: count },
        item: { ...base.item, itemId: messageId },
        body: { ...body, message: { ...body.message, messageId }, sentBy: actor(from) },
      } as never,
      seq,
    );
    return { ...frame, facts: [row], through: seq } as RowsFrame;
  };
  const take = (frame: RowsFrame) => editor.runtime.runPromise(editor.exchange.receive(MINI, frame));

  it("refuses a count the editing machine never sent that machine", async () => {
    await link(editor, mini);
    await settle();
    await refused(editor, MINI, await miniMail("2001", "from-a-count-never-sent", "peer", 5));
  });

  it("refuses a seat the writer never held, whatever count it states", async () => {
    await link(editor, mini);
    await settle();
    await refused(editor, MINI, await miniMail("2002", "from-a-seat-never-held", "far", 1));
  });

  it("still takes mail written before a seat moved, and refuses mail stated after", async () => {
    // At count 2 the editing machine moves `peer-two` from the mini to the far machine.
    await copySent(2, { "peer-two": OTHER });
    await link(editor, mini);
    await settle();

    await take(await miniMail("2003", "written-before-the-move", "peer-two", 1));
    expect(await inbox(editor, "lead")).toContain("written-before-the-move");

    await refused(editor, MINI, await miniMail("2004", "stated-after-the-move", "peer-two", 2));
    // A seat that stayed is still the mini's at the new count.
    await link(editor, mini);
    await settle();
    await take(await miniMail("2005", "from-the-seat-that-stayed", "peer", 2));
    expect(await inbox(editor, "lead")).toContain("from-the-seat-that-stayed");
  });

  it("refuses a writer whose stated count goes backwards", async () => {
    await refused(editor, MINI, await miniMail("2006", "back-to-an-older-count", "peer", 1));
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

  it("refuses a receipt that points at another canvas: a fresh row with a matching hash, where the honest one is taken", async () => {
    const frame = await frameFrom(mini);
    const base = frame.facts.find((fact) => fact.body.operation === "delivery.accepted")!;
    type Receipt = { receipt: { deliveryId: string; actor: object; deliveredItem: { itemId: string; sink: object } } };
    const receiptAt = (seq: string, mailId: string, forge: (body: Receipt) => Receipt) => {
      const deliveryId = mailboxMessageDeliveryId("factory", "peer", mailId);
      const honest = base.body as unknown as Receipt;
      const body = forge({ ...honest, receipt: { ...honest.receipt, deliveryId, deliveredItem: { ...honest.receipt.deliveredItem, itemId: mailId } } });
      return fresh({ ...base, item: { ...base.item, itemId: deliveryId }, body } as never, seq);
    };
    await link(editor, mini);
    await settle();

    const honest = receiptAt("1001", "live-to-the-mini", (body) => body);
    await editor.runtime.runPromise(editor.exchange.receive(MINI, { ...frame, facts: [honest], through: "1001" }));
    expect(
      (await editor.runtime.runPromise(editor.repository.mailbox("factory", "peer"))).find((message) => message.messageId === "live-to-the-mini")?.metadata,
    ).toMatchObject({ deliveredAt: Date.parse(at) });

    const elsewhere = { canvasName: "private", nodeId: "peer" };
    const forged = receiptAt("1002", "held-for-the-mini-again", (body) => ({
      ...body,
      receipt: { ...body.receipt, actor: { ...body.receipt.actor, canvasName: "private" }, deliveredItem: { ...body.receipt.deliveredItem, sink: elsewhere } },
    }));
    await refused(editor, MINI, { ...frame, facts: [forged], through: "1002" });
  });

  it("refuses mail written under another seat's identity: a fresh row with a matching hash, where the honest one is taken", async () => {
    const frame = await frameFrom(mini);
    const base = frame.facts.find((fact) => fact.body.operation === "message.append" && fact.item.sink.nodeId === "lead")!;
    type Mail = { message: { messageId: string }; sentBy: object };
    const mailAt = (seq: string, messageId: string, sentBy: object) => {
      const body = base.body as unknown as Mail;
      return fresh({ ...base, item: { ...base.item, itemId: messageId }, body: { ...body, message: { ...body.message, messageId }, sentBy } } as never, seq);
    };
    await link(editor, mini);
    await settle();

    await editor.runtime.runPromise(
      editor.exchange.receive(MINI, { ...frame, facts: [mailAt("1003", "fresh-from-the-mini", actor("peer"))], through: "1003" }),
    );
    expect(await inbox(editor, "lead")).toContain("fresh-from-the-mini");

    // The mini's own node, under the identity of a seat that lives on the editing machine.
    await refused(editor, MINI, {
      ...frame,
      facts: [mailAt("1004", "forged-from-the-mini", { ...actor("peer"), seatId: actor("lead").seatId })],
      through: "1004",
    });
    // The same, and from another canvas.
    await link(editor, mini);
    await settle();
    await refused(editor, MINI, {
      ...frame,
      facts: [mailAt("1005", "forged-from-elsewhere", { ...actor("peer"), seatId: actor("lead").seatId, canvasName: "private" })],
      through: "1005",
    });
    expect(await inbox(editor, "lead")).not.toContain("forged-from-the-mini");
  });

  it("refuses a frame it does not know and a kind of row that never crosses", async () => {
    await link(editor, mini);
    await settle();
    await refused(mini, EDITOR, { kind: "claim", canvasName: "factory" });
    const frame = await frameFrom(editor);
    await refused(mini, EDITOR, { ...frame, facts: [{ ...frame.facts[0]!, operation: "task.create" }] });
  });
});

describe("a link that cannot take more", () => {
  it("does not hold up the handler of a have: it returns before its offer is sent", async () => {
    unlink(editor, other);
    await send(editor, "lead", "far", "behind-a-full-link");
    const gate = Deferred.makeUnsafe<void>();
    const offered: string[] = [];
    await editor.runtime.runPromise(
      editor.exchange.opened({
        peer: OTHER,
        // A full link: rows wait until it drains; anything else goes.
        send: (frame) =>
          frame.kind === "rows"
            ? Effect.sync(() => offered.push(...frame.facts.map((fact) => fact.id.seq))).pipe(Effect.andThen(Deferred.await(gate)))
            : Effect.void,
      }),
    );
    // The handler returns although the offer it caused cannot be sent.
    await editor.runtime.runPromise(
      editor.exchange.receive(OTHER, { kind: "have", canvases: [{ canvasName: "factory", canvasId: "canvas-factory", writers: [] }] }),
    );
    for (let turn = 0; turn < 50 && offered.length === 0; turn += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(offered.length).toBeGreaterThan(0);
    // Still reading while the offer waits: another have is taken at once.
    await editor.runtime.runPromise(
      editor.exchange.receive(OTHER, { kind: "have", canvases: [{ canvasName: "factory", canvasId: "canvas-factory", writers: [] }] }),
    );
    Deferred.doneUnsafe(gate, Effect.void);
    await quiet();
    editor.exchange.closed(OTHER);
  });
});

describe("a rows frame the link refuses", () => {
  it("is offered again on the next link: the cursor never passes rows that did not go", async () => {
    await send(editor, "lead", "far", "refused-once");
    const have = { kind: "have", canvases: [{ canvasName: "factory", canvasId: "canvas-factory", writers: [] }] } as const;
    // The link refuses the first rows frame, as it does when its send queue is full.
    let refused = 0;
    await editor.runtime.runPromise(
      editor.exchange.opened({
        peer: OTHER,
        send: (frame) =>
          frame.kind === "rows" && refused++ === 0
            ? Effect.fail(new Error("Too many rows events are waiting for credit"))
            : Effect.void,
      }),
    );
    await editor.runtime.runPromise(editor.exchange.receive(OTHER, have));
    await quiet();
    expect(refused).toBe(1);
    // The exchange on that link is over.
    expect(editor.exchange.linked(OTHER)).toBe(false);

    const carried: string[] = [];
    await editor.runtime.runPromise(
      editor.exchange.opened({
        peer: OTHER,
        send: (frame) =>
          Effect.sync(() => {
            if (frame.kind !== "rows") return;
            for (const fact of frame.facts) if (fact.body.operation === "message.append") carried.push(fact.body.message.messageId);
          }),
      }),
    );
    await editor.runtime.runPromise(editor.exchange.receive(OTHER, have));
    await quiet();
    expect(carried).toContain("refused-once");
    editor.exchange.closed(OTHER);
  });
});

describe("a frame of rows taken", () => {
  it("is passed on in one round, and cuts no copy: what it changed is the work log", async () => {
    // Fresh machines: earlier tests left cursors past rows the mini never wrote.
    for (const machine of [editor, mini]) {
      unlink(editor, mini);
      await machine.runtime.dispose();
      await rm(machine.root, { recursive: true, force: true });
    }
    editor = await boot(EDITOR, ["factory", "private"]);
    mini = await boot(MINI);
    await copySent(1);
    await link(editor, mini);
    await settle();
    // As the app follows local commits: every row written here, taken rows too, is owed to the links.
    const off = editor.repository.subscribeChanges((canvasName) => {
      Effect.runFork(editor.exchange.committed(canvasName, "rows"));
    });
    try {
      for (let index = 0; index < 64; index += 1) await send(mini, "peer", "lead", `one-frame-${index}`);
      await mini.runtime.runPromise(mini.exchange.committed("factory", "rows"));
      editor.calls.cuts = 0;
      editor.calls.placements = 0;
      await settle();
      expect((await inbox(editor, "lead")).filter((id) => id.startsWith("one-frame-"))).toHaveLength(64);
      // One frame, 64 rows: the frame's own check, then one round, not one per row.
      expect(editor.calls.cuts).toBe(0);
      expect(editor.calls.placements).toBeLessThanOrEqual(4);
    } finally {
      off();
    }
  });
});

describe("rows at the size bound", () => {
  it("carries a backlog of rows near 64 KiB in frames that each fit the link", async () => {
    unlink(editor, mini);
    const ids = Array.from({ length: 20 }, (_, index) => `near-cap-${index}`);
    for (const messageId of ids) await send(editor, "lead", "peer", messageId, "x".repeat(COMMAND_ROW_MAX_BYTES - 2_048));
    rowsFrameBytes.length = 0;
    await link(editor, mini);
    await settle();
    expect(await inbox(mini, "peer")).toEqual(expect.arrayContaining(ids));
    // Twenty rows of 62 KiB are 1.2 MiB: more than one frame, each under the bound.
    expect(rowsFrameBytes.filter((bytes) => bytes > COMMAND_ROW_MAX_BYTES).length).toBeGreaterThan(1);
    expect(Math.max(...rowsFrameBytes)).toBeLessThanOrEqual(LINK_FRAME_MAX_BYTES);
  });

  it("refuses a row over 64 KiB before it is written, and says why", async () => {
    const before = await counts(editor);
    const failure = await editor.runtime.runPromise(Effect.flip(append(editor, "lead", "peer", "over-the-cap", "x".repeat(COMMAND_ROW_MAX_BYTES))));
    expect(workRowTooLargeIn(failure)).toMatchObject({ _tag: "WorkRowTooLarge", limit: COMMAND_ROW_MAX_BYTES });
    expect(await counts(editor)).toEqual(before);
  });
});
