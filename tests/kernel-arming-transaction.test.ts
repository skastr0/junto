import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// sdk-kernel-build fix 1 — arming is TRANSACTIONAL: the store write lands
// before the in-memory arming map is mutated, so a failed persist leaves
// memory and disk in sync (the change did not stick) and the caller learns
// { ok:false } instead of the old fire-and-forget that diverged them and
// discarded the rejection.

import { CanvasesService } from "../src/main/vellum/canvases";
import { SnapshotsService } from "../src/main/vellum/snapshots";
import { StoreError, StoreService } from "../src/main/services/store";
import { ChatService, ChatServiceContext } from "../src/main/vellum/chat/service";
import type { SpawnFn } from "../src/main/vellum/chat/acp-client";
import { KernelLive, KernelService } from "../src/main/vellum/kernel/service";
import { __resetKernelMemoryForTest, getArmed } from "../src/main/vellum/kernel/cycle";
import { SettingsService } from "../src/main/vellum/settings/service";
import { defaultSettings } from "../src/shared/settings";

const ARMED_STORE_KEY = "kernel.armed";
const noSpawn: SpawnFn = () => { throw new Error("unexpected ACP spawn"); };

const check = (id: string) => ({ id, label: id, status: "ok" as const, detail: "" });
const emptyDoc = (name: string) => ({
  name,
  path: "",
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

// A store whose set() can be forced to fail, recording every successful write
// so the test can assert what actually reached disk.
const makeStore = (opts: { setFails?: boolean }, sets: Array<{ key: string; value: unknown }>) =>
  Layer.succeed(
    StoreService,
    StoreService.of({
      doctor: Effect.succeed(check("store")),
      get: <T>(_key: string) => Effect.succeed(undefined as T | undefined),
      set: <T>(key: string, value: T) =>
        opts.setFails
          ? Effect.fail(new StoreError({ message: "disk full" }))
          : Effect.sync(() => void sets.push({ key, value })),
    }),
  );

const runArm = (
  opts: { setFails?: boolean },
  sets: Array<{ key: string; value: unknown }>,
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
    reset: () => Effect.succeed(defaultSettings()),
    path: () => "/tmp/vellum-settings-test.json",
    subscribe: () => () => undefined,
  });
  const deps = Layer.mergeAll(
    fakeCanvases,
    fakeSnapshots,
    makeStore(opts, sets),
    Layer.succeed(ChatServiceContext, new ChatService(noSpawn)),
    fakeSettings,
  );
  const layer = Layer.provide(KernelLive, deps);
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
  it("a successful store write persists the record AND flips the in-memory map", async () => {
    const sets: Array<{ key: string; value: unknown }> = [];
    const result = await runArm({}, sets, "ether", "r1", true);

    expect(result).toEqual({ ok: true });
    const armedWrite = sets.filter((s) => s.key === ARMED_STORE_KEY).at(-1);
    expect(armedWrite?.value).toEqual({ "ether::r1": true });
    expect(getArmed().get("ether::r1")).toBe(true);
  });

  it("a FAILED store write returns { ok:false } and leaves the in-memory map untouched (persist-first)", async () => {
    const sets: Array<{ key: string; value: unknown }> = [];
    const result = await runArm({ setFails: true }, sets, "ether", "r1", true);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not saved/i);
    // Memory untouched — proves setArmed ran only AFTER a durable write, never before.
    expect(getArmed().has("ether::r1")).toBe(false);
    expect(sets.filter((s) => s.key === ARMED_STORE_KEY)).toEqual([]);
  });

  it("disarm is an explicit act: a successful write persists the key's removal and clears memory", async () => {
    // Arm first (durable), then disarm.
    await runArm({}, [], "ether", "r1", true);
    expect(getArmed().get("ether::r1")).toBe(true);

    const sets: Array<{ key: string; value: unknown }> = [];
    const result = await runArm({}, sets, "ether", "r1", false);

    expect(result).toEqual({ ok: true });
    const armedWrite = sets.filter((s) => s.key === ARMED_STORE_KEY).at(-1);
    expect(armedWrite?.value).toEqual({});
    expect(getArmed().get("ether::r1")).toBeFalsy();
  });
});
