import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkChannelContext } from "../src/main/junto/link/types";
import { MachineLink, MachineLinkError } from "../src/main/junto/link/service";
import { HostsService } from "../src/main/junto/hosts/service";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { ModelService } from "../src/main/junto/model/service";
import { makeProcessIdentityMap, setProcessIdentityMapForTests } from "../src/main/junto/process-identity";
import { setProcessEpochReaderForTests } from "../src/main/junto/process-epoch";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ActorSeatOccupy, makeActorSeatOccupy } from "../src/main/junto/term/actor-seat-occupy";
import { LocalSessionHost } from "../src/main/junto/term/local-host";
import { noSeatEnvironment, type SeatEnvironmentResolver } from "../src/main/junto/term/seat-process";
import { makeSeatsChannel, type SeatsChannelOptions } from "../src/main/junto/term/seats-link";
import { makeSeatsProcessClient } from "../src/main/junto/term/seats-client";
import { getSeatCredentialRegistry, setSeatCredentialRegistryForTests } from "../src/main/junto/work/seat-credentials";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { InstallationId } from "../src/shared/installation-id";
import { asCanvasName, type Node } from "../src/shared/model";
import { EMPTY_LAUNCH_RECORD } from "../src/shared/region-environment";
import { RemoteHost } from "../src/shared/remote-hosts";
import { installHermeticHarnessBins } from "./helpers/hermetic-harness-bins";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";
import { seat, terminal } from "./support/model-nodes";
import { ModelStoresLive } from "./support/seed-canvas";
import { seedThisMachine, clearMachines } from "./support/seed-this-machine";
import { THIS_MACHINE } from "./support/machines";

const installation = Schema.decodeUnknownSync(InstallationId);
const editor = installation("editor-installation");
const canvas = asCanvasName("remote-start");
const localSeat = seat("mini-seat", {
  host: THIS_MACHINE,
  agentKey: `${THIS_MACHINE}:mini-seat`,
  launch: { kind: "harness", argv: ["claude"], cwd: tmpdir() },
});
const request = { _tag: "Start", canvas, seatId: localSeat.id };
const cleanups: Array<() => Promise<void>> = [];
let restoreBins: () => void;

