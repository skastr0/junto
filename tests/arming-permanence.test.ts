import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Durable-operator-intent invariant tests: whatever the operator SET and
// expects permanent MUST survive a full SQLite runtime restart. Orphaned
// arm-intent is surfaced, never dropped.

import { computeOrphanedArming } from "../src/main/vellum/kernel/service";
import {
  KernelStateRepository,
  KernelStateRepositoryLive,
} from "../src/main/vellum/kernel/repository";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import type { CanvasDoc } from "../src/shared/canvas";

let root = "";

const runKernelState = <A>(
  use: (
    repository: typeof KernelStateRepository.Service,
  ) => Effect.Effect<A, unknown>,
) => {
  const state = makeStateEngineLive(join(root, "vellum.db"));
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(KernelStateRepositoryLive, state),
  );
  return runtime
    .runPromise(Effect.flatMap(KernelStateRepository, use))
    .finally(() => runtime.dispose());
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vellum-arming-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("KernelStateRepository — durable operator intent", () => {
  it("missing state reads as no armed regions", async () => {
    await expect(
      runKernelState((repository) => repository.listArmedRegions),
    ).resolves.toEqual([]);
  });

  it("arming survives a complete SQLite runtime restart", async () => {
    await runKernelState((repository) =>
      repository.setRegionArmed("ether", "r1", true)
    );
    await expect(
      runKernelState((repository) => repository.listArmedRegions),
    ).resolves.toEqual([{ canvasName: "ether", regionId: "r1" }]);
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
