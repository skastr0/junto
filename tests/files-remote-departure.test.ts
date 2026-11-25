/**
 * A Files node leaving the machine its folder is on (0.12.1, X6, remote-
 * security C2 and remote-lead's retarget test), end to end between two real
 * machines: moved to another machine or deleted, the node and its root go
 * from that machine. With another reason there it keeps a stub with no root;
 * with none it is sent the departure copy, once.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationRunnerLive, AutomationRunnerService } from "../src/core/automation/live";
import { noBoatWakeLayer } from "./support/no-boat";
import { AutomationRepository, makeAutomationRepositoryLive } from "../src/core/automation/repository";
import { submitAutomationCommand } from "../src/core/automation/ruler";
import { makeContentServiceLive } from "../src/core/content/service";
import { makeInstallOpsLive } from "../src/core/install-ops/engine";
import { MachineRepository, makeMachineRepositoryLive } from "../src/core/machines/repository";
import { PausePlaneLive } from "../src/core/pause-plane-live";
import { FactoryPauseRepositoryLive } from "../src/core/pause/repository";
import { ReferencesRepositoryLive } from "../src/core/references/repository";
import { SeatGuidanceRepositoryLive } from "../src/core/seat-guidance/repository";
import { AgentSignalRepositoryLive } from "../src/core/signals/repository";
import { makeSettingsLive } from "../src/core/settings/service";
import { makeStateEngineLive } from "../src/core/state/engine";
import { CrewRepositoryLive } from "../src/core/work/crew-repository";
import type { RowsChannelContext } from "../src/core/work/exchange/channel";
import { rowsChannel, rowsWire } from "./support/rows-channel";
import { makeLiveRowExchange } from "../src/core/work/exchange/live";
import type { RowExchange } from "../src/core/work/exchange/session";
import { WorkRepository, WorkRepositoryLive } from "../src/core/work/repository";
import { makeResourceSubmitLayer } from "../src/core/work/resource-submit";
import { RulingRecorderLive } from "../src/core/work/ruling-recorder";
import { TaskRepository, TaskRepositoryLive } from "../src/core/work/task-repository";
import { ArtifactRepositoryLive } from "../src/core/work/artifact-repository";
import { ResourceRuler, ResourceRulerLive } from "../src/core/work/resource-ruler";
import { ModelService } from "../src/core/model/service";
import { WorkLive, WorkService } from "../src/core/work/service";
import type { AutomationEnv } from "../src/shared/automation-domain";
import { InstallationId } from "../src/shared/installation-id";
import { Command } from "../src/shared/model";
import { asNodeId } from "../src/shared/physics/schema";
import type { ResourceCommand } from "../src/shared/resource-command";
import { files, seat } from "./support/model-nodes";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { termPlane } from "../src/core/term/plane";
import { makeTestLog } from "./support/test-log";

const testLog = makeTestLog();

const id = Schema.decodeUnknownSync(InstallationId);
const MACBOOK = id("macbook-installation");
const MINI = id("mini-installation");
const command = Schema.decodeUnknownSync(Command);

const makeRuntime = (root: string, name: string, installation: InstallationId) => {
  const stores = Layer.provideMerge(
    Layer.mergeAll(WorkLive, makeAutomationRepositoryLive(), RulingRecorderLive),
    Layer.provideMerge(
      ModelStoresLive,
      Layer.provideMerge(
        Layer.mergeAll(
          WorkRepositoryLive,
          CrewRepositoryLive,
          makeSettingsLive(),
          makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
          SeatGuidanceRepositoryLive,
          AgentSignalRepositoryLive,
          ReferencesRepositoryLive,
          Layer.provideMerge(PausePlaneLive, FactoryPauseRepositoryLive),
          makeMachineRepositoryLive({ defaultName: () => name, makeInstallationId: () => installation }),
        ),
        Layer.mergeAll(makeStateEngineLive(join(root, "junto.db")), makeInstallOpsLive(join(root, "install-ops.db"))),
      ),
    ),
  );
  // The runner over the task ruler and the submit path that queues a write off the editing machine,
  // and the ruler of queued commands, as the editing machine runs it.
  const rulers = Layer.provideMerge(Layer.mergeAll(TaskRepositoryLive, ArtifactRepositoryLive, makeResourceSubmitLayer(() => true)), stores);
  return ManagedRuntime.make(Layer.mergeAll(Layer.provideMerge(Layer.provideMerge(Layer.mergeAll(AutomationRunnerLive, ResourceRulerLive), noBoatWakeLayer), rulers), testLog.log.loggerLayer));
};

type Machine = {
  readonly name: string;
  readonly self: InstallationId;
  readonly root: string;
  readonly runtime: ReturnType<typeof makeRuntime>;
  readonly exchange: RowExchange;
  readonly channel: ReturnType<typeof rowsChannel>;
};

const queue: Array<{ readonly from: Machine; readonly to: Machine; readonly payload: unknown }> = [];
const booted: Machine[] = [];

afterEach(async () => {
  for (const machine of booted.splice(0)) {
    for (const link of machine.exchange.status()) machine.exchange.closed(link.peer);
    await machine.runtime.dispose();
    await rm(machine.root, { recursive: true, force: true });
  }
  queue.length = 0;
});

const boot = async (name: string, self: InstallationId, pin: readonly [string, InstallationId]): Promise<Machine> => {
  const root = join(tmpdir(), `junto-files-departure-${name}-${randomUUID()}`);
  const runtime = makeRuntime(root, name, self);
  const exchange = await runtime.runPromise(
    Effect.gen(function* () {
      const machines = yield* MachineRepository;
      yield* machines.configureName(name);
      yield* machines.pinPeer({ machineName: pin[0], installationId: pin[1] });
      return yield* makeLiveRowExchange({ mailArrived: () => {} });
    }),
  );
  const machine: Machine = { name, self, root, runtime, exchange, channel: rowsChannel(exchange) };
  booted.push(machine);
  return machine;
};

/** The machine's core restarts on the same state: everything it held in memory is gone. */
const restart = async (machine: Machine, pin: readonly [string, InstallationId]): Promise<Machine> => {
  for (const link of machine.exchange.status()) machine.exchange.closed(link.peer);
  for (const other of booted) if (other !== machine) other.exchange.closed(machine.self);
  await machine.runtime.dispose();
  booted.splice(booted.indexOf(machine), 1);
  const runtime = makeRuntime(machine.root, machine.name, machine.self);
  const exchange = await runtime.runPromise(
    Effect.gen(function* () {
      const machines = yield* MachineRepository;
      yield* machines.configureName(machine.name);
      yield* machines.pinPeer({ machineName: pin[0], installationId: pin[1] });
      return yield* makeLiveRowExchange({ mailArrived: () => {} });
    }),
  );
  const next: Machine = { ...machine, runtime, exchange, channel: rowsChannel(exchange) };
  booted.push(next);
  return next;
};

