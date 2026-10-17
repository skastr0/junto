import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { ModelService } from "../src/main/junto/model/service";
import { makeProcessIdentityMap, setProcessIdentityMapForTests } from "../src/main/junto/process-identity";
import { setProcessEpochReaderForTests } from "../src/main/junto/process-epoch";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ActorSeatOccupy, makeActorSeatOccupy } from "../src/main/junto/term/actor-seat-occupy";
import { LocalSessionHost } from "../src/main/junto/term/local-host";
import { TerminalNodeDeleteService } from "../src/main/junto/term/node-delete";
import { noSeatEnvironment } from "../src/main/junto/term/seat-process";
import { startSeat, stopSeat, type SeatControlOptions } from "../src/main/junto/term/seat-control";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { setSeatCredentialRegistryForTests } from "../src/main/junto/work/seat-credentials";
import { asCanvasName, type Node } from "../src/shared/model";
import { installHermeticHarnessBins } from "./helpers/hermetic-harness-bins";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";
import { seat, terminal } from "./support/model-nodes";
import { ModelStoresLive } from "./support/seed-canvas";
import { seedThisMachine, clearMachines } from "./support/seed-this-machine";
import { THIS_MACHINE } from "./support/machines";

/** Polls until the check passes (bun has no vi.waitFor). */
const eventually = async (check: () => void, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return check(); } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
};

const canvas = asCanvasName("seat-control");
const localSeat = seat("local-seat", {
  host: THIS_MACHINE, agentKey: `${THIS_MACHINE}:local-seat`,
  launch: { kind: "harness", argv: ["claude"], cwd: tmpdir() },
});
const plainTerminal = terminal("plain-terminal", { host: THIS_MACHINE });
const remoteSeat = seat("remote-seat", { host: "mini", agentKey: "mini:remote-seat" });
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
});

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  restoreBins();
  setSeatCredentialRegistryForTests(undefined);
  setProcessIdentityMapForTests(undefined);
  setProcessEpochReaderForTests(undefined);
  clearMachines();
});