beforeEach(() => {
  seedThisMachine();
  restoreBins = installHermeticHarnessBins();
  setSeatCredentialRegistryForTests(undefined);
  setProcessIdentityMapForTests(makeProcessIdentityMap({
    processAlive: () => true,
    readProcessStartKey: (pid) => `synthetic-${pid}`,
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

const fixture = async (options: {
  readonly environment?: SeatEnvironmentResolver;
  readonly pin?: SeatsChannelOptions["pin"];
  readonly editor?: string;
  readonly nodes?: ReadonlyArray<Node>;
} = {}) => {
  const root = await mkdtemp(join(tmpdir(), "junto-seats-link-"));
  const fake = makeFakeTerminalProcessAuthority(() => ({ pid: 42_818, exitOnSignal: "SIGTERM" }));
  const host = new LocalSessionHost(fake.authority, {
    killGraceMs: 5, shutdownGraceMs: 5, lateExitGraceMs: 5,
  });
  const repositories = Layer.provideMerge(Layer.mergeAll(
    WorkRepositoryLive,
    makeMachineRepositoryLive({ defaultName: () => THIS_MACHINE }),
  ), makeStateEngineLive(join(root, "junto.db")));
  const actors = Layer.effect(ActorSeatOccupy, Effect.gen(function* () {
    const machine = yield* MachineRepository;
    return makeActorSeatOccupy({
      local: host,
      localHostId: () => machine.machineName,
      clientForOccupy: async () => { throw new Error("a receiving machine cannot forward a start"); },
      seatEnvironment: options.environment ?? noSeatEnvironment,
    });
  }));
  const runtime = ManagedRuntime.make(Layer.provideMerge(
    actors, Layer.provideMerge(ModelStoresLive, repositories),
  ));
  cleanups.push(async () => {
    await host.shutdownAll("test_cleanup");
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.runPromise(Effect.flatMap(MachineRepository, (machine) =>
    machine.pinPeer({ machineName: "macbook", installationId: editor })));
  const copy = (seq: number, nodes = options.nodes ?? [localSeat]) => runtime.runPromise(
    Effect.flatMap(ModelService, (model) => model.installCopy({
      canvas, canvasId: "copied-canvas", seq, editor: options.editor ?? editor, nodes, wires: [],
    })),
  );
  await copy(1);
  const pin = vi.fn(options.pin ?? (async () => ({ ok: true as const, sessionId: "named-session", minted: true })));
  const channel = await runtime.runPromise(makeSeatsChannel({ host, pin }));
  const controller = new AbortController();
  const context: LinkChannelContext = {
    peer: { build: "same-build", installationId: editor, machineName: "macbook" },
    sessionId: "admitted-link", signal: controller.signal,
    sendEvent: () => Effect.void,
    request: () => Effect.die("the start receiver must not send requests"),
  };
  const start = (raw: unknown = request, caller = context) =>
    runtime.runPromise(channel.handleRequest(caller, raw));
  return { host, fake, runtime, channel, controller, context, start, pin, copy };
};

describe("seats link start", () => {
  it("starts the local copy with a live generation credential and keeps secrets on its machine", async () => {
    const secret = "resolved-on-the-seat-machine";
    const environment = vi.fn(async () => ({
      env: { LOCAL_SECRET: secret }, folders: [], record: EMPTY_LAUNCH_RECORD,
    }));
    const f = await fixture({ environment });
    const response = await f.start();
    expect(response).toMatchObject({
      _tag: "Started", canvas, seatId: localSeat.id, machine: THIS_MACHINE, status: "running",
    });
    expect(f.pin).toHaveBeenCalledWith(expect.objectContaining({
      bindingId: localSeat.bindingId, harness: "claude", cwd: tmpdir(), documentLaunch: localSeat.launch,
    }));
    expect(environment).toHaveBeenCalledWith({ canvasName: canvas, nodeId: localSeat.id });
    expect(f.fake.controllers).toHaveLength(1);
    const spawn = f.fake.controllers[0]!.spec;
    expect(spawn.cwd).toBe(tmpdir());
    expect(spawn.env?.LOCAL_SECRET).toBe(secret);
    const token = spawn.env!.JUNTO_WORK_TOKEN!;
    expect(getSeatCredentialRegistry().lookup(token)).toMatchObject({
      status: "live", principal: { canvasName: canvas, nodeId: localSeat.id, agentKey: localSeat.agentKey },
    });
    expect(JSON.stringify(response)).not.toContain(token);
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(await f.start()).toEqual(response);
    expect(f.fake.controllers).toHaveLength(1);
    f.controller.abort();
    expect(f.host.get(localSeat.bindingId)?.status).toBe("running");
    await expect(f.start()).rejects.toThrow("link has closed");
  });

  it.each(["argv", "environment", "cwd", "pid", "token", "bindingId", "launch"])(
    "rejects peer-supplied %s before session preparation", async (field) => {
      const f = await fixture();
      const raw = { ...request, [field]: "not-a-launch-grant" };
      expect(() => f.channel.decodeRequest(raw)).toThrow();
      await expect(f.start(raw)).rejects.toThrow();
      expect(f.pin).not.toHaveBeenCalled();
      expect(f.fake.controllers).toHaveLength(0);
    },
  );

  it("refuses a pinned machine that is not the editor", async () => {
    const f = await fixture({ editor: "another-editor" });
    await expect(f.start()).rejects.toThrow("Only the machine editing");
    expect(f.pin).not.toHaveBeenCalled();
  });

  it("refuses a retired or changed peer pin", async () => {
    const f = await fixture();
    await f.runtime.runPromise(Effect.flatMap(MachineRepository, (machine) => machine.retirePeer("macbook")));
    await expect(f.start()).rejects.toThrow("no longer pinned");
    expect(f.pin).not.toHaveBeenCalled();
  });

  it.each([
    seat("mini-seat", { host: "macbook" }),
    terminal("mini-seat"),
  ])("refuses a seat of another machine or a plain terminal ($kind)", async (node) => {
    const f = await fixture({ nodes: [node] });
    await expect(f.start()).rejects.toThrow("does not run that seat");
    expect(f.pin).not.toHaveBeenCalled();
    expect(f.fake.controllers).toHaveLength(0);
  });

  it("refuses a disconnected link after session preparation", async () => {
    let disconnect: () => void = () => undefined;
    const f = await fixture({ pin: async () => {
      disconnect();
      return { ok: true, sessionId: "named-session", minted: true };
    } });
    disconnect = () => f.controller.abort();
    await expect(f.start()).rejects.toThrow("link has closed");
    expect(f.fake.controllers).toHaveLength(0);
  });

  it("rechecks a replacement copy after asynchronous environment resolution", async () => {
    let replace: () => Promise<void> = async () => undefined;
    const f = await fixture({ environment: async () => {
      await replace();
      return noSeatEnvironment({ canvasName: canvas, nodeId: localSeat.id });
    } });
    replace = async () => { await f.copy(2); };
    await expect(f.start()).rejects.toThrow("seat changed while");
    expect(f.fake.controllers).toHaveLength(0);
  });

  it("rechecks peer revocation after asynchronous environment resolution", async () => {
    let retire: () => Promise<void> = async () => undefined;
    const f = await fixture({ environment: async () => {
      await retire();
      return noSeatEnvironment({ canvasName: canvas, nodeId: localSeat.id });
    } });
    retire = async () => { await f.runtime.runPromise(Effect.flatMap(MachineRepository, (machine) => machine.retirePeer("macbook"))); };
    await expect(f.start()).rejects.toThrow("no longer pinned");
    expect(f.fake.controllers).toHaveLength(0);
  });

  it("refuses missing required launch sources without spawning", async () => {
    const f = await fixture({ environment: async () => ({
      env: {}, folders: [], record: EMPTY_LAUNCH_RECORD, refusal: "Required source is missing.",
    }) });
    await expect(f.start()).rejects.toThrow("Required source is missing");
    expect(f.fake.controllers).toHaveLength(0);
  });

  it("reads occupancy without starting and activates only the exact live generation", async () => {
    const f = await fixture();
    expect(await f.start({ ...request, _tag: "Get" })).toEqual({
      _tag: "Vacant", canvas, seatId: localSeat.id, machine: THIS_MACHINE,
    });
    await expect(f.start({ ...request, _tag: "Activate", generation: "old" })).rejects.toThrow("vacant");
    expect(f.pin).not.toHaveBeenCalled();
    expect(f.fake.controllers).toHaveLength(0);
    const started = f.channel.decodeResponse(await f.start()) as { generation: string };
    expect(await f.start({ ...request, _tag: "Get" })).toEqual(started);
    expect(await f.start({ ...request, _tag: "Activate", generation: started.generation })).toEqual(started);
    await expect(f.start({ ...request, _tag: "Activate", generation: "old" })).rejects.toThrow("generation changed");
    expect(f.fake.controllers).toHaveLength(1);
    expect(f.pin).toHaveBeenCalledOnce();
  });

  it("routes the process client over the seats link without forwarding a launch plan", async () => {
    const f = await fixture();
    const host = Schema.decodeUnknownSync(RemoteHost)({
      id: THIS_MACHINE, label: "Mini", isThisMachine: false, sshEndpoint: "mini", capabilities: ["terminal"],
    });
    const requestLink = vi.fn((_machine: string, channel: string, payload: unknown) => {
      expect(channel).toBe("seats");
      return f.channel.handleRequest(f.context, payload).pipe(Effect.mapError((cause) =>
        new MachineLinkError(cause instanceof Error ? cause.message : String(cause))));
    });
    const unused = Effect.die("unused machine operation");
    const links = MachineLink.of({
      setChannels: () => unused, listen: () => unused,
      connect: () => Effect.succeed({ machineName: THIS_MACHINE, installationId: editor, boundAt: "2026-10-09" }),
      connectSetup: () => unused, disconnect: () => unused, peerBuild: () => unused,
      sendEvent: () => unused, request: requestLink,
    });
    const hosts = HostsService.of({
      get: () => Effect.succeed(host), list: unused, doctor: unused, doctorSnapshot: unused,
      upsert: () => unused, remove: () => unused, test: () => unused,
    });
    const client = makeSeatsProcessClient(THIS_MACHINE, (effect) => f.runtime.runPromise(effect.pipe(
      Effect.provideService(HostsService, hosts), Effect.provideService(MachineLink, links),
    )));
    expect(await client.get(localSeat.bindingId)).toBeUndefined();
    const live = await client.createAgentSeat({
      admission: "occupy", bindingId: localSeat.bindingId, canvasName: canvas, nodeId: localSeat.id,
      harness: localSeat.harness, agentKey: localSeat.agentKey,
      spawnIntent: { documentLaunch: { kind: "harness", argv: ["untrusted-executable"], cwd: "/untrusted-folder" }, resumeRequested: false },
    });
    expect(live).toMatchObject({ bindingId: localSeat.bindingId, nodeId: localSeat.id, hostId: THIS_MACHINE, status: "running" });
    expect(await client.get(localSeat.bindingId)).toEqual(live);
    expect(requestLink.mock.calls.map((call) => call[2])).toEqual([
      { ...request, _tag: "Get" }, request, { ...request, _tag: "Get" },
    ]);
    expect(f.fake.controllers[0]?.spec.cwd).toBe(tmpdir());
    expect(f.fake.controllers[0]?.spec.command).not.toContain("untrusted");
    expect(await client.createAgentSeat({
      admission: "activate", bindingId: localSeat.bindingId, canvasName: canvas, nodeId: localSeat.id,
      harness: localSeat.harness, agentKey: localSeat.agentKey, expectedEpoch: live.epoch,
    })).toEqual(live);
    expect(f.fake.controllers).toHaveLength(1);
  });
});
