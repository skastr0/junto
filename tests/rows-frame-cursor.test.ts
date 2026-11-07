/**
 * A rows frame states the cursor it continues from, over two real link
 * sessions: the mini runs the real row exchange, and the other end is a peer
 * written by hand that sends what it likes through the rows contract. Rows
 * for a canvas the mini does not hold are dropped with the link left open; a
 * frame that continues from past the mini's cursor closes the link, and the
 * cursor does not move.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { type Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, expect, it } from "vitest";
import { bindLinkChannel } from "../src/core/link/contract";
import { LinkHelloSchema } from "../src/core/link/protocol";
import { makeLinkSession } from "../src/core/link/session";
import type { LinkClosed, LinkSession } from "../src/core/link/types";
import { makeStateEngineLive } from "../src/core/state/engine";
import { makeRowsChannel, RowsLink } from "../src/core/work/exchange/channel";
import { makeRowExchange } from "../src/core/work/exchange/session";
import { WorkRepository, WorkRepositoryLive } from "../src/core/work/repository";
import { InstallationId } from "../src/shared/installation-id";
import type { CanvasPlacement, RowsFrame } from "../src/shared/work-exchange";
import { ActorSeatId } from "../src/shared/work-protocol";
import { seedCanvasRows } from "./support/seed-canvas";
import { seat } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook-install");
const MINI = id("mini-install");
const at = "2026-11-07T12:00:00.000Z";
const homes: Record<string, InstallationId> = { lead: EDITOR, peer: MINI };
const placement: CanvasPlacement = {
  canvasId: "canvas-factory",
  editor: EDITOR,
  holds: (machine) => machine === EDITOR || machine === MINI,
  seatOf: (nodeId) => homes[nodeId] === undefined ? undefined : {
    seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${(Object.keys(homes).indexOf(nodeId) + 1).toString().repeat(64)}`),
    machine: homes[nodeId]!,
  },
};

type Mini = { root: string; runtime: ManagedRuntime.ManagedRuntime<WorkRepository | SqlClient.SqlClient, unknown>; repository: Context.Service.Shape<typeof WorkRepository> };
const roots: string[] = [];
const runtimes: Array<Mini["runtime"]> = [];
const sessions: LinkSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** The mini, holding `factory` and nothing else. */
const bootMini = async (): Promise<Mini> => {
  const root = join(tmpdir(), `junto-rows-cursor-${randomUUID()}`);
  roots.push(root);
  const runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(join(root, "junto.db"))));
  runtimes.push(runtime);
  const repository = await runtime.runPromise(WorkRepository);
  await runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${MINI}, ${at})`;
      yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${MINI}, ${at})`;
      yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", { nodes: Object.keys(homes).map((nodeId, index) => seat(nodeId, { y: index * 120 })) }]]) });
    }));
  }));
  return { root, runtime, repository };
};

const hello = (name: string, installationId: InstallationId) =>
  Schema.decodeUnknownSync(LinkHelloSchema)({ build: "a".repeat(64), installationId, machineName: name });

/** The mini's real exchange at one end; at the other, a peer that only sends. */
const linked = async (mini: Mini) => {
  const exchange = makeRowExchange({
    self: MINI,
    repository: mini.repository,
    canvases: Effect.succeed(["factory"]),
    placement: (canvasName) => Effect.succeed(canvasName === "factory" ? placement : undefined),
    mailArrived: () => {},
    cutCopy: () => Effect.succeed(undefined),
    copySent: () => Effect.void,
    installCopy: () => Effect.die("no copy is sent here"),
    signals: () => Effect.succeed([]),
    takeSignal: () => Effect.die("no signal is stated here"),
  });
  const ab = new PassThrough(); const ba = new PassThrough();
  const peer = makeLinkSession({ readable: ba, writable: ab, self: hello("macbook", EDITOR), admit: async () => {},
    channels: { rows: bindLinkChannel(RowsLink, { requests: {}, event: () => Effect.void }) }, run: Effect.runPromise });
  const end = makeLinkSession({ readable: ab, writable: ba, self: hello("mini", MINI), admit: async () => {},
    channels: { rows: makeRowsChannel(exchange) }, run: (effect) => mini.runtime.runPromise(effect) });
  sessions.push(peer, end);
  await Promise.all([peer.ready, end.ready]);
  // The mini's opened hook has run once it has said what it holds.
  await mini.runtime.runPromise(exchange.quiet);
  return { peer, end, exchange };
};

const rows = (frame: Omit<RowsFrame, "kind" | "canvasId" | "writer" | "facts"> & { readonly canvasId?: string }): RowsFrame =>
  ({ kind: "rows", canvasId: "canvas-factory", writer: EDITOR, facts: [], ...frame });

const cursor = (mini: Mini, canvasName: string) => mini.runtime.runPromise(Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql.unsafe<{ through: string }>(
    "SELECT through FROM work_exchange_cursors WHERE canvas_name = ? AND writer = ?", [canvasName, EDITOR]))[0]?.through;
}));

/** The link's close, or undefined while it stays open past a frame that was handled after. */
const closedWithin = (session: LinkSession, ms: number): Promise<LinkClosed | undefined> =>
  Promise.race([session.closed, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]);

it("drops rows for a canvas this machine does not hold, and the link stays open", async () => {
  const mini = await bootMini();
  const { peer, end } = await linked(mini);
  await peer.sendEvent("rows", rows({ canvasName: "elsewhere", canvasId: "canvas-elsewhere", after: "0", through: "3" }));
  // Handled in order: a frame the mini takes after the drop lands, so the drop closed nothing.
  await peer.sendEvent("rows", rows({ canvasName: "factory", after: "0", through: "2" }));
  for (let turn = 0; turn < 200 && (await cursor(mini, "factory")) === undefined; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(await cursor(mini, "factory")).toBe("2");
  expect(await cursor(mini, "elsewhere")).toBeUndefined();
  expect(await closedWithin(end, 50)).toBeUndefined();
});

it("refuses a frame that continues from past this machine's cursor, and the cursor stays", async () => {
  const mini = await bootMini();
  const { peer, end } = await linked(mini);
  await peer.sendEvent("rows", rows({ canvasName: "factory", after: "0", through: "2" }));
  for (let turn = 0; turn < 200 && (await cursor(mini, "factory")) === undefined; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(await cursor(mini, "factory")).toBe("2");
  // Rows 3 to 5 never crossed; a frame from 5 would vouch for them.
  await peer.sendEvent("rows", rows({ canvasName: "factory", after: "5", through: "9" }));
  const closed = await closedWithin(end, 5_000);
  expect(closed).toBeDefined();
  expect(JSON.stringify(closed)).toMatch(/continue from further than this machine has the writer/u);
  expect(await cursor(mini, "factory")).toBe("2");
});

it("refuses a frame without the cursor it continues from, at the contract's decode", () => {
  expect(() => RowsLink.events!.decode({ kind: "rows", canvasName: "factory", canvasId: "canvas-factory", writer: EDITOR, facts: [], through: "9" })).toThrow();
});