const fixture = async (nodes: ReadonlyArray<Node> = [localSeat, plainTerminal]) => {
  const root = await mkdtemp(join(tmpdir(), "junto-seat-control-"));
  const fake = makeFakeTerminalProcessAuthority(() => ({ pid: 42_818, exitOnSignal: "SIGTERM" }));
  const host = new LocalSessionHost(fake.authority, { killGraceMs: 5, shutdownGraceMs: 5, lateExitGraceMs: 5 });
  const repositories = Layer.provideMerge(Layer.mergeAll(
    WorkRepositoryLive, makeMachineRepositoryLive({ defaultName: () => THIS_MACHINE }),
  ), makeStateEngineLive(join(root, "junto.db")));
  const actors = Layer.effect(ActorSeatOccupy, Effect.gen(function* () {
    const machine = yield* MachineRepository;
    return makeActorSeatOccupy({
      local: host, localHostId: () => machine.machineName, seatEnvironment: noSeatEnvironment,
      clientForOccupy: async () => { throw new Error("local only"); },
    });
  }));
  const runtime = ManagedRuntime.make(Layer.provideMerge(actors, Layer.provideMerge(ModelStoresLive, repositories)));
  cleanups.push(async () => {
    await host.shutdownAll("test_cleanup");
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.runPromise(Effect.flatMap(ModelService, (model) => model.installCopy({
    canvas, canvasId: "seat-control-canvas", seq: 1, editor: "editor", nodes, wires: [],
  })));
  const router = {
    isLocalHostId: (id: string) => id === THIS_MACHINE,
    kill: vi.fn(async (bindingId: string) => host.kill(bindingId)),
    list: async () => host.list(),
  };
  const options: SeatControlOptions = {
    plane: { router, nodeDelete: new TerminalNodeDeleteService(router as never) } as never,
    pin: async () => ({ ok: true as const, sessionId: "named-session", minted: true }),
  };
  return { host, fake, runtime, router, options };
};

describe("seat start and stop", () => {
  it("starts a local seat by canvas and seat id, then stops it", async () => {
    const f = await fixture();
    const summary = await f.runtime.runPromise(
      startSeat({ canvas, seatId: localSeat.id, operationId: "op-cli-1" }, f.options));
    expect(summary).toMatchObject({ bindingId: localSeat.bindingId, status: "running" });
    expect(f.fake.controllers).toHaveLength(1);
    const stopped = await f.runtime.runPromise(stopSeat({ canvas, seatId: localSeat.id }, f.options));
    expect(stopped).toEqual({ outcome: "stopping" });
    expect(f.router.kill).toHaveBeenCalledWith(localSeat.bindingId, THIS_MACHINE);
    await eventually(() => expect(f.fake.controllers[0]!.signals).toContain("SIGTERM"));
  });

  it("a stop of a vacant seat says vacant", async () => {
    const f = await fixture();
    expect(await f.runtime.runPromise(stopSeat({ canvas, seatId: localSeat.id }, f.options)))
      .toEqual({ outcome: "vacant" });
  });

  it("refuses an unknown canvas, an unknown node and a plain terminal, typed", async () => {
    const f = await fixture();
    const failure = (effect: Effect.Effect<unknown, unknown, ModelService | ActorSeatOccupy>) =>
      f.runtime.runPromise(Effect.flip(effect));
    expect(await failure(startSeat({ canvas: asCanvasName("elsewhere"), seatId: localSeat.id }, f.options)))
      .toMatchObject({ _tag: "SeatNotFound", canvas: "elsewhere" });
    expect(await failure(startSeat({ canvas, seatId: "missing-node" as never }, f.options)))
      .toMatchObject({ _tag: "SeatNotFound", seatId: "missing-node" });
    expect(await failure(stopSeat({ canvas, seatId: plainTerminal.id }, f.options)))
      .toMatchObject({ _tag: "NotASeat", kind: "terminal" });
    expect(f.fake.controllers).toHaveLength(0);
  });

  it("names a local seat's session from its document launch before spawn", async () => {
    const f = await fixture();
    const pin = vi.fn(f.options.pin!);
    await f.runtime.runPromise(startSeat({ canvas, seatId: localSeat.id }, { ...f.options, pin }));
    expect(pin).toHaveBeenCalledTimes(1);
    expect(pin).toHaveBeenCalledWith({ canvasName: canvas, nodeId: localSeat.id,
      bindingId: localSeat.bindingId, harness: localSeat.harness, documentLaunch: localSeat.launch, cwd: tmpdir() });
  });

  it("a fresh start ends the session of a stopped seat, never of a running one", async () => {
    const f = await fixture();
    const pin = vi.fn(f.options.pin!);
    await f.runtime.runPromise(startSeat({ canvas, seatId: localSeat.id, resume: false }, { ...f.options, pin }));
    expect(pin.mock.calls[0]![0]).toMatchObject({ fresh: true });

    await f.runtime.runPromise(startSeat({ canvas, seatId: localSeat.id, resume: false }, { ...f.options, pin }));
    expect(pin.mock.calls[1]![0]).not.toHaveProperty("fresh");
    expect(f.fake.controllers).toHaveLength(1);
  });

  it("a seat on another machine takes the host step and leaves its session to that machine", async () => {
    const f = await fixture([remoteSeat]);
    const pin = vi.fn(f.options.pin!);
    const ensureHostAvailable = vi.fn(async () => { throw new Error("mini is not reachable"); });
    const refused = await f.runtime.runPromise(Effect.flip(startSeat({ canvas, seatId: remoteSeat.id },
      { ...f.options, pin, ensureHostAvailable })));
    expect(ensureHostAvailable).toHaveBeenCalledTimes(1);
    expect(ensureHostAvailable).toHaveBeenCalledWith("mini");
    expect(refused).toMatchObject({ _tag: "SeatStartRefused", machine: "mini", message: "mini is not reachable" });
    expect(pin).not.toHaveBeenCalled();
    expect(f.fake.controllers).toHaveLength(0);
  });

  it("a session that cannot be named refuses the start before spawn", async () => {
    const f = await fixture();
    const refused = await f.runtime.runPromise(Effect.flip(startSeat({ canvas, seatId: localSeat.id },
      { ...f.options, pin: async () => ({ ok: false as const, reason: "the session store is locked" }) })));
    expect(refused).toMatchObject({ _tag: "SeatSessionUnavailable", reason: "the session store is locked" });
    expect(f.fake.controllers).toHaveLength(0);
  });
});
