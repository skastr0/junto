/**
 * Two cores on one real link session, in one process: "mini" runs the seat,
 * "book" edits its canvas. Each core has its own state database, machine
 * name, model and terminal host; the link is two PassThrough streams.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { makeLinkSession } from "../../src/main/junto/link/session";
import { LinkHelloSchema } from "../../src/main/junto/link/protocol";
import { MachineRepository, makeMachineRepositoryLive } from "../../src/main/junto/machines/repository";
import { ModelService } from "../../src/main/junto/model/service";
import { withMachineLogger } from "../../src/main/junto/observability/logger";
import { makeProcessIdentityMap, setProcessIdentityMapForTests } from "../../src/main/junto/process-identity";
import { setProcessEpochReaderForTests } from "../../src/main/junto/process-epoch";
import { makeStateEngineLive } from "../../src/main/junto/state/engine";
import { seatStateRuntime } from "../../src/main/junto/term/agent-state/runtime";
import { ActorSeatOccupy, makeActorSeatOccupy } from "../../src/main/junto/term/actor-seat-occupy";
import { LocalSessionHost } from "../../src/main/junto/term/local-host";
import { noSeatEnvironment } from "../../src/main/junto/term/seat-process";
import { makeSeatsChannel, type SeatsChannelOptions } from "../../src/main/junto/term/seats-link";
import { WorkRepositoryLive } from "../../src/main/junto/work/repository";
import { setSeatCredentialRegistryForTests } from "../../src/main/junto/work/seat-credentials";
import { InstallationId } from "../../src/shared/installation-id";
import { asCanvasName, type Node } from "../../src/shared/model";
import { installHermeticHarnessBins } from "../helpers/hermetic-harness-bins";
import { makeFakeTerminalProcessAuthority } from "../helpers/fake-terminal-process-authority";
import { seat } from "./model-nodes";
import { ModelStoresLive } from "./seed-canvas";
import { seedThisMachine, clearMachines } from "./seed-this-machine";

const BUILD = "b".repeat(64);
export const twoCoreCanvas = asCanvasName("two-core");
export const miniSeat = seat("mini-seat", { host: "mini", agentKey: "mini:mini-seat",
  launch: { kind: "harness", argv: ["claude"], cwd: tmpdir() } });

const hello = (name: string) => Schema.decodeUnknownSync(LinkHelloSchema)({
  machineName: name, installationId: `${name}-install`, build: BUILD,
});

/** Process-wide test seams the two cores share; returns their undo. */
export const twoCoreProcess = (): (() => void) => {
  seedThisMachine();
  const restoreBins = installHermeticHarnessBins();
  setSeatCredentialRegistryForTests(undefined);
  setProcessIdentityMapForTests(makeProcessIdentityMap({
    processAlive: () => true, readProcessStartKey: (pid) => `synthetic-${pid}`,
  }));
  setProcessEpochReaderForTests({ snapshot: () => [{
    pid: 42_818, processGroupId: 42_817, sessionId: 7, startKey: "synthetic-42818",
  }] });
  seatStateRuntime.start();
  return () => {
    restoreBins();
    setSeatCredentialRegistryForTests(undefined);
    setProcessIdentityMapForTests(undefined);
    setProcessEpochReaderForTests(undefined);
    clearMachines();
  };
};

/** Polls until the check passes (bun has no vi.waitFor). */
export const eventually = async (check: () => void, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return check(); } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
};

const core = async (name: string, nodes: ReadonlyArray<Node>, channel: SeatsChannelOptions,
  cleanups: Array<() => Promise<void>>) => {
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
      clientForOccupy: async () => { throw new Error("no forwarding between two test cores"); },
    });
  }));
  const runtime = ManagedRuntime.make(withMachineLogger(
    Layer.provideMerge(actors, Layer.provideMerge(ModelStoresLive, repositories))));
  cleanups.push(async () => {
    await host.shutdownAll("test_cleanup");
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const install = (seq: number, editor = "book-install", copyNodes = nodes) =>
    runtime.runPromise(Effect.flatMap(ModelService, (model) => model.installCopy({
      canvas: twoCoreCanvas, canvasId: "two-core-canvas", seq, editor, nodes: copyNodes, wires: [],
    })));
  await install(1);
  const seats = await runtime.runPromise(makeSeatsChannel({
    host, pin: async () => ({ ok: true as const, sessionId: "named-session", minted: true }), ...channel,
  }));
  return { host, fake, runtime, channel: seats, install };
};

/** The mini runs miniSeat; the book edits the canvas. Both ends of the link are returned ready. */
export const twoCores = async (options: {
  readonly cleanups: Array<() => Promise<void>>;
  readonly mini?: SeatsChannelOptions;
  readonly book?: SeatsChannelOptions;
  readonly nodes?: ReadonlyArray<Node>;
}) => {
  const nodes = options.nodes ?? [miniSeat];
  const mini = await core("mini", nodes, options.mini ?? {}, options.cleanups);
  const book = await core("book", nodes, options.book ?? {}, options.cleanups);
  await mini.runtime.runPromise(Effect.flatMap(MachineRepository, (machines) =>
    machines.pinPeer({ machineName: "book", installationId: Schema.decodeUnknownSync(InstallationId)("book-install") })));
  const toMini = new PassThrough();
  const toBook = new PassThrough();
  const miniEnd = makeLinkSession({ readable: toMini, writable: toBook, self: hello("mini"), admit: async () => {},
    channels: { seats: mini.channel }, run: mini.runtime.runPromise });
  const bookEnd = makeLinkSession({ readable: toBook, writable: toMini, self: hello("book"), admit: async () => {},
    channels: { seats: book.channel }, run: book.runtime.runPromise });
  options.cleanups.push(async () => { await Promise.all([miniEnd.close(), bookEnd.close()]); });
  await Promise.all([miniEnd.ready, bookEnd.ready]);
  return { mini, book, miniEnd, bookEnd };
};
