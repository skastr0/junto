import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Arming is transactional: the typed SQLite repository write lands
// before the in-memory arming map is mutated, so a failed persist leaves
// memory and disk in sync (the change did not stick) and the caller learns
// { ok:false } instead of the old fire-and-forget that diverged them and
// discarded the rejection.

import { CanvasesService } from "../src/main/vellum/canvases";
import { SnapshotsService } from "../src/main/vellum/snapshots";
import { ChatService, ChatServiceContext } from "../src/main/vellum/chat/service";
import type { SpawnFn } from "../src/main/vellum/chat/acp-client";
import { KernelLive, KernelService } from "../src/main/vellum/kernel/service";
import {
  KernelStatePersistenceError,
  KernelStateRepository,
} from "../src/main/vellum/kernel/repository";
import { SchedulerRepository } from "../src/main/vellum/scheduler/repository";
import { PausePlaneAllPlaying } from "../src/main/vellum/pause-plane";
import { __resetKernelMemoryForTest, getArmed } from "../src/main/vellum/kernel/cycle";
import { SettingsService } from "../src/main/vellum/settings/service";
import { defaultSettings } from "../src/shared/settings";

const noSpawn: SpawnFn = () => { throw new Error("unexpected ACP spawn"); };

const check = (id: string) => ({ id, label: id, status: "ok" as const, detail: "" });
const emptyDoc = (name: string) => ({
  name,
  doc: { nodes: [], edges: [] },
  revision: `${name}-r1`,
});

const fakeCanvases = Layer.succeed(
  CanvasesService,
  CanvasesService.of({
    doctor: Effect.succeed(check("canvases")),
    list: Effect.succeed([]),
    read: (name: string) => Effect.succeed(emptyDoc(name)),
    write: () => Effect.succeed({ revision: "written-r1" }),
    mutate: () => Effect.void,
    create: (name: string) => Effect.succeed(emptyDoc(name)),
    remove: (name: string) => Effect.succeed({ name }),
    ensureSeed: Effect.void,
    writeSidecar: () => Effect.succeed(""),
    start: () => {},
    subscribeChanges: () => () => {},
    liveDocuments: () => Effect.succeed([]),
    liveAuthorityGeneration: () => Effect.succeed("0"),
    authoritySnapshot: () =>
      Effect.succeed({ generation: "0", documents: new Map() }),
  }),
);

const fakeSnapshots = Layer.succeed(
  SnapshotsService,
  SnapshotsService.of({
    doctor: Effect.succeed(check("snapshots")),
    current: Effect.succeed({ bundles: [] }),
    refresh: () => Effect.succeed({ bundles: [] }),
    start: () => {},
    subscribe: () => () => {},
  }),
);

type ArmingWrite = {
  readonly canvasName: string;
  readonly regionId: string;
  readonly armed: boolean;
};

// A repository whose write can be forced to fail, recording every successful
// domain mutation so the test can assert what actually reached persistence.
const makeKernelState = (
  opts: { setFails?: boolean },
  writes: ArmingWrite[],
) =>
  Layer.succeed(
    KernelStateRepository,
    KernelStateRepository.of({
      listArmedRegions: Effect.succeed([]),
      setRegionArmed: (canvasName, regionId, armed) =>
        opts.setFails
          ? Effect.fail(
              KernelStatePersistenceError.make({
                operation: "set region armed",
                message: "disk full",
                cause: new Error("disk full"),
              }),
            )
          : Effect.sync(() =>
              void writes.push({ canvasName, regionId, armed })
            ),
      replaceDebugPulseRing: () => Effect.void,
      readDebugPulseRing: Effect.succeed([]),
    }),
  );

const runArm = (
  opts: { setFails?: boolean },
  writes: ArmingWrite[],
  canvasName: string,
  regionId: string,
  armed: boolean,
) => {
  const fakeSettings = Layer.succeed(SettingsService, {
    doctor: Effect.succeed({
      id: "settings",
      label: "settings",
      status: "ok" as const,
      detail: "test",
    }),
    get: Effect.succeed(defaultSettings()),
    patch: () => Effect.succeed(defaultSettings()),
    setStationTopology: () => Effect.succeed(defaultSettings()),
    reset: () => Effect.succeed(defaultSettings()),
    subscribe: () => () => undefined,
  });
  const deps = Layer.mergeAll(
    fakeCanvases,
    fakeSnapshots,
    makeKernelState(opts, writes),
    Layer.succeed(ChatServiceContext, new ChatService(noSpawn, (host) => host === "local")),
    fakeSettings,
    Layer.succeed(SchedulerRepository, {
      claimInterval: () =>
        Effect.succeed({
          _tag: "Ineligible" as const,
          reason: "invalid-state" as const,
        }),
      reconcileHome: () => Effect.succeed(0),
      readIntervalState: () => Effect.succeed(undefined),
    }),
  );
  const layer = Layer.provide(KernelLive, Layer.mergeAll(deps, PausePlaneAllPlaying));
  const runtime = ManagedRuntime.make(layer);
  return runtime
    .runPromise(Effect.flatMap(KernelService, (kernel) => kernel.armRegion(canvasName, regionId, armed)))
    .finally(() => runtime.dispose());
};

beforeEach(() => {
  __resetKernelMemoryForTest();
});

afterEach(() => {
  __resetKernelMemoryForTest();
});

describe("KernelService.armRegion — transactional persist-then-mutate", () => {
  it("a successful repository write persists the row and flips the in-memory map", async () => {
    const writes: ArmingWrite[] = [];
    const result = await runArm({}, writes, "ether", "r1", true);

    expect(result).toEqual({ ok: true });
    expect(writes).toEqual([
      { canvasName: "ether", regionId: "r1", armed: true },
    ]);
    expect(getArmed().get("ether::r1")).toBe(true);
  });

  it("a failed repository write returns { ok:false } and leaves memory untouched", async () => {
    const writes: ArmingWrite[] = [];
    const result = await runArm(
      { setFails: true },
      writes,
      "ether",
      "r1",
      true,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not saved/i);
    // Memory untouched — proves setArmed ran only AFTER a durable write, never before.
    expect(getArmed().has("ether::r1")).toBe(false);
    expect(writes).toEqual([]);
  });

  it("disarm is an explicit act: a successful write persists the key's removal and clears memory", async () => {
    // Arm first (durable), then disarm.
    await runArm({}, [], "ether", "r1", true);
    expect(getArmed().get("ether::r1")).toBe(true);

    const writes: ArmingWrite[] = [];
    const result = await runArm({}, writes, "ether", "r1", false);

    expect(result).toEqual({ ok: true });
    expect(writes).toEqual([
      { canvasName: "ether", regionId: "r1", armed: false },
    ]);
    expect(getArmed().get("ether::r1")).toBeFalsy();
  });
});
