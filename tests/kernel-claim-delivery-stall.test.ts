/**
 * Production KernelService -> managed pulse bridge -> ManagedTerminalDrive.
 *
 * SQLite, authorial compilation, Work claims/receipts, kernel scheduling,
 * observer parsing, composer evidence and seat-state publication are real.
 * Only process occupation and the harness TUI are boundary doubles. The TUI
 * speaks captured Claude chip chrome through SessionObserver; neither drive
 * admission nor pending evidence can inspect the model's private state.
 * This is a deterministic integration regression, not a visual app E2E.
 */
import { CrewRepositoryLive } from "../src/main/vellum-command/work/crew-repository";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";
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
import { composerVerdictForHarness, seatStateRuntime } from "../src/main/vellum-command/term/agent-state";
import {
  BRACKETED_PASTE_START,
  INTERRUPT_BYTE,
  ManagedTerminalDrive,
  promptHasPasteChip,
  promptStillPending,
} from "../src/main/vellum-command/term/drive";
import { OperatorInterlock } from "../src/main/vellum-command/term/drive/operator-interlock";
import { makeManagedPulseDeliver, setManagedPulseDeliver } from "../src/main/vellum-command/term/managed-pulse-bridge";
import { isPromptSubmitted } from "../src/shared/managed-prompt";
import { SessionObserver } from "../src/main/vellum-command/term/observer";
import { termPlane } from "../src/main/vellum-command/term/plane";
import { WorkRepository, WorkRepositoryLive } from "../src/main/vellum-command/work/repository";
import { WorkLive, WorkService } from "../src/main/vellum-command/work/service";
import { ScriptedTui } from "./pty-e2e/scripted-tui";

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

