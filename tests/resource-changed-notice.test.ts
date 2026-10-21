/**
 * Panes read a resource again on both machines: the editing machine's ruler
 * notes the change once its ruling commits, and a replica notes it once the
 * ruling that crossed the link is folded.
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
import { artifactBodyRef, type ArtifactRepository } from "../src/main/junto/work/artifact-repository";
import { makeRowsChannel } from "../src/main/junto/work/exchange/channel";
import { makeRowExchange, type RowExchange } from "../src/main/junto/work/exchange/session";
import { WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { onResourceChanged } from "../src/main/junto/work/resource-changes";
import { artifactRuler } from "../src/main/junto/work/resource-ruler";
import type { QueuedCommand } from "../src/shared/command-row";
import { InstallationId } from "../src/shared/installation-id";
import type { ResourceIpcDomain } from "../src/shared/resource-ipc";
import type { CanvasPlacement } from "../src/shared/work-exchange";
import { OpId } from "../src/shared/work-ids";
import { ActorSeatId } from "../src/shared/work-protocol";
import { seedCanvasRows } from "./support/seed-canvas";
import { artifacts, canvasOf, seat } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook-install");
const MINI = id("mini-install");
const at = "2026-10-21T12:00:00.000Z";
const seatId = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"2".repeat(64)}`);
const opId = Schema.decodeUnknownSync(OpId)("01M5F1H000000000000000000F");
const artifactId = "01M5F1H000000000000000000A";
const nodes = [seat("peer", { y: 0 }), artifacts("arts-1", { y: 200 })];
const placement: CanvasPlacement = {
  canvasId: "canvas-factory",
  editor: EDITOR,
  holds: (machine) => machine === EDITOR || machine === MINI,
  seatOf: (nodeId) => (nodeId === "peer" ? { seatId, machine: MINI } : undefined),
};

const command = {
  opId,
  canvasName: "factory",
  actor: { kind: "seat", seatId, nodeId: "peer" },
  target: { kind: "artifact", nodeId: "arts-1", itemId: artifactId },
  basis: null,
  after: [],
  op: { op: "create", title: "Remote", body: { type: "document", markdown: "from afar" } },
} as unknown as QueuedCommand;

const created = {
  fact: "artifact.created",
  bodyRef: artifactBodyRef({ type: "document", markdown: "from afar" }),
  artifact: {
    artifactId,
    nodeId: "arts-1",
    type: "document",
    title: "Remote",
    version: 1,
    createdBy: { kind: "seat", seatId, nodeId: "peer" },
    updatedAt: 1,
    archived: false,
    taskIds: [],
  },
};

const noted: Array<[ResourceIpcDomain, string]> = [];
const stops: Array<() => void> = [];
const listen = () => stops.push(onResourceChanged((domain, canvasName) => void noted.push([domain, canvasName])));

type Machine = { root: string; runtime: ManagedRuntime.ManagedRuntime<WorkRepository | SqlClient.SqlClient, unknown>; repository: Context.Service.Shape<typeof WorkRepository>; exchange: RowExchange };
const booted: Machine[] = [];
const sessions: LinkSession[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  noted.splice(0);
  for (const session of sessions.splice(0)) await session.close();
  for (const machine of booted.splice(0)) { await machine.runtime.dispose(); await rm(machine.root, { recursive: true, force: true }); }
});

const boot = async (self: InstallationId): Promise<Machine> => {
  const root = join(tmpdir(), `junto-resource-changed-${randomUUID()}`);
  const runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(join(root, "junto.db"))));
  const repository = await runtime.runPromise(WorkRepository);
  await runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(Effect.gen(function* () {
      for (const machine of [EDITOR, MINI]) yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${machine}, ${at})`;
      yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${self}, ${at})`;
      yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", { nodes }]]) });
      if (self === MINI) yield* sql`UPDATE canvases SET editor_installation_id = ${EDITOR} WHERE canvas_name = 'factory'`;
    }));
  }));
  const exchange = makeRowExchange({
    self, repository,
    canvases: Effect.succeed(["factory"]),
    placement: () => Effect.succeed(placement),
    mailArrived: () => {},
    cutCopy: () => Effect.succeed(undefined),
    copySent: () => Effect.void,
    installCopy: () => Effect.die("no copy is sent between these machines"),
    signals: () => Effect.succeed([]),
    takeSignal: () => Effect.die("no signal is stated between these machines"),
  });
  if (self === EDITOR) {
    await runtime.runPromise(repository.recordCanvasCopySent({ canvasName: "factory", target: MINI, seq: 1, sentAt: at, seats: [{ nodeId: "peer", seatId, machine: MINI }] }));
  }
  const machine = { root, runtime, repository, exchange };
  booted.push(machine);
  return machine;
};

const hello = (name: string, installationId: InstallationId) =>
  Schema.decodeUnknownSync(LinkHelloSchema)({ build: "a".repeat(64), installationId, machineName: name });

it("the ruler notes an artifact ruling that changed something, and not a replay", async () => {
  listen();
  let facts: ReadonlyArray<unknown> = [created];
  const repo = { submit: () => Effect.sync(() => ({ kind: "applied", opId, artifactId, version: 1, facts })) } as unknown as ArtifactRepository["Service"];
  const rule = artifactRuler(repo);
  expect(await Effect.runPromise(rule(MINI, command, canvasOf(nodes)))).toEqual({ kind: "ruled" });
  expect(noted).toEqual([["artifact", "factory"]]);
  // A replay answers from the stored ruling and changes nothing.
  facts = [];
  await Effect.runPromise(rule(MINI, command, canvasOf(nodes)));
  expect(noted).toEqual([["artifact", "factory"]]);
});

it("a replica notes the change once the ruling that crossed the link is folded", async () => {
  const editor = await boot(EDITOR);
  const mini = await boot(MINI);
  // The editing machine rules the seat's command: its ruling is its own row, for every machine.
  await editor.runtime.runPromise(editor.repository.recordRuling({
    canvasName: "factory", writer: MINI, command, kind: "artifact",
    record: { kind: "applied" } as never,
    ruling: { kind: "applied", opId, facts: [created] } as never,
    at,
  }));
  listen();
  const ab = new PassThrough(); const ba = new PassThrough();
  const left = makeLinkSession({ readable: ba, writable: ab, self: hello("macbook", EDITOR), admit: async () => {},
    channels: { rows: makeRowsChannel(editor.exchange) }, run: (effect) => editor.runtime.runPromise(effect) });
  const right = makeLinkSession({ readable: ab, writable: ba, self: hello("mini", MINI), admit: async () => {},
    channels: { rows: makeRowsChannel(mini.exchange) }, run: (effect) => mini.runtime.runPromise(effect) });
  sessions.push(left, right);
  await Promise.all([left.ready, right.ready]);
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const poll = () => (noted.length > 0 ? resolve() : Date.now() > deadline ? reject(new Error("no change was noted")) : setTimeout(poll, 5));
    poll();
  });
  expect(noted).toEqual([["artifact", "factory"]]);
  // Noted after the fold committed: the replica holds the artifact the ruling made.
  const held = await mini.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.unsafe<{ n: number }>("SELECT count(*) AS n FROM artifact_versions WHERE canvas_name = 'factory' AND artifact_id = ?", [artifactId])));
  expect(held[0]!.n).toBe(1);
}, 20_000);
