/**
 * Any machine opens a link (docs/machines.md, Rule 7): two machines that do
 * not edit the canvas, linked to each other while the editing machine is not
 * running at all, exchange mail between their seats. Each passes on only its
 * own rows (Rule 5). Real databases and the real row exchange; frames cross
 * as plain JSON, as on a link.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeRowExchange, type RowExchange } from "../src/main/junto/work/exchange/session";
import { WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { InstallationId } from "../src/shared/installation-id";
import type { CanvasPlacement, ExchangeFrame } from "../src/shared/work-exchange";
import { ActorSeatId, type ActorRef } from "../src/shared/work-protocol";
import { seedCanvasRows } from "./support/seed-canvas";
import { seat } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
/** The editing machine is asleep for the whole test: it is never booted. */
const EDITOR = id("macbook");
const MINI = id("mini");
const VPS = id("vps");
const at = "2026-10-28T12:00:00.000Z";
const basis = { kind: "canvas" as const, canvasName: "factory", seq: 1 };
const homes: Record<string, InstallationId> = { lead: EDITOR, peer: MINI, ruler: VPS };
const actor = (nodeId: string): ActorRef => ({
  seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${(Object.keys(homes).indexOf(nodeId) + 1).toString().repeat(64)}`),
  canvasName: "factory",
  nodeId,
});
const placement: CanvasPlacement = {
  canvasId: "canvas-factory",
  editor: EDITOR,
  holds: (machine) => Object.values(homes).includes(machine),
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
  const root = join(tmpdir(), `junto-any-end-${self}-${randomUUID()}`);
  const runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(join(root, "junto.db"))));
  const repository = await runtime.runPromise(WorkRepository);
  await runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${self}, ${at})`;
      yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${self}, ${at})`;
      // The copy the editing machine sent before it went to sleep.
      yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", { nodes: Object.keys(homes).map((nodeId, index) => seat(nodeId, { y: index * 120 })) }]]) });
    }));
  }));
  const exchange = makeRowExchange({
    self, repository,
    canvases: Effect.succeed(["factory"]),
    placement: () => Effect.succeed(placement),
    mailArrived: () => undefined,
    commandArrived: () => undefined,
    cutCopy: () => Effect.succeed(undefined),
    copySent: () => Effect.void,
    installCopy: () => Effect.die("only the editing machine sends a copy"),
    signals: () => Effect.succeed([]),
    takeSignal: () => Effect.die("no signal in this test"),
  });
  const machine: Machine = { self, root, runtime, repository, exchange };
  machines.set(self, machine);
  return machine;
};

const link = async (left: Machine, right: Machine): Promise<void> => {
  const end = (from: Machine, to: Machine) => ({
    peer: to.self, id: `${from.self}-${to.self}`,
    send: (frame: ExchangeFrame) => Effect.sync(() => { queue.push({ from: from.self, to: to.self, frame: JSON.parse(JSON.stringify(frame)) }); }),
  });
  await left.runtime.runPromise(left.exchange.opened(end(left, right)));
  await right.runtime.runPromise(right.exchange.opened(end(right, left)));
};
const quiet = async (): Promise<void> => { for (const machine of machines.values()) await machine.runtime.runPromise(machine.exchange.quiet); };
const settle = async (): Promise<void> => {
  for (await quiet(); queue.length > 0; await quiet()) {
    const next = queue.shift()!;
    const to = machines.get(next.to)!;
    if (to.exchange.linked(next.from)) await to.runtime.runPromise(to.exchange.receive(next.from, next.frame));
  }
};
const send = (on: Machine, from: string, to: string, messageId: string) => on.runtime.runPromise(on.repository.appendMessage({
  sink: { canvasName: "factory", nodeId: to }, basis,
  message: { messageId, role: "agent", parts: [{ kind: "text", text: `from ${from}` }] },
  sentBy: actor(from), destination: { kind: "mailbox" }, originAt: at, receivedAt: at,
}));
const inbox = async (on: Machine, nodeId: string) => (await on.runtime.runPromise(on.repository.mailbox("factory", nodeId))).map((message) => message.messageId);

let mini: Machine;
let vps: Machine;
beforeAll(async () => { mini = await boot(MINI); vps = await boot(VPS); });
afterAll(async () => {
  for (const machine of machines.values()) { await machine.runtime.dispose(); await rm(machine.root, { recursive: true, force: true }); }
});

it("links two machines that do not edit the canvas, with the editing machine asleep, and carries mail both ways", async () => {
  await send(mini, "peer", "ruler", "mini-to-the-vps");
  await send(vps, "ruler", "peer", "vps-to-the-mini");
  // Mail to the sleeping editor's seat waits on the mini, as Rule 6 says.
  await send(mini, "peer", "lead", "held-for-the-editor");
  await link(mini, vps);
  await settle();

  expect(await inbox(vps, "ruler")).toEqual(["mini-to-the-vps"]);
  expect(await inbox(mini, "peer")).toEqual(["vps-to-the-mini"]);
  // Neither passes on mail it was not entitled to: the editor's seat's mail stays where it was written.
  expect(await inbox(vps, "lead")).toEqual([]);
  // Each holds only the other's own rows: no machine passed on a third writer's.
  const writers = async (on: Machine) => (await on.runtime.runPromise(on.repository.exchangeHave("factory"))).map((cursor) => cursor.writer);
  expect(await writers(vps)).toEqual([MINI]);
  expect(await writers(mini)).toEqual([VPS]);
});

it("keeps carrying mail on that link as each side commits", async () => {
  await send(vps, "ruler", "peer", "live-from-the-vps");
  await vps.runtime.runPromise(vps.exchange.committed("factory"));
  await settle();
  expect(await inbox(mini, "peer")).toEqual(["vps-to-the-mini", "live-from-the-vps"]);
});
