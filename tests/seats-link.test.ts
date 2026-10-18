import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkChannelContext } from "../src/main/junto/link/types";
import { LinkUnavailable, MachineLink } from "../src/main/junto/link/service";
import { LinkRequestFailed } from "../src/main/junto/link/types";
import { encodeError } from "../src/main/junto/failure-encode";
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
import { SeatsFailure } from "../src/main/junto/term/seats-failure";
import {
  agentSeatStatusOf, encodeAgentSeatStatus, type AgentSeatStateEvent, type AgentSeatStatusWire,
} from "../src/shared/agent-seat-state";
import { topNeed, type BindingId, type SeatSnapshot } from "../src/shared/harness-domain";
import { toSeatsStatus } from "../src/main/junto/term/seats-status";
import { toSeatsLaunch, type SeatLaunchState } from "../src/main/junto/term/seats-launch";
import { heldRemoteSeatLaunch, resetRemoteSeatLaunches } from "../src/main/junto/term/remote-seat-launch";
import { closeMachineLog, installMachineLog, ObservabilityLoggerLive, withMachineLogger } from "../src/main/junto/observability/logger";
import { machineLogDir } from "../src/main/junto/observability/log-file";
import { readFileSync } from "node:fs";
import { getSeatCredentialRegistry, setSeatCredentialRegistryForTests } from "../src/main/junto/work/seat-credentials";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { SeatSessionRepositoryLive } from "../src/main/junto/seat-sessions/repository";
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
  resetRemoteSeatLaunches();
});

