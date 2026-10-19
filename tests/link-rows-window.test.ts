/**
 * The real row exchange over two real link sessions, past one rows window: the
 * worker sends through the context its opened hook was given, after the hook
 * has returned, and waits for credit instead of closing the link.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { type Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, expect, it } from "vitest";
import { LinkHelloSchema } from "../src/main/junto/link/protocol";
import { makeLinkSession } from "../src/main/junto/link/session";
import type { LinkSession } from "../src/main/junto/link/types";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeRowsChannel } from "../src/main/junto/work/exchange/channel";
import { makeRowExchange, type RowExchange } from "../src/main/junto/work/exchange/session";
import { WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { InstallationId } from "../src/shared/installation-id";
import type { CanvasPlacement } from "../src/shared/work-exchange";
import { ActorSeatId, type ActorRef } from "../src/shared/work-protocol";
import { seedCanvasRows } from "./support/seed-canvas";
import { seat } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook-install");
const MINI = id("mini-install");
const at = "2026-10-19T12:00:00.000Z";
const homes: Record<string, InstallationId> = { lead: EDITOR, peer: MINI };
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

type Machine = { root: string; runtime: ManagedRuntime.ManagedRuntime<WorkRepository | SqlClient.SqlClient, unknown>; repository: Context.Service.Shape<typeof WorkRepository>; exchange: RowExchange; arrived: string[] };
const booted: Machine[] = [];
const sessions: LinkSession[] = [];

const boot = async (self: InstallationId): Promise<Machine> => {
  const root = join(tmpdir(), `junto-rows-window-${randomUUID()}`);
  const runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(join(root, "junto.db"))));
  const repository = await runtime.runPromise(WorkRepository);
  await runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${self}, ${at})`;
      yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${self}, ${at})`;
      yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", { nodes: Object.keys(homes).map((nodeId, index) => seat(nodeId, { y: index * 120 })) }]]) });
    }));
  }));
  const arrived: string[] = [];
  const exchange = makeRowExchange({
    self, repository,
    canvases: Effect.succeed(["factory"]),
    placement: () => Effect.succeed(placement),
    mailArrived: (_canvas, _nodeId, message) => { arrived.push(message.messageId); },
    cutCopy: () => Effect.succeed(undefined),
    copySent: () => Effect.void,
    installCopy: () => Effect.die("no copy is sent between these machines"),
    signals: () => Effect.succeed([]),
    takeSignal: () => Effect.die("no signal is stated between these machines"),
  });
  if (self === EDITOR) {
    await runtime.runPromise(repository.recordCanvasCopySent({ canvasName: "factory", target: MINI, seq: 1, sentAt: at,
      seats: Object.keys(homes).map((nodeId) => ({ nodeId, seatId: actor(nodeId).seatId, machine: homes[nodeId]! })) }));
  }
  const machine = { root, runtime, repository, exchange, arrived };
  booted.push(machine);
  return machine;
};

const hello = (name: string, installationId: InstallationId) =>
  Schema.decodeUnknownSync(LinkHelloSchema)({ build: "a".repeat(64), installationId, machineName: name });

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const machine of booted.splice(0)) { await machine.runtime.dispose(); await rm(machine.root, { recursive: true, force: true }); }
});

it("carries more than one rows window of held mail when a link opens, with the link left open", async () => {
  const editor = await boot(EDITOR);
  const mini = await boot(MINI);
  // 320 mails of 4 KB is about 1.3 MB of rows: more than one 1 MiB window at the default limits.
  const ids = Array.from({ length: 320 }, (_, index) => `held-${index.toString().padStart(4, "0")}`);
  for (const messageId of ids) {
    await editor.runtime.runPromise(editor.repository.appendMessage({
      sink: { canvasName: "factory", nodeId: "peer" },
      basis: { kind: "canvas", canvasName: "factory", seq: 1 },
      message: { messageId, role: "agent", parts: [{ kind: "text", text: messageId.padEnd(4096, "x") }] },
      sentBy: actor("lead"), destination: { kind: "mailbox" }, originAt: at, receivedAt: at,
    }));
  }
  const ab = new PassThrough(); const ba = new PassThrough();
  const left = makeLinkSession({ readable: ba, writable: ab, self: hello("macbook", EDITOR), admit: async () => {},
    channels: { rows: makeRowsChannel(editor.exchange) }, run: (effect) => editor.runtime.runPromise(effect) });
  const right = makeLinkSession({ readable: ab, writable: ba, self: hello("mini", MINI), admit: async () => {},
    channels: { rows: makeRowsChannel(mini.exchange) }, run: (effect) => mini.runtime.runPromise(effect) });
  sessions.push(left, right);
  let closed: unknown;
  void left.closed.then((ended) => { closed = ended; });
  void right.closed.then((ended) => { closed = ended; });
  await Promise.all([left.ready, right.ready]);
  await new Promise<void>((resolve, reject) => {
    const poll = () => closed !== undefined ? reject(closed) : mini.arrived.length === ids.length ? resolve() : setTimeout(poll, 5);
    poll();
  });
  expect(mini.arrived).toEqual(ids);
  expect(closed).toBeUndefined();
}, 30_000);
