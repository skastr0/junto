/**
 * An automation writes from the machine it runs on (0.11/05 S2). The editing
 * machine judges its mail and its commands as it judges a seat's: by where the
 * automation was, by Automations node and id, at the canvas count the row
 * states, from the copies it sent. A row from any other machine closes the
 * link and writes nothing.
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
import { WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { InstallationId } from "../src/shared/installation-id";
import { AutomationNodeId, automationActorRef } from "../src/shared/mail-author";
import type { CanvasPlacement, ExchangeFrame } from "../src/shared/work-exchange";
import { ItemId, OpId } from "../src/shared/work-ids";
import { ActorSeatId, type ActorRef } from "../src/shared/work-protocol";
import { seedCanvasRows } from "./support/seed-canvas";
import { seat, taskBoard } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook");
const M2 = id("m2");
const M3 = id("m3");
const at = "2026-10-28T12:00:00.000Z";

const ROUTINES = Schema.decodeUnknownSync(AutomationNodeId)("routines");
const NIGHTLY = ItemId.make("01M629AAAAAAAAAAAAAAAAAAAA");
/** `nightly` on the `routines` node starts on M2; `lead` is a seat on the editing machine. */
const automationHome: { machine: InstallationId } = { machine: M2 };
const lead: ActorRef = { seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${"1".repeat(64)}`), canvasName: "factory", nodeId: "lead" };
const nightly = automationActorRef("factory", ROUTINES, NIGHTLY);

const placement: CanvasPlacement = {
  canvasId: "canvas-factory",
  editor: EDITOR,
  holds: () => true,
  seatOf: (nodeId) => (nodeId === "lead" ? { seatId: lead.seatId, machine: EDITOR } : undefined),
  automationOf: (nodeId, automationId) => (nodeId === ROUTINES && automationId === NIGHTLY ? automationHome.machine : undefined),
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
  const root = join(tmpdir(), `junto-automation-placement-${self}-${randomUUID()}`);
  const runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(join(root, "junto.db"))));
  const repository = await runtime.runPromise(WorkRepository);
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${self}, ${at})`;
          yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${self}, ${at})`;
          yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", { nodes: [seat("lead"), taskBoard("board", { y: 400 })] }]]) });
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

/** Deliver frames until none is left; a refused frame is kept as the error it closed the link with. */
const settle = async (): Promise<unknown> => {
  let refusal: unknown;
  const quiet = async () => {
    for (const machine of machines.values()) await machine.runtime.runPromise(machine.exchange.quiet);
  };
  for (await quiet(); queue.length > 0; await quiet()) {
    const next = queue.shift()!;
    const to = machines.get(next.to)!;
    if (!to.exchange.linked(next.from)) continue;
    await to.runtime.runPromise(to.exchange.receive(next.from, next.frame)).catch((error: unknown) => {
      refusal = error;
    });
  }
  return refusal;
};

/** Where the canvas count is on this machine: the copy at that count was installed. */
const countIs = (on: Machine, seq: number) =>
  on.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE canvases SET seq = ${seq} WHERE canvas_name = 'factory'`;
    }),
  );

/** The editing machine sends a copy at `seq` to both machines, with the automation where it is now. */
const copySent = async (seq: number): Promise<void> => {
  for (const target of [M2, M3]) {
    await editor.runtime.runPromise(
      editor.repository.recordCanvasCopySent({
        canvasName: "factory",
        target,
        seq,
        seats: [{ nodeId: "lead", seatId: lead.seatId, machine: EDITOR }],
        automations: [{ nodeId: ROUTINES, automationId: NIGHTLY, machine: automationHome.machine }],
        sentAt: at,
      }),
    );
  }
};

const mail = (on: Machine, messageId: string, count: number) =>
  on.runtime.runPromise(
    on.repository.appendMessage({
      sink: { canvasName: "factory", nodeId: "lead" },
      basis: { kind: "canvas", canvasName: "factory", seq: count },
      message: { messageId, role: "agent", parts: [{ kind: "text", text: "from nightly" }] },
      sentBy: nightly,
      destination: { kind: "mailbox" },
      originAt: at,
      receivedAt: at,
    }),
  );