const fixture = async (options: {
  readonly environment?: SeatEnvironmentResolver;
  readonly pin?: SeatsChannelOptions["pin"];
  readonly editor?: string;
  readonly nodes?: ReadonlyArray<Node>;
  readonly spawnError?: Error;
  readonly seatStates?: SeatsChannelOptions["seatStates"];
  readonly publishState?: SeatsChannelOptions["publishState"];
  readonly launchState?: SeatsChannelOptions["launchState"] | "this runtime's";
} = {}) => {
  const root = await mkdtemp(join(tmpdir(), "junto-seats-link-"));
  const fake = makeFakeTerminalProcessAuthority(() => ({ pid: 42_818, exitOnSignal: "SIGTERM" }));
  const authority = options.spawnError === undefined ? fake.authority : {
    ...fake.authority, spawnTerminal: () => { throw options.spawnError; },
  };
  const host = new LocalSessionHost(authority, {
    killGraceMs: 5, shutdownGraceMs: 5, lateExitGraceMs: 5,
  });
  const repositories = Layer.provideMerge(Layer.mergeAll(
    WorkRepositoryLive,
    SeatSessionRepositoryLive,
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
  // As the core builds it: forked fibers (occupy's own run) log through the machine logger.
  const runtime = ManagedRuntime.make(withMachineLogger(Layer.provideMerge(
    actors, Layer.provideMerge(ModelStoresLive, repositories),
  )));
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
  const channel = await runtime.runPromise(makeSeatsChannel({ host, pin,
    seatStates: options.seatStates ?? { subscribe: () => () => undefined, currentEvents: () => [] },
    publishState: options.publishState ?? (() => undefined),
    ...(options.launchState === "this runtime's" ? {} : { launchState: options.launchState ?? (async () => undefined) }) }));
  const sent = vi.fn((_channel: string, _payload: unknown) => Effect.void);
  const controller = new AbortController();
  const context: LinkChannelContext = {
    peer: { build: "same-build", installationId: editor, machineName: "macbook" },
    sessionId: "admitted-link", signal: controller.signal,
    sendEvent: sent, close: () => Effect.void,
    request: () => Effect.die("the start receiver must not send requests"),
  };
  const start = (raw: unknown = request, caller = context) =>
    runtime.runPromise(channel.handleRequest(caller, raw).pipe(Effect.provide(ObservabilityLoggerLive)));
  return { host, fake, runtime, channel, controller, context, start, pin, copy, sent };
};

const linkedClient = (f: Awaited<ReturnType<typeof fixture>>) => {
  const host = Schema.decodeUnknownSync(RemoteHost)({
    id: THIS_MACHINE, label: "Mini", isThisMachine: false, sshEndpoint: "mini", capabilities: ["terminal"],
  });
  const requestLink = vi.fn((_machine: string, _channel: string, payload: unknown, options?: { readonly operationId?: string }) =>
    // What the link does with a channel failure: encode it under the channel's
    // failureSchema, send it, and decode it closed as the requester's detail.
    f.channel.handleRequest({ ...f.context, ...(options?.operationId ? { operationId: options.operationId } : {}) }, payload)
      .pipe(Effect.mapError((cause) => {
        const schema = f.channel.failureSchema!;
        const detail = Schema.decodeUnknownSync(schema)(JSON.parse(JSON.stringify(Schema.encodeSync(schema)(cause))));
        const operationId = options?.operationId ?? "link-minted";
        return new LinkRequestFailed({ machine: THIS_MACHINE, channel: "seats", operationId,
          failure: encodeError(cause, { machine: THIS_MACHINE, operationId }), detail, message: String(cause) });
      })));
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
  return { requestLink, client: makeSeatsProcessClient(THIS_MACHINE, (effect) => f.runtime.runPromise(effect.pipe(
    Effect.provideService(HostsService, hosts), Effect.provideService(MachineLink, links),
  ))) };
};

const stateEvent = (reason: string, state: AgentSeatStateEvent["state"] = "working"): AgentSeatStateEvent => ({
  bindingId: localSeat.bindingId, epoch: "ep_1", state, reason, confidence: "high", at: 1_792_000_000_000,
});

describe("seats link state", () => {
  it("sends this machine's seat states to the machine editing the canvas, rule ids only", async () => {
    let emit: (event: AgentSeatStateEvent) => void = () => undefined;
    const f = await fixture({ seatStates: {
      subscribe: (listener) => { emit = listener; return () => { emit = () => undefined; }; },
      currentEvents: () => [stateEvent("hook:Allow edit to secrets.env?", "attention")],
    } });
    await f.runtime.runPromise(f.channel.opened!(f.context));
    await eventually(() => expect(f.sent).toHaveBeenCalledTimes(1));
    expect(f.sent.mock.calls[0]).toEqual(["seats", {
      _tag: "SeatState", canvas, seatId: localSeat.id, machine: THIS_MACHINE, epoch: "ep_1",
      state: "attention", confidence: "high", at: 1_792_000_000_000, reason: "attention",
    }]);
    emit(stateEvent("rule:claude.spinner"));
    await eventually(() => expect(f.sent).toHaveBeenCalledTimes(2));
    expect(f.sent.mock.calls[1]?.[1]).toMatchObject({ state: "working", reason: "rule:claude.spinner" });
    emit({ ...stateEvent("rule:x"), bindingId: "another-binding" });
    f.controller.abort();
    emit(stateEvent("rule:after-close"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.sent).toHaveBeenCalledTimes(2);
  });

  it("sends nothing to a machine that does not edit the canvas", async () => {
    const f = await fixture({ editor: "another-editor", seatStates: {
      subscribe: () => () => undefined, currentEvents: () => [stateEvent("rule:x")],
    } });
    await f.runtime.runPromise(f.channel.opened!(f.context));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.sent).not.toHaveBeenCalled();
  });

  it("publishes a state only for a seat the sending machine runs", async () => {
    const published: AgentSeatStateEvent[] = [];
    const remote = seat("mac-seat", { host: "macbook", agentKey: "macbook:mac-seat" });
    const f = await fixture({ nodes: [localSeat, remote], publishState: (event) => { published.push(event); } });
    const wire = { _tag: "SeatState", canvas, seatId: remote.id, machine: "macbook", epoch: "ep_9",
      state: "idle", confidence: "low", at: 5, reason: "idle" };
    await f.runtime.runPromise(f.channel.handleEvent!(f.context, f.channel.decodeEvent(wire)));
    expect(published).toEqual([{ bindingId: remote.bindingId, epoch: "ep_9", state: "idle", reason: "idle",
      confidence: "low", at: 5, harness: remote.harness }]);
    // A state for a seat the sender does not run is refused and logged, never a
    // handler failure: the link session closes the whole link on one.
    await f.runtime.runPromise(f.channel.handleEvent!(f.context,
      f.channel.decodeEvent({ ...wire, seatId: localSeat.id })));
    expect(() => f.channel.decodeEvent({ ...wire, reason: "hook:free text" })).toThrow();
    // A canvas this machine does not hold: dropped quietly, not a failure.
    await f.runtime.runPromise(f.channel.handleEvent!(f.context,
      f.channel.decodeEvent({ ...wire, canvas: asCanvasName("not-held-here") })));
    expect(published).toHaveLength(1);
  });
});

describe("seats link status", () => {
  const blocked = (): AgentSeatStatusWire => {
    const snapshot: SeatSnapshot = {
      seat: localSeat.bindingId as BindingId,
      status: { _tag: "Blocked", reason: { _tag: "Error", kind: "auth", message: "Not logged in" } },
      since: 1_792_000_000_000, statusSource: "screen", statusFidelity: "screen", channels: ["screen"],
      sessionId: "session-on-the-mini", transcriptPath: "/Users/mini/.claude/projects/t.jsonl",
      turnUnseen: { outcome: "completed", since: 1_792_000_000_000 },
      reports: [], awareness: [], updatedAt: 1_792_000_000_000,
    };
    return encodeAgentSeatStatus({ snapshot, need: topNeed(snapshot) });
  };

  it("a seat state carries its status, built from the approved fields", async () => {
    const f = await fixture({ seatStates: {
      subscribe: () => () => undefined,
      currentEvents: () => [{ ...stateEvent("rule:claude.not_logged_in", "attention"), status: blocked() }],
    } });
    await f.runtime.runPromise(f.channel.opened!(f.context));
    await eventually(() => expect(f.sent).toHaveBeenCalledTimes(1));
    const wire = f.sent.mock.calls[0]?.[1] as { status: { snapshot: Record<string, unknown> } };
    expect(wire.status.snapshot.status).toEqual({ _tag: "Blocked", reason: { _tag: "Error", kind: "auth" } });
    expect(JSON.stringify(wire)).not.toMatch(/Not logged in|session-on-the-mini|\/Users\/mini/u);
  });

  it("the receiver publishes a status that reads, and refuses one that does not without failing", async () => {
    const published: AgentSeatStateEvent[] = [];
    const remote = seat("mac-seat", { host: "macbook", agentKey: "macbook:mac-seat" });
    const f = await fixture({ nodes: [localSeat, remote], publishState: (event) => { published.push(event); } });
    const status = toSeatsStatus(agentSeatStatusOf({ ...stateEvent("x"), status: blocked() })!, Date.now())!;
    const wire = { _tag: "SeatState", canvas, seatId: remote.id, machine: "macbook", epoch: "ep_9",
      state: "attention", confidence: "high", at: 5, reason: "attention", status };
    await f.runtime.runPromise(f.channel.handleEvent!(f.context, f.channel.decodeEvent(wire)));
    expect(agentSeatStatusOf(published[0])?.snapshot).toMatchObject({
      seat: remote.bindingId, status: { _tag: "Blocked", reason: { _tag: "Error", kind: "auth" } },
    });
    expect(agentSeatStatusOf(published[0])?.snapshot.sessionId).toBeUndefined();
    // A status with a field the wire does not name: that event is refused and logged, the link stays.
    await f.runtime.runPromise(f.channel.handleEvent!(f.context, f.channel.decodeEvent({
      ...wire, status: { ...status, snapshot: { ...status.snapshot, transcriptPath: "/etc/passwd" } },
    })).pipe(Effect.provide(ObservabilityLoggerLive)));
    expect(published).toHaveLength(1);
  });

  it("a view lands on the occupant of that generation, and only from the canvas editor", async () => {
    const viewed: string[] = [];
    const f = await fixture({ seatStates: {
      subscribe: () => () => undefined, currentEvents: () => [],
      viewed: (bindingId) => { viewed.push(bindingId); return viewed.length === 1 ? {} : null; },
    } });
    const linked = linkedClient(f);
    expect(await f.start({ ...request, _tag: "Viewed", generation: "ep_none" })).toEqual({
      _tag: "Vacant", canvas, seatId: localSeat.id, machine: THIS_MACHINE,
    });
    const started = f.channel.decodeResponse(await f.start()) as { generation: string };
    await expect(f.start({ ...request, _tag: "Viewed", generation: "old" }))
      .rejects.toMatchObject({ _tag: "SeatEpochChanged", expectedEpoch: "old", actualEpoch: started.generation });
    expect(await linked.client.viewed(localSeat.bindingId, started.generation, "op-view-1")).toBe(true);
    expect(linked.requestLink.mock.calls.at(-1)?.[3]).toEqual({ operationId: "op-view-1" });
    expect(await linked.client.viewed(localSeat.bindingId, started.generation, "op-view-2")).toBe(false);
    expect(viewed).toEqual([localSeat.bindingId, localSeat.bindingId]);

    const other = await fixture({ editor: "another-editor" });
    await expect(other.start({ ...request, _tag: "Viewed", generation: "ep_1" }))
      .rejects.toMatchObject({ _tag: "SeatCanvasEditorMismatch" });
  });
});

describe("seats link launch state", () => {
  const warm = (): SeatLaunchState => ({ hasSession: true, next: "resume", nextTurn: { fresh: false, freshAt: Date.now() + 600_000 } });

  it("a forwarded state carries the seat's launch state as a duration, and an exit carries none", async () => {
    const asked: string[] = [];
    const f = await fixture({
      seatStates: { subscribe: () => () => undefined,
        currentEvents: () => [stateEvent("rule:claude.prompt_box", "idle"), { ...stateEvent("gone", "gone"), bindingId: localSeat.bindingId }] },
      launchState: async (name, node) => { asked.push(`${name}/${node.id}`); return warm(); },
    });
    await f.runtime.runPromise(f.channel.opened!(f.context));
    await eventually(() => expect(f.sent).toHaveBeenCalledTimes(2));
    const wires = f.sent.mock.calls.map((call) => call[1] as { state: string; launch?: { nextTurn?: { freshInMs?: number } } });
    const idle = wires.find((wire) => wire.state === "idle")!;
    expect(idle.launch).toMatchObject({ hasSession: true, next: "resume", nextTurn: { fresh: false } });
    expect(idle.launch?.nextTurn?.freshInMs).toBeGreaterThan(590_000);
    expect(idle.launch?.nextTurn?.freshInMs).toBeLessThanOrEqual(600_000);
    expect(wires.find((wire) => wire.state === "gone")).not.toHaveProperty("launch");
    expect(asked).toEqual([`${canvas}/${localSeat.id}`]);
  });

  it("Get's Vacant carries it, read on the asking machine's clock; other answers stay bare", async () => {
    const f = await fixture({ launchState: async () => warm() });
    const vacant = await f.start({ ...request, _tag: "Get" }) as { launch?: unknown };
    expect(vacant).toMatchObject({ _tag: "Vacant", launch: { hasSession: true, next: "resume", nextTurn: { fresh: false } } });
    expect(await f.start({ ...request, _tag: "Stop" })).toEqual({ _tag: "Vacant", canvas, seatId: localSeat.id, machine: THIS_MACHINE });
    expect(await f.start({ ...request, _tag: "Viewed", generation: "ep_none" }))
      .toEqual({ _tag: "Vacant", canvas, seatId: localSeat.id, machine: THIS_MACHINE });
    const read = await linkedClient(f).client.launch(localSeat.bindingId);
    expect(read).toMatchObject({ hasSession: true, next: "resume", nextTurn: { fresh: false } });
    expect(read?.nextTurn?.freshAt).toBeGreaterThan(Date.now() + 590_000);
    // A seat that cannot say answers bare.
    const silent = await fixture({ launchState: async () => { throw new Error("no repository"); } });
    expect(await silent.start({ ...request, _tag: "Get" })).toEqual({ _tag: "Vacant", canvas, seatId: localSeat.id, machine: THIS_MACHINE });
  });

  it("by default it is read from the sessions of the runtime the channel runs in", async () => {
    const f = await fixture({ launchState: "this runtime's" });
    expect(await f.start({ ...request, _tag: "Get" })).toEqual({
      _tag: "Vacant", canvas, seatId: localSeat.id, machine: THIS_MACHINE, launch: { hasSession: false, next: "fresh" },
    });
  });

  it("the receiver holds a launch state that reads, refuses one that does not, and drops it when the link closes", async () => {
    const published: AgentSeatStateEvent[] = [];
    const remote = seat("mac-seat", { host: "macbook", agentKey: "macbook:mac-seat" });
    const f = await fixture({ nodes: [localSeat, remote], publishState: (event) => { published.push(event); } });
    const wire = { _tag: "SeatState", canvas, seatId: remote.id, machine: "macbook", epoch: "ep_9",
      state: "idle", confidence: "high", at: 5, reason: "idle", launch: toSeatsLaunch(warm(), Date.now()) };
    await f.runtime.runPromise(f.channel.opened!(f.context));
    await f.runtime.runPromise(f.channel.handleEvent!(f.context, f.channel.decodeEvent(wire)));
    expect(published).toHaveLength(1);
    expect(heldRemoteSeatLaunch(remote.bindingId, "macbook", Date.now())).toMatchObject({ next: "resume", nextTurn: { fresh: false } });
    // Over its bound: that event is refused and logged, the link stays and the answer held stays.
    await f.runtime.runPromise(f.channel.handleEvent!(f.context, f.channel.decodeEvent({
      ...wire, epoch: "ep_10", launch: { hasSession: true, next: "resume", nextTurn: { fresh: false, freshInMs: Number.MAX_SAFE_INTEGER } },
    })).pipe(Effect.provide(ObservabilityLoggerLive)));
    expect(published).toHaveLength(1);
    expect(heldRemoteSeatLaunch(remote.bindingId, "macbook", Date.now())).toBeDefined();
    f.controller.abort();
    expect(heldRemoteSeatLaunch(remote.bindingId, "macbook", Date.now())).toBeUndefined();
  });
});

describe("seats link start", () => {
  it("returns a remote spawn failure as the exited generation a local start returns", async () => {
    const missing = join(tmpdir(), "junto-seats-link-missing-folder");
    const broken = seat("mini-seat", { host: THIS_MACHINE, agentKey: `${THIS_MACHINE}:mini-seat`,
      launch: { kind: "harness", argv: ["claude"], cwd: missing } });
    const f = await fixture({ nodes: [broken] });
    const linked = linkedClient(f);
    const live = await linked.client.createAgentSeat({
      admission: "occupy", bindingId: broken.bindingId, canvasName: canvas, nodeId: broken.id,
      harness: broken.harness, agentKey: broken.agentKey,
      spawnIntent: { documentLaunch: broken.launch!, resumeRequested: false },
    }, "op-start-1");
    expect(linked.requestLink.mock.calls.map((call) => call[3])).toEqual([{ operationId: "op-start-1" }]);
    expect(live).toMatchObject({
      bindingId: broken.bindingId, hostId: THIS_MACHINE, nodeId: broken.id, status: "exited",
      exitReason: "spawn_failed", epoch: f.host.get(broken.bindingId)?.epoch,
    });
    expect(live.exitMessage).toBe(`Claude Code could not start: the folder ${missing} does not exist`);
  });

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

  it("answers a spawn failure with its classified cause, not a changed occupant", async () => {
    const missing = join(tmpdir(), "junto-seats-link-missing-folder");
    const broken = seat("mini-seat", { host: THIS_MACHINE, agentKey: `${THIS_MACHINE}:mini-seat`,
      launch: { kind: "harness", argv: ["claude"], cwd: missing } });
    const f = await fixture({ nodes: [broken] });
    const failure = await f.start().then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({
      _tag: "SeatSpawnFailed", machine: THIS_MACHINE, canvas, seatId: broken.id,
      bindingId: broken.bindingId, harness: "claude", exitReason: "spawn_failed",
    });
    // Asserted apart: an asymmetric matcher inside toMatchObject is written back into the value under bun test.
    expect((failure as { exitMessage: string }).exitMessage).toBe(
      `Claude Code could not start: the folder ${missing} does not exist`);
    expect(Schema.is(SeatsFailure)(failure)).toBe(true);
    expect(JSON.stringify(Schema.encodeSync(SeatsFailure)(failure as SeatsFailure))).not.toContain("JUNTO_WORK_TOKEN");
    expect(f.fake.controllers).toHaveLength(0);
  });

  it("logs a spawn error that quotes a seat's region secret redacted", async () => {
    const secret = "plain-region-value-7f3k2";
    const home = await mkdtemp(join(tmpdir(), "junto-seats-log-"));
    cleanups.push(async () => { closeMachineLog(); await rm(home, { recursive: true, force: true }); });
    installMachineLog({ home, process: "core", echo: false });
    const f = await fixture({
      environment: async () => ({ env: { REGION_SECRET: secret, STAGE: "prod" }, folders: [], record: EMPTY_LAUNCH_RECORD }),
      spawnError: new Error(`spawn refused for ${localSeat.agentKey} in prod with ${secret} in its text`),
    });
    const failure = await f.start().then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ _tag: "SeatSpawnFailed" });
    expect((failure as { exitMessage: string }).exitMessage).toContain(secret);
    const log = readFileSync(join(machineLogDir(home), "core.jsonl"), "utf8");
    const rows = log.split("\n").filter((line) => line.includes("seat start failed"));
    expect(rows.length).toBeGreaterThan(0);
    expect(log).not.toContain(secret);
    expect(rows.join("\n")).toContain("[redacted]");
    // The seat's name (JUNTO_SEAT) and a short region word are in its
    // environment, and neither is a secret.
    expect(rows.join("\n")).toContain(`for ${localSeat.agentKey} in prod with [redacted]`);
  });

  it("stops a running seat over the link and answers vacant when nothing runs", async () => {
    const f = await fixture();
    const linked = linkedClient(f);
    expect(await linked.client.stop(localSeat.bindingId, "op-stop-0")).toBe(false);
    expect(await f.start({ ...request, _tag: "Stop" })).toEqual({
      _tag: "Vacant", canvas, seatId: localSeat.id, machine: THIS_MACHINE,
    });
    const started = f.channel.decodeResponse(await f.start()) as { generation: string };
    await expect(f.start({ ...request, _tag: "Stop", generation: "old" }))
      .rejects.toMatchObject({ _tag: "SeatEpochChanged", expectedEpoch: "old", actualEpoch: started.generation });
    expect(f.fake.controllers[0]!.signals).toEqual([]);
    expect(await linked.client.stop(localSeat.bindingId, "op-stop-1")).toBe(true);
    expect(linked.requestLink.mock.calls.at(-1)?.[3]).toEqual({ operationId: "op-stop-1" });
    expect(f.fake.controllers[0]!.signals).toContain("SIGTERM");
  });

  it("refuses a stop from a machine that does not edit the canvas", async () => {
    const f = await fixture({ editor: "another-editor" });
    await expect(f.start({ ...request, _tag: "Stop" })).rejects.toMatchObject({ _tag: "SeatCanvasEditorMismatch" });
  });

  it("answers each refusal with its own tag", async () => {
    const editorless = await fixture({ editor: "another-editor" });
    await expect(editorless.start()).rejects.toMatchObject({ _tag: "SeatCanvasEditorMismatch", peer: "macbook" });
    const foreign = await fixture({ nodes: [seat("mini-seat", { host: "macbook" })] });
    await expect(foreign.start()).rejects.toMatchObject({ _tag: "SeatNotOnThisMachine", seatHost: "macbook" });
    const unpinned = await fixture();
    await unpinned.runtime.runPromise(Effect.flatMap(MachineRepository, (machine) => machine.retirePeer("macbook")));
    await expect(unpinned.start()).rejects.toMatchObject({ _tag: "SeatPeerNotPinned" });
    const vacant = await fixture();
    await expect(vacant.start({ ...request, _tag: "Activate", generation: "old" })).rejects.toMatchObject({ _tag: "SeatMissing" });
    const unavailable = await fixture({ pin: async () => ({ ok: false as const, reason: "thread is gone" }) });
    await expect(unavailable.start()).rejects.toMatchObject({ _tag: "SeatSessionUnavailable", reason: "thread is gone" });
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
        new LinkUnavailable({ reason: "not-linked", message: cause instanceof Error ? cause.message : String(cause) })));
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
