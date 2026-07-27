import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import {
  KERNEL_DEBUG_RING_LIMIT,
  KernelStateCorruptError,
  KernelStateRepository,
  KernelStateRepositoryLive,
} from "../src/main/vellum/kernel/repository";
import {
  FactoryPauseRepository,
  FactoryPauseRepositoryLive,
  FactoryPauseStateCorruptError,
} from "../src/main/vellum/pause/repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";
import type { PulseRecord } from "../src/shared/ipc";

const roots: string[] = [];
const runtimes: Array<{ readonly dispose: () => Promise<void> }> = [];

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "vellum-runtime-state-"));
  roots.push(root);
  return root;
};

const makeRuntime = (root: string) => {
  const state = makeStateEngineLive(join(root, "vellum.db"));
  const repositories = Layer.provideMerge(
    Layer.mergeAll(KernelStateRepositoryLive, FactoryPauseRepositoryLive),
    state,
  );
  const runtime = ManagedRuntime.make(repositories);
  runtimes.push(runtime);
  return runtime;
};

const disposeRuntime = async (runtime: {
  readonly dispose: () => Promise<void>;
}): Promise<void> => {
  const index = runtimes.indexOf(runtime);
  if (index >= 0) runtimes.splice(index, 1);
  await runtime.dispose();
};

const pulse = (index: number): PulseRecord => ({
  id: `pulse-${index}`,
  at: 1_700_000_000_000 + index,
  canvasName: "ether",
  sourceNodeId: `timer-${index}`,
  regionId: "region-1",
  kind: index % 2 === 0 ? "timer" : "manual",
  summary: `pulse ${index}`,
  delivered: [`agent-${index}`],
  dry: index % 3 === 0,
});

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.dispose();
  }
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("typed runtime-state repositories", () => {
  test("arming and normalized pause scopes survive a complete restart", async () => {
    const root = await makeRoot();
    const first = makeRuntime(root);
    await first.runPromise(
      Effect.gen(function* () {
        const kernel = yield* KernelStateRepository;
        const pause = yield* FactoryPauseRepository;
        yield* kernel.setRegionArmed("ether", "region-1", true);
        yield* kernel.setRegionArmed("ether", "region-2", true);
        yield* kernel.setRegionArmed("ether", "region-2", false);
        yield* pause.setPlaying("ether", true);
        yield* pause.setMemberPaused(
          "ether",
          { kind: "node", id: "agent-1" },
          true,
        );
        yield* pause.setMemberPaused(
          "ether",
          { kind: "region", id: "region-1" },
          true,
        );
      }),
    );
    await disposeRuntime(first);

    const second = makeRuntime(root);
    const result = await second.runPromise(
      Effect.gen(function* () {
        const kernel = yield* KernelStateRepository;
        const pause = yield* FactoryPauseRepository;
        return {
          armed: yield* kernel.listArmedRegions,
          paused: (yield* pause.loadAll).get("ether"),
        };
      }),
    );

    expect(result.armed).toEqual([
      { canvasName: "ether", regionId: "region-1" },
    ]);
    expect(result.paused).toEqual({
      playing: true,
      everPlayed: true,
      pausedNodes: ["agent-1"],
      pausedRegions: ["region-1"],
    });
  });

  test("the debug pulse ring is typed, bounded, and durable", async () => {
    const root = await makeRoot();
    const first = makeRuntime(root);
    const records = Array.from(
      { length: KERNEL_DEBUG_RING_LIMIT + 5 },
      (_, index) => pulse(index),
    );
    await first.runPromise(
      Effect.flatMap(KernelStateRepository, (repository) =>
        repository.replaceDebugPulseRing(records)
      ),
    );
    await disposeRuntime(first);

    const second = makeRuntime(root);
    const persisted = await second.runPromise(
      Effect.flatMap(
        KernelStateRepository,
        (repository) => repository.readDebugPulseRing,
      ),
    );

    expect(persisted).toHaveLength(KERNEL_DEBUG_RING_LIMIT);
    expect(persisted.map((record) => record.id)).toEqual(
      records.slice(-KERNEL_DEBUG_RING_LIMIT).map((record) => record.id),
    );
    expect(persisted.at(-1)).toEqual(records.at(-1));
  });

  test("independent normalized writes serialize without losing rows", async () => {
    const root = await makeRoot();
    const runtime = makeRuntime(root);
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const kernel = yield* KernelStateRepository;
        const pause = yield* FactoryPauseRepository;
        yield* Effect.all(
          Array.from({ length: 64 }, (_, index) =>
            kernel.setRegionArmed("ether", `region-${index}`, true)
          ),
          { concurrency: "unbounded", discard: true },
        );
        yield* Effect.all(
          Array.from({ length: 32 }, (_, index) =>
            pause.setMemberPaused(
              "ether",
              { kind: "node" as const, id: `agent-${index}` },
              true,
            )
          ),
          { concurrency: "unbounded", discard: true },
        );
        return {
          armed: yield* kernel.listArmedRegions,
          paused: (yield* pause.loadAll).get("ether"),
        };
      }),
    );

    expect(result.armed).toHaveLength(64);
    expect(result.paused?.pausedNodes).toHaveLength(32);
  });

  test("invalid persisted debug payloads fail with a typed corruption error", async () => {
    const root = await makeRoot();
    const runtime = makeRuntime(root);
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const kernel = yield* KernelStateRepository;
        const state = yield* StateEngine;
        yield* kernel.replaceDebugPulseRing([pulse(1)]);
        yield* state.transaction("test.corrupt-kernel-debug", (writer) => {
          writer.run("PRAGMA ignore_check_constraints = ON");
          writer.run(
            "UPDATE kernel_debug_pulses SET delivered_json = 'not-json'",
          );
          writer.run("PRAGMA ignore_check_constraints = OFF");
        });
        return yield* Effect.either(kernel.readDebugPulseRing);
      }),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(KernelStateCorruptError);
    }
  });

  test("unknown persisted pause scope kinds fail closed as typed corruption", async () => {
    const root = await makeRoot();
    const runtime = makeRuntime(root);
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const pause = yield* FactoryPauseRepository;
        const state = yield* StateEngine;
        yield* pause.setMemberPaused(
          "ether",
          { kind: "node", id: "agent-1" },
          true,
        );
        yield* state.transaction("test.corrupt-pause-scope", (writer) => {
          writer.run("PRAGMA ignore_check_constraints = ON");
          writer.run(
            "UPDATE factory_pause_scopes SET scope_kind = 'unknown'",
          );
          writer.run("PRAGMA ignore_check_constraints = OFF");
        });
        return yield* Effect.either(pause.loadAll);
      }),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(FactoryPauseStateCorruptError);
    }
  });
});
