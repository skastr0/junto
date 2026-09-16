/** Real Work service, SQLite and kernel; only occupation/transport are boundary doubles. */
import { CrewRepositoryLive } from "../src/main/vellum-command/work/crew-repository";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { IntentFactBasis } from "../src/shared/work-protocol";
import { makeUserMessage } from "../src/shared/task";
import { CanvasesLive, CanvasesService } from "../src/main/vellum-command/canvases";
import { makeContentServiceLive } from "../src/main/vellum-command/content/service";
import { makeInstallOpsLive } from "../src/main/vellum-command/install-ops/engine";
import { __resetKernelMemoryForTest } from "../src/main/vellum-command/kernel/cycle";
import { KernelLive, KernelService, managedTaskDeliveryId } from "../src/main/vellum-command/kernel/service";
import { FactoryPauseRepositoryLive } from "../src/main/vellum-command/pause/repository";
import { PausePlane, PausePlaneLive } from "../src/main/vellum-command/pause-plane";
import { SchedulerRepositoryLive } from "../src/main/vellum-command/scheduler/repository";
import { SettingsLive, SettingsService } from "../src/main/vellum-command/settings/service";
import { makeSnapshotsLive } from "../src/main/vellum-command/snapshots";
import { makeStateEngineLive } from "../src/main/vellum-command/state/engine";
import { StationFleetTargetRepositoryLive } from "../src/main/vellum-command/station/fleet-target-repository";
import { StationRepositoryLive } from "../src/main/vellum-command/station/repository";
import { StationLivePeerRegistryLive } from "../src/main/vellum-command/station/session-registry";
import { ActorSeatOccupy } from "../src/main/vellum-command/term/actor-seat-occupy";
import { termPlane } from "../src/main/vellum-command/term/plane";
import { WorkRepository, WorkRepositoryLive } from "../src/main/vellum-command/work/repository";
import { WorkLive, WorkService } from "../src/main/vellum-command/work/service";
import { seatStateRuntime } from "../src/main/vellum-command/term/agent-state";
import { setManagedPulseDeliver } from "../src/main/vellum-command/term/managed-pulse-bridge";
const CANVAS = "claim-delivery";
const BINDING = "claim-delivery-seat";
const EPOCH = "claim-delivery-generation";
const liveSession = {
  bindingId: BINDING,
  epoch: EPOCH,
  hostId: "local",
  status: "running",
  detached: false,
  createdAt: 1,
} as const;

const factoryDoc = (): CanvasDoc => ({
  nodes: [
    {
      id: "worker", type: "text", text: "Worker", x: 0, y: 0, width: 220, height: 100,
      ether: {
        entity: { kind: "agent", name: "local:worker" }, host: "local",
        terminal: {
          bindingId: BINDING, harness: "claude",
          launch: { kind: "harness", argv: ["claude"] },
        },
      },
    },
    {
      id: "tasks", type: "text", text: "Tasks", x: 280, y: 0, width: 220, height: 100,
      ether: { entity: { kind: "task" } },
    },
  ],
  edges: [{ id: "works", fromNode: "tasks", toNode: "worker", ether: { verb: "works" } }],
});