const command = (on: Machine, opId: string, count: number) =>
  on.runtime.runPromise(
    on.repository.queueCommand({
      command: {
        opId: OpId.make(opId),
        canvasName: "factory",
        actor: { kind: "automation", nodeId: ROUTINES, automationId: NIGHTLY },
        target: { kind: "task", nodeId: "board" },
        basis: null,
        after: [],
        op: { kind: "create", taskId: ItemId.make("01M629CCCCCCCCCCCCCCCCCCCC"), title: "From nightly" },
      } as never,
      basis: { kind: "canvas", canvasName: "factory", seq: count } as never,
      originAt: at,
      receivedAt: at,
    }),
  );

const inbox = async (nodeId: string): Promise<string[]> =>
  (await editor.runtime.runPromise(editor.repository.mailbox("factory", nodeId))).map((message) => message.messageId);

const unruled = async (): Promise<string[]> =>
  (await editor.runtime.runPromise(editor.repository.unruledCommands("factory"))).map((held) => `${held.writer}:${held.command.opId}`);

let editor: Machine;
let m2: Machine;
let m3: Machine;

beforeAll(async () => {
  editor = await boot(EDITOR);
  m2 = await boot(M2);
  m3 = await boot(M3);
  await copySent(1);
});

afterAll(async () => {
  for (const machine of machines.values()) {
    await machine.runtime.dispose();
    await rm(machine.root, { recursive: true, force: true });
  }
});

describe("an automation's rows, judged where it was", () => {
  it("takes its mail and its command from the machine it runs on", async () => {
    await mail(m2, "nightly-from-m2", 1);
    await command(m2, "01M629DDDDDDDDDDDDDDDDDDD1", 1);
    await link(editor, m2);
    expect(await settle()).toBeUndefined();
    expect(await inbox("lead")).toContain("nightly-from-m2");
    expect(await unruled()).toContain(`${M2}:01M629DDDDDDDDDDDDDDDDDDD1`);
  });

  it("refuses its mail from another machine, closing the link and writing nothing", async () => {
    const stranger = await boot(id("m4"));
    await mail(stranger, "nightly-forged-on-m4", 1);
    await link(editor, stranger);
    const refused = await settle();
    expect(refused).toBeInstanceOf(ExchangeClosed);
    expect(String(refused)).toContain("a row was not written where its author lives");
    expect(await inbox("lead")).not.toContain("nightly-forged-on-m4");
  });

  it("refuses its command from another machine the same way", async () => {
    const stranger = await boot(id("m5"));
    await command(stranger, "01M629DDDDDDDDDDDDDDDDDDD2", 1);
    await link(editor, stranger);
    expect(await settle()).toBeInstanceOf(ExchangeClosed);
    expect(await unruled()).not.toContain(`m5:01M629DDDDDDDDDDDDDDDDDDD2`);
  });

  it("after a move, takes what the old machine wrote before it, and only the new machine's after", async () => {
    // M2 wrote at count 1, before it held the move.
    await mail(m2, "nightly-before-the-move", 1);
    // At count 2 the automation moves to M3, as the ruling of its set-machine moved the count.
    automationHome.machine = M3;
    await copySent(2);
    await m2.runtime.runPromise(m2.exchange.committed("factory"));
    expect(await settle()).toBeUndefined();
    expect(await inbox("lead")).toContain("nightly-before-the-move");

    // M3 writes at the new count: its.
    await countIs(m3, 2);
    await mail(m3, "nightly-on-m3", 2);
    await link(editor, m3);
    expect(await settle()).toBeUndefined();
    expect(await inbox("lead")).toContain("nightly-on-m3");

    // M2 stating the new count: the automation was no longer there.
    await countIs(m2, 2);
    await mail(m2, "nightly-after-the-move-on-m2", 2);
    await m2.runtime.runPromise(m2.exchange.committed("factory"));
    expect(await settle()).toBeInstanceOf(ExchangeClosed);
    expect(await inbox("lead")).not.toContain("nightly-after-the-move-on-m2");
  });
});