const contextOf = (from: Machine, to: Machine): RowsChannelContext => ({
  peer: { installationId: to.self },
  sessionId: `${from.name}-${to.name}`,
  sendEvent: (_channel, payload) =>
    Effect.sync(() => {
      queue.push({ from, to, payload: rowsWire(payload) });
    }),
});

const quiet = async (): Promise<void> => {
  for (const machine of booted) await machine.runtime.runPromise(machine.exchange.quiet);
};

/** Deliver frames until none is left; a refused frame is kept as the error it was refused with. */
const settle = async (): Promise<unknown> => {
  let refusal: unknown;
  for (await quiet(); queue.length > 0; await quiet()) {
    const next = queue.shift()!;
    if (!next.to.exchange.linked(next.from.self)) continue;
    const frame = next.to.channel.decodeEvent(next.payload);
    await next.to.runtime
      .runPromise(next.to.channel.handleEvent(contextOf(next.to, next.from), frame))
      .catch((error: unknown) => {
        refusal = error;
      });
  }
  return refusal;
};

const link = async (left: Machine, right: Machine): Promise<unknown> => {
  await left.runtime.runPromise(left.channel.opened(contextOf(left, right)));
  await right.runtime.runPromise(right.channel.opened(contextOf(right, left)));
  return settle();
};


const flags = vi.hoisted(() => ({ remote: true }));
vi.mock("@shared/features", async (original) => {
  const real = await original<typeof import("../src/shared/features")>();
  return {
    ...real,
    get FILES_REMOTE_ENABLED() { return flags.remote; },
    productNodeKindEnabled: (kind: string) => kind === "files" || real.productNodeKindEnabled(kind as never),
  };
});

const ROOT = "/Users/mini/Projects/secret-folder";
const FOLDER = asNodeId("folder");
const filesOn = async (on: Machine) =>
  [...(await on.runtime.runPromise(Effect.flatMap(ModelService, (model) => model.canvas("factory")))).nodes.values()].filter((node) => node.kind === "files");
const operator = (on: Machine, raw: unknown) =>
  on.runtime.runPromise(Effect.flatMap(ModelService, (model) => model.command(command(raw), "operator")));
const committed = async (on: Machine) => {
  await on.runtime.runPromise(on.exchange.committed("factory"));
  return settle();
};