const makeRuntime = (root: string) => {
  const repositories = Layer.provideMerge(
    Layer.mergeAll(
      CrewRepositoryLive, WorkRepositoryLive, StationRepositoryLive, StationFleetTargetRepositoryLive,
      SettingsLive, FactoryPauseRepositoryLive, SchedulerRepositoryLive,
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
    ),
    Layer.mergeAll(
      makeStateEngineLive(join(root, "state", "junto.db")),
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  const canvases = Layer.provideMerge(CanvasesLive, repositories);
  const work = Layer.provideMerge(WorkLive, Layer.mergeAll(canvases, StationLivePeerRegistryLive));
  const dependencies = Layer.mergeAll(
    work,
    Layer.provideMerge(PausePlaneLive, repositories),
    makeSnapshotsLive(async () => ({
      source: "hermes", fetchedAt: new Date().toISOString(), ok: true, stale: false, entities: [],
    }), false),
    Layer.succeed(ActorSeatOccupy, ActorSeatOccupy.of({
      occupy: () => Effect.succeed(liveSession),
      occupancy: () => Effect.die(new Error("fixture seat is already occupied")),
    })),
  );
  return ManagedRuntime.make(Layer.provideMerge(KernelLive, dependencies));
};


const startFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "vellum-claim-identity-"));
  let runtime = makeRuntime(root);
  let kernel: Context.Service.Shape<typeof KernelService> | undefined;
  let cycles = 0;
  let stopCycles = () => {};
  const deliveries: string[] = [];
  const hostGet = vi.spyOn(termPlane.host, "get").mockImplementation((bindingId) =>
    bindingId === BINDING ? liveSession : undefined,
  );
  seatStateRuntime.bindHarness(BINDING, "claude", EPOCH);
  seatStateRuntime.machine.force(BINDING, "idle", "fixture empty composer", "high");
  setManagedPulseDeliver(async (_bindingId, text) => { deliveries.push(text); return true; });
  const dispose = async () => {
    kernel?.suspend();
    stopCycles();
    setManagedPulseDeliver(undefined);
    seatStateRuntime.unbind(BINDING, EPOCH);
    hostGet.mockRestore();
    await runtime.dispose();
    __resetKernelMemoryForTest();
    await rm(root, { recursive: true, force: true });
  };
  const cycle = async () => {
    const previous = cycles;
    kernel!.requestCycle();
    await expect.poll(() => cycles, { timeout: 5_000 }).toBeGreaterThan(previous);
  };
  const start = async () => {
    kernel = await runtime.runPromise(KernelService);
    stopCycles = kernel.subscribe(() => { cycles += 1; });
    const previous = cycles;
    kernel.start({ runPromise: (effect) => runtime.runPromise(effect), runFork: (effect) => { runtime.runFork(effect); } });
    await expect.poll(() => cycles, { timeout: 5_000 }).toBeGreaterThan(previous);
  };
  try {
    const settings = await runtime.runPromise(SettingsService);
    await runtime.runPromise(settings.setStationTopology({ role: "command-center", hostId: "local", supervisedPreferred: true }));
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.write(CANVAS, factoryDoc()));
    const work = await runtime.runPromise(WorkService);
    const created = await runtime.runPromise(work.workTaskCreate(CANVAS, "tasks", "Run exactly one claim", { details: "Report a short result." }));
    if (!created.ok) throw new Error(created.message);
    const read = await runtime.runPromise(canvases.read(CANVAS));
    const actor = read.actorRefs.find((ref) => ref.nodeId === "worker");
    if (!actor) throw new Error("fixture actor was not compiled");
    const claim = await runtime.runPromise(work.workTaskClaim(CANVAS, "tasks", created.data.id, actor));
    if (!claim.ok) throw new Error(claim.message);
    const pause = await runtime.runPromise(PausePlane);
    await runtime.runPromise(pause.start);
    await runtime.runPromise(pause.setPlaying(CANVAS, true));
    return {
      runtime, work, canvases, actor, pause, taskId: claim.data.id, claim: claim.data,
      deliveries, start, cycle, dispose,
      restart: async () => {
        kernel?.suspend();
        stopCycles();
        await runtime.dispose();
        __resetKernelMemoryForTest();
        runtime = makeRuntime(root);
        await start();
      },
    };
  } catch (error) { await dispose(); throw error; }
};

