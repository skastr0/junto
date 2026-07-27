import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Durable-operator-intent invariant tests: whatever the operator SET and
// expects permanent MUST survive a full SQLite runtime restart. Orphaned
// arm-intent is surfaced, never dropped.

import { StoreLive, StoreService } from "../src/main/services/store";
import { computeOrphanedArming } from "../src/main/vellum/kernel/service";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import type { CanvasDoc } from "../src/shared/canvas";

let root = "";

const runStore = <A>(
  use: (svc: typeof StoreService.Service) => Effect.Effect<A, unknown>,
) => {
  const state = makeStateEngineLive(join(root, "vellum.db"));
  const runtime = ManagedRuntime.make(Layer.provideMerge(StoreLive, state));
  return runtime
    .runPromise(Effect.flatMap(StoreService, use))
    .finally(() => runtime.dispose());
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vellum-arming-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("StoreService — durable operator intent", () => {
  it("missing state reads as an empty store", async () => {
    await expect(
      runStore((s) => s.get("kernel.armed")),
    ).resolves.toBeUndefined();
  });

  it("arming survives a complete SQLite runtime restart", async () => {
    await runStore((s) => s.set("kernel.armed", { "ether::r1": true }));
    await expect(runStore((s) => s.get("kernel.armed"))).resolves.toEqual({
      "ether::r1": true,
    });
  });

  it("serializes overlapping kernel debug and arming writes without losing unrelated keys", async () => {
    const entries = [
      ["kernel.debug", { pulseLog: [{ kind: "manual" }] }],
      ["kernel.armed", { "ether::r1": true }],
      ...Array.from(
        { length: 32 },
        (_, index) => [`concurrency.probe.${index}`, index] as const,
      ),
    ] as const;

    await runStore((store) =>
      Effect.all(
        entries.map(([key, value]) => store.set(key, value)),
        { concurrency: "unbounded" },
      ),
    );

    await runStore((store) =>
      Effect.gen(function* () {
        expect(yield* store.get("kernel.debug")).toEqual({
          pulseLog: [{ kind: "manual" }],
        });
        expect(yield* store.get("kernel.armed")).toEqual({
          "ether::r1": true,
        });
        for (let index = 0; index < 32; index += 1) {
          expect(yield* store.get(`concurrency.probe.${index}`)).toBe(index);
        }
      }),
    );
  });
});

describe("computeOrphanedArming — intent surfaced, never dropped", () => {
  const doc = (nodeIds: ReadonlyArray<string>): CanvasDoc =>
    ({
      nodes: nodeIds.map((id) => ({
        id,
        type: "group",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      })),
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
    expect(computeOrphanedArming(docs, armed)).toEqual([
      "ether::gone-region",
      "deleted-canvas::r1",
    ]);
  });

  it("disarmed entries are never reported", () => {
    const docs = new Map([["ether", doc(["r1"])]]);
    expect(
      computeOrphanedArming(docs, [["deleted-canvas::r1", false]]),
    ).toEqual([]);
  });

  it("with zero hydrated docs no judgment is made", () => {
    expect(computeOrphanedArming(new Map(), [["ether::r1", true]])).toEqual([]);
  });
});
