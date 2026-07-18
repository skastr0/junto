import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Durable-operator-intent invariant tests: whatever the operator SET and
// expects permanent MUST be permanent. A corrupt store must fail LOUDLY,
// never silently reset to disarmed; orphaned arm-intent is surfaced, never
// dropped.

const paths = { userData: "" };

vi.mock("electron", () => ({
  app: { getPath: () => paths.userData },
}));

import { StoreLive, StoreService } from "../src/main/services/store";
import { computeOrphanedArming } from "../src/main/vellum/kernel/service";
import type { CanvasDoc } from "../src/shared/canvas";

const storeFile = () => join(paths.userData, "store.json");

const runStore = <A>(use: (svc: typeof StoreService.Service) => Effect.Effect<A, unknown>) => {
  const runtime = ManagedRuntime.make(StoreLive);
  return runtime
    .runPromise(Effect.flatMap(StoreService, use))
    .finally(() => runtime.dispose());
};

beforeEach(() => {
  paths.userData = mkdtempSync(join(tmpdir(), "vellum-arming-"));
});

describe("StoreService — corrupt is loud, missing is empty", () => {
  it("missing store file reads as an empty store", async () => {
    await expect(runStore((s) => s.get("kernel.armed"))).resolves.toBeUndefined();
  });

  it("healthy roundtrip persists and reads back", async () => {
    await runStore((s) => s.set("kernel.armed", { "ether::r1": true }));
    await expect(runStore((s) => s.get("kernel.armed"))).resolves.toEqual({ "ether::r1": true });
  });

  it("a corrupt store file fails get() loudly instead of reading as empty", async () => {
    writeFileSync(storeFile(), "{ definitely not json", "utf8");
    await expect(runStore((s) => s.get("kernel.armed"))).rejects.toMatchObject({
      message: expect.stringContaining("unreadable"),
    });
  });

  it("a corrupt store file fails set() and is never clobbered", async () => {
    const corrupt = "{ definitely not json";
    writeFileSync(storeFile(), corrupt, "utf8");
    await expect(runStore((s) => s.set("kernel.armed", { x: true }))).rejects.toMatchObject({
      message: expect.stringContaining("unreadable"),
    });
    expect(readFileSync(storeFile(), "utf8")).toBe(corrupt);
  });

  it("serializes overlapping kernel debug and arming writes without losing unrelated keys", async () => {
    const entries = [
      ["kernel.debug", { pulseLog: [{ kind: "manual" }] }],
      ["kernel.armed", { "ether::r1": true }],
      ...Array.from({ length: 32 }, (_, index) => [`concurrency.probe.${index}`, index] as const),
    ] as const;

    await runStore((store) =>
      Effect.all(
        entries.map(([key, value]) => store.set(key, value)),
        { concurrency: "unbounded" },
      ),
    );

    const persisted = JSON.parse(readFileSync(storeFile(), "utf8")) as Record<string, unknown>;
    expect(persisted["kernel.debug"]).toEqual({ pulseLog: [{ kind: "manual" }] });
    expect(persisted["kernel.armed"]).toEqual({ "ether::r1": true });
    for (let index = 0; index < 32; index += 1) {
      expect(persisted[`concurrency.probe.${index}`]).toBe(index);
    }
  });
});

describe("computeOrphanedArming — intent surfaced, never dropped", () => {
  const doc = (nodeIds: ReadonlyArray<string>): CanvasDoc =>
    ({
      nodes: nodeIds.map((id) => ({ id, type: "group", x: 0, y: 0, width: 100, height: 100 })),
      edges: [],
    }) as unknown as CanvasDoc;

  it("armed keys whose canvas and region exist are not orphaned", () => {
    const docs = new Map([["ether", doc(["r1"])]]);
    expect(computeOrphanedArming(docs, [["ether::r1", true]])).toEqual([]);
  });

  it("a vanished region and a vanished canvas both surface as orphans", () => {
    const docs = new Map([["ether", doc(["r1"])]]);
    const armed: ReadonlyArray<readonly [string, boolean]> = [
      ["ether::r1", true],
      ["ether::gone-region", true],
      ["deleted-canvas::r1", true],
    ];
    expect(computeOrphanedArming(docs, armed)).toEqual(["ether::gone-region", "deleted-canvas::r1"]);
  });

  it("disarmed entries are never reported", () => {
    const docs = new Map([["ether", doc(["r1"])]]);
    expect(computeOrphanedArming(docs, [["deleted-canvas::r1", false]])).toEqual([]);
  });

  it("with zero hydrated docs no judgment is made", () => {
    expect(computeOrphanedArming(new Map(), [["ether::r1", true]])).toEqual([]);
  });
});