describe("canonical claim delivery identity", () => {
  it("does not re-deliver accepted claims after progress, comments or a runtime restart", async () => {
    const fixture = await startFixture();
    try {
      await fixture.start();
      expect(fixture.deliveries).toHaveLength(1);
      const progress = await fixture.runtime.runPromise(fixture.work.workTaskTransition(CANVAS, "tasks", fixture.taskId, "working", "Checked the first file."));
      expect(progress.ok).toBe(true);
      await fixture.cycle();
      expect.soft(fixture.deliveries, "working progress must retain its claim receipt").toHaveLength(1);
      const comment = await fixture.runtime.runPromise(fixture.work.workTaskComment(CANVAS, "tasks", fixture.taskId, makeUserMessage({ messageId: "operator-comment-1", contextId: CANVAS, taskId: fixture.taskId, text: "Review the second file." })));
      expect(comment.ok).toBe(true);
      await fixture.cycle();
      expect.soft(fixture.deliveries, "comments must retain the same claim receipt").toHaveLength(1);
      await fixture.restart();
      await fixture.cycle();
      expect(fixture.deliveries, "durable receipt must survive the process cache").toHaveLength(1);
    } finally { await fixture.dispose(); }
  }, 20_000);

  it("gives a same-actor release/reclaim a new delivery, then retains its receipt", async () => {
    const fixture = await startFixture();
    try {
      await fixture.start();
      expect(fixture.deliveries).toHaveLength(1);
      await fixture.runtime.runPromise(fixture.pause.setPlaying(CANVAS, false));
      const released = await fixture.runtime.runPromise(fixture.work.workTaskTransition(CANVAS, "tasks", fixture.taskId, "submitted"));
      expect(released.ok).toBe(true);
      const reclaimed = await fixture.runtime.runPromise(fixture.work.workTaskClaim(CANVAS, "tasks", fixture.taskId, fixture.actor));
      expect(reclaimed.ok).toBe(true);
      await fixture.runtime.runPromise(fixture.pause.setPlaying(CANVAS, true));
      await fixture.cycle();
      expect(fixture.deliveries).toHaveLength(2);
      const progress = await fixture.runtime.runPromise(fixture.work.workTaskTransition(CANVAS, "tasks", fixture.taskId, "working", "Continued the second claim."));
      expect(progress.ok).toBe(true);
      await fixture.cycle();
      expect(fixture.deliveries).toHaveLength(2);
    } finally { await fixture.dispose(); }
  }, 20_000);
  it.each(["claim", "comment", "replaced-brief"] as const)("retains an existing %s-history receipt after a brief replacement, but permits reclaim", async (boundary) => {
    const fixture = await startFixture();
    try {
      let previousKey = fixture.claim.history.at(-1)?.messageId ?? fixture.taskId;
      if (boundary === "comment") {
        const message = makeUserMessage({ messageId: "pre-upgrade-comment", contextId: CANVAS, taskId: fixture.taskId, text: "Keep the accepted claim." });
        const comment = await fixture.runtime.runPromise(fixture.work.workTaskComment(CANVAS, "tasks", fixture.taskId, message));
        expect(comment.ok).toBe(true);
        previousKey = message.messageId;
      }
      if (boundary === "replaced-brief") {
        const described = await fixture.runtime.runPromise(fixture.work.workTaskDescribe(CANVAS, "tasks", fixture.taskId, "First revised description."));
        if (!described.ok) throw new Error(described.message);
        previousKey = described.data.history.at(-1)!.messageId;
      }
      const repository = await fixture.runtime.runPromise(WorkRepository);
      const witness = await fixture.runtime.runPromise(fixture.canvases.activeIntentWitness());
      const sink = { canvasName: CANVAS, nodeId: "tasks" };
      await fixture.runtime.runPromise(repository.acceptDelivery({
        sink,
        basis: Schema.decodeUnknownSync(IntentFactBasis)({ kind: "authorial-intent", generation: witness.generation, contentSha256: witness.contentSha256 }),
        receipt: {
          deliveryId: managedTaskDeliveryId(sink, fixture.taskId, fixture.actor.seatId, previousKey),
          deliveredItem: { kind: "task", itemId: fixture.taskId, sink },
          actor: fixture.actor,
          acceptedAt: new Date().toISOString(),
        },
      }));
      const description = await fixture.runtime.runPromise(fixture.work.workTaskDescribe(CANVAS, "tasks", fixture.taskId,
        "Revised task description."));
      expect(description.ok).toBe(true);
      await fixture.start();
      await fixture.cycle();
      expect(fixture.deliveries).toHaveLength(0);
      await fixture.runtime.runPromise(fixture.pause.setPlaying(CANVAS, false));
      const release = await fixture.runtime.runPromise(fixture.work.workTaskTransition(CANVAS, "tasks", fixture.taskId, "submitted"));
      expect(release.ok).toBe(true);
      const reclaim = await fixture.runtime.runPromise(fixture.work.workTaskClaim(CANVAS, "tasks", fixture.taskId, fixture.actor));
      expect(reclaim.ok).toBe(true);
      await fixture.runtime.runPromise(fixture.pause.setPlaying(CANVAS, true));
      await fixture.cycle();
      expect(fixture.deliveries).toHaveLength(1);
    } finally { await fixture.dispose(); }
  }, 20_000);

});