const startFixture = async (stuck: boolean, initialReady = true) => {
  const root = await mkdtemp(join(tmpdir(), "vellum-claim-delivery-"));
  const runtime = makeRuntime(root);
  const writes: string[] = [];
  const seatEvents: AgentSeatStateEvent[] = [];
  const observer = new SessionObserver({ bindingId: BINDING, epoch: EPOCH, cols: 60, rows: 24 });
  let seq = 0n;
  let ready = initialReady;
  let kernel: Context.Service.Shape<typeof KernelService> | undefined;
  let cycles = 0;
  let cols = 60;
  let stopCycles = () => {};
  const hostGet = vi.spyOn(termPlane.host, "get").mockImplementation((bindingId) =>
    bindingId === BINDING ? liveSession : undefined,
  );
  const tui = new ScriptedTui({
    harness: "claude", secondCrSubmits: !stuck,
    emit: (bytes) => {
      // ScriptedTui writes complete rows but omits their erase-to-EOL. An
      // empty composer would otherwise leave its previous chip on xterm's
      // grid, hiding the clear -> retry defect. Claude's real paste-chip
      // corpus contains this CSI K repaint sequence.
      observer.feed(bytes.replaceAll("\r\n", "\x1b[K\r\n") + "\x1b[K", ++seq);
    },
  });
  const drive = new ManagedTerminalDrive({
    write: (_bindingId, bytes) => {
      writes.push(bytes);
      return tui.write(bytes);
    },
    isSeatIdle: (bindingId) => seatStateRuntime.isSeatIdle(bindingId),
    composerVerdict: () => composerVerdictForHarness(observer.snapshotNow(), "claude"),
    pendingText: (_bindingId, text) => promptStillPending(observer.snapshotNow(), text),
    pasteChip: () => promptHasPasteChip(observer.snapshotNow()),
    harnessFor: () => "claude",
    operatorInput: new OperatorInterlock(),
    pasteToCrSettleMs: 40,
    stallTimeoutMs: 100,
    onAttention: (bindingId, reason) => seatStateRuntime.machine.force(bindingId, "attention", reason, "high"),
  });
  const stopObserver = observer.subscribe((snapshot) => seatStateRuntime.observe(snapshot));
  const stopSeats = seatStateRuntime.subscribe((event) => {
    if (event.bindingId !== BINDING) return;
    seatEvents.push(event);
    if (event.state === "working") drive.onTurnStart(BINDING);
    if (event.state === "idle") drive.onSeatIdle(BINDING);
  });

  const dispose = async () => {
    kernel?.suspend();
    setManagedPulseDeliver(undefined);
    drive.suspend();
    stopCycles();
    stopSeats();
    stopObserver();
    tui.dispose();
    observer.dispose();
    seatStateRuntime.unbind(BINDING, EPOCH);
    hostGet.mockRestore();
    await runtime.dispose();
    __resetKernelMemoryForTest();
    await rm(root, { recursive: true, force: true });
  };

  try {
    seatStateRuntime.bindHarness(BINDING, "claude", EPOCH);
    tui.boot();
    await expect.poll(() => seatStateRuntime.isSeatIdle(BINDING)).toBe(true);
    expect(composerVerdictForHarness(observer.snapshotNow(), "claude")).toBe("empty");

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
    expect(claim.data.state).toBe("working");
    const sink = { canvasName: CANVAS, nodeId: "tasks" };
    const repository = await runtime.runPromise(WorkRepository);
    const identity = await runtime.runPromise(repository.currentTaskClaim(sink, claim.data.id, actor.seatId));
    if (identity === undefined) throw new Error("fixture claim has no canonical fact");
    const deliveryId = managedTaskDeliveryId(sink, claim.data.id, actor.seatId,
      JSON.stringify([identity.id.route.eventHome, identity.id.route.entityHome, identity.id.seq]));
    const pause = await runtime.runPromise(PausePlane);
    await runtime.runPromise(pause.start);
    await runtime.runPromise(pause.setPlaying(CANVAS, true));

    setManagedPulseDeliver(makeManagedPulseDeliver(
      (bindingId, text, options) =>
        drive.writePrompt(bindingId, text, options).then(isPromptSubmitted),
      () => ready,
    ));
    kernel = await runtime.runPromise(KernelService);
    stopCycles = kernel.subscribe(() => { cycles += 1; });
    kernel.start({ runPromise: (effect) => runtime.runPromise(effect), runFork: (effect) => { runtime.runFork(effect); } });
    await expect.poll(() => cycles, { timeout: 5_000 }).toBeGreaterThan(0);
    return {
      writes, seatEvents,
      diagnostics: () => ({
        state: seatStateRuntime.getState(BINDING),
        events: seatEvents.map(({ state, reason }) => ({ state, reason })),
        grid: observer.snapshotNow().lines.slice(-6),
      }),
      setReady: async (value: boolean) => {
        ready = value;
        if (value) {
          tui.boot();
          await expect.poll(() => seatStateRuntime.isSeatIdle(BINDING)).toBe(true);
        }
      },
      hasReceipt: () => runtime.runPromise(repository.hasAcceptedDelivery(sink, deliveryId)),
      cycle: async (redrawIdle = false) => {
        const previous = cycles;
        if (redrawIdle) {
          // Opening/resizing the idle TUI redraws its current composer. The
          // process model retains a pending chip until submitted or cleared;
          // the drive still sees only the resulting observer grid.
          observer.resize(++cols, 24);
          tui.emitIdleRestore();
          await observer.snapshot();
        }
        kernel!.requestCycle();
        await expect.poll(() => cycles, { timeout: 5_000 }).toBeGreaterThan(previous);
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
};

describe("working claim delivery through the production kernel", () => {
  it("leaves an accepted but pending paste for operator resolution without clearing or repasting", async () => {
    const fixture = await startFixture(true);
    try {
      for (let cycle = 0; cycle < 3; cycle += 1) await fixture.cycle(true);
      expect.soft(fixture.writes.filter((bytes) => bytes.startsWith(BRACKETED_PASTE_START))).toHaveLength(1);
      expect.soft(fixture.writes.filter((bytes) => bytes === INTERRUPT_BYTE), JSON.stringify(fixture.diagnostics())).toHaveLength(0);
      expect.soft(await fixture.hasReceipt()).toBe(false);
      expect.soft(fixture.diagnostics().state).toBe("attention");
      expect(fixture.seatEvents.some((event) => event.state === "attention" && event.reason.includes("prompt-stalled"))).toBe(true);
    } finally {
      await fixture.dispose();
    }
  }, 15_000);

  it("retries pre-write refusals and receipts one successful submission from the same claim", async () => {
    const fixture = await startFixture(false, false);
    try {
      await fixture.cycle();
      expect(fixture.writes).toEqual([]);
      expect(await fixture.hasReceipt()).toBe(false);
      // A real idle repaint restores readiness after the refusal attention.
      await fixture.setReady(true);
      await fixture.cycle();
      expect(await fixture.hasReceipt()).toBe(true);
      await fixture.cycle();
      expect(fixture.writes.filter((bytes) => bytes.startsWith(BRACKETED_PASTE_START))).toHaveLength(1);
      expect(fixture.writes.filter((bytes) => bytes === INTERRUPT_BYTE)).toHaveLength(0);
    } finally {
      await fixture.dispose();
    }
  }, 15_000);
});
