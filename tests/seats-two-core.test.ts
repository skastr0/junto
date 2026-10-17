/**
 * Two cores on one real link session: the "mini" core runs the seat, the
 * "book" core edits its canvas. A seat started over the link must read
 * running from the book, and the mini's seat-state runtime must reach the
 * book as a published state.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeLinkSession } from "../src/main/junto/link/session";
import { LinkHelloSchema } from "../src/main/junto/link/protocol";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { ModelService } from "../src/main/junto/model/service";
import { makeProcessIdentityMap, setProcessIdentityMapForTests } from "../src/main/junto/process-identity";
import { setProcessEpochReaderForTests } from "../src/main/junto/process-epoch";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { seatStateRuntime } from "../src/main/junto/term/agent-state/runtime";
import { ActorSeatOccupy, makeActorSeatOccupy } from "../src/main/junto/term/actor-seat-occupy";
import { LocalSessionHost } from "../src/main/junto/term/local-host";
import { noSeatEnvironment } from "../src/main/junto/term/seat-process";
import { makeSeatsChannel } from "../src/main/junto/term/seats-link";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { setSeatCredentialRegistryForTests } from "../src/main/junto/work/seat-credentials";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import { InstallationId } from "../src/shared/installation-id";
import { asCanvasName } from "../src/shared/model";
import { installHermeticHarnessBins } from "./helpers/hermetic-harness-bins";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";
import { seat } from "./support/model-nodes";
import { ModelStoresLive } from "./support/seed-canvas";
import { seedThisMachine, clearMachines } from "./support/seed-this-machine";

const BUILD = "b".repeat(64);
const canvas = asCanvasName("two-core");
const remoteSeat = seat("mini-seat", { host: "mini", agentKey: "mini:mini-seat",
  launch: { kind: "harness", argv: ["claude"], cwd: tmpdir() } });
const cleanups: Array<() => Promise<void>> = [];
let restoreBins: () => void;

beforeEach(() => {
  seedThisMachine();
  restoreBins = installHermeticHarnessBins();
  setSeatCredentialRegistryForTests(undefined);
  setProcessIdentityMapForTests(makeProcessIdentityMap({
    processAlive: () => true, readProcessStartKey: (pid) => `synthetic-${pid}`,
  }));
  setProcessEpochReaderForTests({ snapshot: () => [{
    pid: 42_818, processGroupId: 42_817, sessionId: 7, startKey: "synthetic-42818",
  }] });
  seatStateRuntime.start();
});

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  restoreBins();
  setSeatCredentialRegistryForTests(undefined);
  setProcessIdentityMapForTests(undefined);
  setProcessEpochReaderForTests(undefined);
  clearMachines();
});

/** Polls until the check passes (bun has no vi.waitFor). */
const eventually = async (check: () => void, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return check(); } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
};

const hello = (name: string) => Schema.decodeUnknownSync(LinkHelloSchema)({
  machineName: name, installationId: `${name}-install`, build: BUILD,
});

const core = async (name: string, editor: string, published?: AgentSeatStateEvent[]) => {
  const root = await mkdtemp(join(tmpdir(), `junto-two-core-${name}-`));
  const fake = makeFakeTerminalProcessAuthority(() => ({ pid: 42_818, exitOnSignal: "SIGTERM" }));
  const host = new LocalSessionHost(fake.authority, { killGraceMs: 5, shutdownGraceMs: 5, lateExitGraceMs: 5 });
  const repositories = Layer.provideMerge(Layer.mergeAll(
    WorkRepositoryLive, makeMachineRepositoryLive({ defaultName: () => name }),
  ), makeStateEngineLive(join(root, "junto.db")));
  const actors = Layer.effect(ActorSeatOccupy, Effect.gen(function* () {
    const machine = yield* MachineRepository;
    return makeActorSeatOccupy({
      local: host, localHostId: () => machine.machineName, seatEnvironment: noSeatEnvironment,
      clientForOccupy: async () => { throw new Error("no forwarding in this test"); },
    });
  }));
  const runtime = ManagedRuntime.make(Layer.provideMerge(actors, Layer.provideMerge(ModelStoresLive, repositories)));
  cleanups.push(async () => {
    await host.shutdownAll("test_cleanup");
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.runPromise(Effect.flatMap(ModelService, (model) => model.installCopy({
    canvas, canvasId: "two-core-canvas", seq: 1, editor, nodes: [remoteSeat], wires: [],
  })));
  const channel = await runtime.runPromise(makeSeatsChannel({
    host,
    pin: async () => ({ ok: true as const, sessionId: "named-session", minted: true }),
    ...(published === undefined ? {} : { publishState: (event) => { published.push(event); } }),
  }));
  return { host, fake, runtime, channel };
};

it("a seat started over the link reads running from the editing core, and its state reaches it", async () => {
  const published: AgentSeatStateEvent[] = [];
  const mini = await core("mini", "book-install");
  const book = await core("book", "book-install", published);
  await mini.runtime.runPromise(Effect.flatMap(MachineRepository, (machines) =>
    machines.pinPeer({ machineName: "book", installationId: Schema.decodeUnknownSync(InstallationId)("book-install") })));
  const toMini = new PassThrough();
  const toBook = new PassThrough();
  const miniEnd = makeLinkSession({ readable: toMini, writable: toBook, self: hello("mini"), admit: async () => {},
    channels: { seats: mini.channel }, run: mini.runtime.runPromise });
  const bookEnd = makeLinkSession({ readable: toBook, writable: toMini, self: hello("book"), admit: async () => {},
    channels: { seats: book.channel }, run: book.runtime.runPromise });
  cleanups.push(async () => { await Promise.all([miniEnd.close(), bookEnd.close()]); });
  await Promise.all([miniEnd.ready, bookEnd.ready]);

  const started = await bookEnd.request("seats", { _tag: "Start", canvas, seatId: remoteSeat.id });
  expect(started).toMatchObject({ _tag: "Started", machine: "mini" });
  // The book's window reads the seat over the same link: running.
  expect(await bookEnd.request("seats", { _tag: "Get", canvas, seatId: remoteSeat.id }))
    .toMatchObject({ _tag: "Started", status: "running" });

  // The stand-in prints, as a harness does; the mini's runtime reads it.
  mini.fake.controllers[0]!.emitData("stand-in ready\r\n");
  await eventually(() => expect(published.some((event) => event.bindingId === remoteSeat.bindingId)).toBe(true));
});