/** The macbook edits a canvas whose folder is on the mini; the mini has a seat there too when `seated`. */
const stage = async (seated: boolean) => {
  const macbook = await boot("macbook", MACBOOK, ["mini", MINI]);
  const mini = await boot("mini", MINI, ["macbook", MACBOOK]);
  const lead = seat("lead", { x: 0, y: 0, width: 200, height: 100, host: "macbook" as never, agentKey: "macbook:claude", bindingId: "binding-lead" as never });
  const peer = seat("peer", { x: 0, y: 300, width: 200, height: 100, host: "mini" as never, agentKey: "mini:claude", bindingId: "binding-peer" as never });
  await macbook.runtime.runPromise(seedCanvas("factory", [lead, ...(seated ? [peer] : []), files("folder", { x: 400, y: 0, host: "mini" as never, root: ROOT })]));
  await link(macbook, mini);
  return { macbook, mini };
};

describe("a Files node leaving its machine (X6, remote-security C2)", () => {
  it("reaches the folder's machine whole, with a folder as its only reason", async () => {
    const { mini } = await stage(false);
    expect(await filesOn(mini)).toMatchObject([{ id: "folder", host: "mini", root: ROOT }]);
  });

  it("marks the folder's machine in state with the copy that carried the node", async () => {
    const { macbook } = await stage(false);
    const marked = await macbook.runtime.runPromise(Effect.flatMap(WorkRepository, (repository) => repository.filesCarriedTo("factory")));
    expect([...marked]).toEqual([MINI]);
  });

  it("leaves no departure mark behind a removed canvas, so a canvas made later under its name owes no machine a departure copy", async () => {
    const { macbook } = await stage(false);
    const marked = () => macbook.runtime.runPromise(Effect.flatMap(WorkRepository, (repository) => repository.filesCarriedTo("factory")));
    expect([...(await marked())]).toEqual([MINI]);
    await operator(macbook, { _tag: "RemoveCanvas", canvas: "factory" });
    expect([...(await marked())]).toEqual([]);
  });

  for (const [how, change] of [
    ["moved to another machine", { _tag: "Edit", canvas: "factory", id: "folder", change: { kind: "files", host: "macbook" } }],
    ["deleted", { _tag: "Remove", canvas: "factory", nodes: ["folder"], wires: [] }],
  ] as const) {
    it(`is taken from a machine with no other reason by the departure copy when ${how}`, async () => {
      const { macbook, mini } = await stage(false);
      await operator(macbook, change);
      await committed(macbook);
      expect(await filesOn(mini)).toEqual([]);
      // Sent once: a second change sends the mini nothing more.
      const seq = (await mini.runtime.runPromise(Effect.flatMap(ModelService, (model) => model.canvas("factory")))).seq;
      await operator(macbook, { _tag: "Add", canvas: "factory", nodes: [seat("late", { x: 0, y: 600, width: 200, height: 100, host: "macbook" as never, agentKey: "macbook:claude", bindingId: "binding-late" as never })], wires: [] });
      await committed(macbook);
      expect((await mini.runtime.runPromise(Effect.flatMap(ModelService, (model) => model.canvas("factory")))).seq).toBe(seq);
    });

    it(`is taken from that machine by the departure copy when ${how} after the editor restarts`, async () => {
      const staged = await stage(false);
      expect(await filesOn(staged.mini)).toMatchObject([{ id: "folder", root: ROOT }]);
      queue.length = 0;
      const macbook = await restart(staged.macbook, ["mini", MINI]);
      // The change lands while the link is down: only the kept mark says the mini may hold the node.
      await operator(macbook, change);
      await macbook.runtime.runPromise(macbook.exchange.committed("factory"));
      queue.length = 0;
      await link(macbook, staged.mini);
      expect(await filesOn(staged.mini)).toEqual([]);
      const held = (await staged.mini.runtime.runPromise(Effect.flatMap(ModelService, (model) => model.canvas("factory")))).nodes;
      expect(JSON.stringify([...held.values()])).not.toContain(ROOT);
      // The departure copy clears the mark: no machine is left marked.
      const marked = await macbook.runtime.runPromise(Effect.flatMap(WorkRepository, (repository) => repository.filesCarriedTo("factory")));
      expect([...marked]).toEqual([]);
    });

    it(`leaves a machine with a seat there a stub with no root when ${how}`, async () => {
      const { macbook, mini } = await stage(true);
      expect(await filesOn(mini)).toMatchObject([{ id: "folder", root: ROOT }]);
      await operator(macbook, change);
      await committed(macbook);
      expect(await filesOn(mini)).toEqual([]);
      const held = (await mini.runtime.runPromise(Effect.flatMap(ModelService, (model) => model.canvas("factory")))).nodes;
      expect(JSON.stringify([...held.values()])).not.toContain(ROOT);
      expect(held.has("peer" as never)).toBe(true);
    });
  }
});
