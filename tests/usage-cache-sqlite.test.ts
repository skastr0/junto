import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import type { UsageSnapshot, UsageState } from "../src/shared/usage";
import {
  makeStateEngineLive,
  StateEngine,
  type StateEngineError,
} from "../src/main/vellum/state/engine";
import {
  makeUsageCacheLive,
  USAGE_STATE_SCHEMA_SQL,
  UsageCache,
} from "../src/main/vellum/usage/usage-cache";
import {
  UsageSources,
  type UsageSource,
} from "../src/main/vellum/usage/usage-source";
import {
  UsageService,
  UsageServiceLive,
} from "../src/main/vellum/usage/usage-service";

type EngineRuntime = ManagedRuntime.ManagedRuntime<
  StateEngine,
  StateEngineError
>;

const roots: string[] = [];
const dispose: Array<() => Promise<void>> = [];

const quotaSnapshot = (
  source: string,
  provider: string,
  usedPercent: number,
): UsageSnapshot => ({
  source,
  fetchedAt: "2026-07-27T12:00:00.000Z",
  ok: true,
  quotas: [
    {
      provider,
      source: "test",
      status: "ok",
      windows: [{ label: "primary", usedPercent }],
      updatedAt: "2026-07-27T12:00:00.000Z",
    },
  ],
});

const failedSnapshot = (source: string): UsageSnapshot => ({
  source,
  fetchedAt: "2026-07-27T12:05:00.000Z",
  ok: false,
  reason: "cli-error",
  error: "provider unavailable",
  quotas: [],
});

const lastGood = (
  source: string,
  provider: string,
  usedPercent: number,
): UsageState => ({
  snapshots: [quotaSnapshot(source, provider, usedPercent)],
  stale: false,
  lastLiveAt: "2026-07-27T12:00:00.000Z",
});

const makeSource = (
  id: string,
  fetch: () => UsageSnapshot,
): UsageSource => ({
  id,
  detect: Effect.succeed(true),
  fetch: Effect.sync(fetch),
});

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "vellum-usage-sqlite-"));
  roots.push(root);
  return root;
};

const openEngine = async (path: string): Promise<{
  readonly runtime: EngineRuntime;
  readonly engine: Context.Tag.Service<typeof StateEngine>;
}> => {
  const runtime = ManagedRuntime.make(makeStateEngineLive(path));
  dispose.push(() => runtime.dispose());
  const engine = await runtime.runPromise(StateEngine);
  await runtime.runPromise(
    engine.transaction("test.usage-schema", (writer) => {
      writer.run(USAGE_STATE_SCHEMA_SQL);
    }),
  );
  return { runtime, engine };
};

const cacheRuntime = (
  engine: Context.Tag.Service<typeof StateEngine>,
  legacyPath: string,
): ManagedRuntime.ManagedRuntime<UsageCache, never> => {
  const runtime = ManagedRuntime.make(
    Layer.provide(
      makeUsageCacheLive({ legacyPath }),
      Layer.succeed(StateEngine, engine),
    ),
  );
  dispose.push(() => runtime.dispose());
  return runtime;
};

const serviceRuntime = (
  engine: Context.Tag.Service<typeof StateEngine>,
  legacyPath: string,
  sources: ReadonlyArray<UsageSource>,
): ManagedRuntime.ManagedRuntime<UsageService, never> => {
  const cache = Layer.provide(
    makeUsageCacheLive({ legacyPath }),
    Layer.succeed(StateEngine, engine),
  );
  const runtime = ManagedRuntime.make(
    Layer.provide(
      UsageServiceLive,
      Layer.mergeAll(cache, Layer.succeed(UsageSources, sources)),
    ),
  );
  dispose.push(() => runtime.dispose());
  return runtime;
};

afterEach(async () => {
  while (dispose.length > 0) await dispose.pop()!();
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("SQLite usage cache", () => {
  test("survives an engine restart and refuses to replace last-good with a failure envelope", async () => {
    const root = await tempRoot();
    const databasePath = join(root, "state", "vellum.db");
    const legacyPath = join(root, "legacy", "usage-state.json");
    const first = await openEngine(databasePath);
    const firstCacheRuntime = cacheRuntime(first.engine, legacyPath);
    const firstCache = await firstCacheRuntime.runPromise(UsageCache);

    await firstCacheRuntime.runPromise(
      firstCache.saveLastGood(lastGood("alpha", "claude", 42)),
    );
    await firstCacheRuntime.runPromise(
      firstCache.saveLastGood({
        snapshots: [failedSnapshot("alpha")],
        stale: true,
        lastError: "provider unavailable",
      }),
    );

    await dispose.pop()!();
    await dispose.pop()!();

    const second = await openEngine(databasePath);
    const secondCacheRuntime = cacheRuntime(second.engine, legacyPath);
    const restarted = await secondCacheRuntime.runPromise(
      Effect.flatMap(UsageCache, (cache) => cache.loadLastGood),
    );

    expect(restarted?.stale).toBe(true);
    expect(restarted?.lastError).toBeUndefined();
    expect(restarted?.snapshots[0]?.ok).toBe(true);
    expect(restarted?.snapshots[0]?.quotas[0]).toMatchObject({
      provider: "claude",
      windows: [{ label: "primary", usedPercent: 42 }],
    });
  });

  test("imports valid legacy JSON once and ignores later file mutations", async () => {
    const root = await tempRoot();
    const legacyPath = join(root, "usage-state.json");
    await writeFile(
      legacyPath,
      JSON.stringify(lastGood("legacy", "codex", 31)),
      "utf8",
    );
    const { engine } = await openEngine(join(root, "vellum.db"));
    const runtime = cacheRuntime(engine, legacyPath);
    const imported = await runtime.runPromise(
      Effect.flatMap(UsageCache, (cache) => cache.loadLastGood),
    );

    expect(imported?.snapshots[0]?.quotas[0]?.provider).toBe("codex");
    expect(imported?.stale).toBe(true);

    await writeFile(
      legacyPath,
      JSON.stringify(lastGood("mutated", "grok", 99)),
      "utf8",
    );
    const reread = await runtime.runPromise(
      Effect.flatMap(UsageCache, (cache) => cache.loadLastGood),
    );
    expect(reread?.snapshots[0]?.quotas[0]?.provider).toBe("codex");
    expect(reread?.snapshots[0]?.quotas[0]?.windows[0]?.usedPercent).toBe(31);
  });

  test("marks an invalid legacy file attempted without harming or re-reading it", async () => {
    const root = await tempRoot();
    const legacyPath = join(root, "usage-state.json");
    await writeFile(legacyPath, "{ invalid", "utf8");
    const { engine } = await openEngine(join(root, "vellum.db"));
    const runtime = cacheRuntime(engine, legacyPath);
    const cache = await runtime.runPromise(UsageCache);

    expect(await runtime.runPromise(cache.loadLastGood)).toBeUndefined();

    await writeFile(
      legacyPath,
      JSON.stringify(lastGood("late", "hermes", 10)),
      "utf8",
    );
    expect(await runtime.runPromise(cache.loadLastGood)).toBeUndefined();
  });

  test("failed refresh retains SQLite last-good and a persistence fault stays non-fatal", async () => {
    const root = await tempRoot();
    const legacyPath = join(root, "usage-state.json");
    await writeFile(
      legacyPath,
      JSON.stringify(lastGood("legacy", "claude", 18)),
      "utf8",
    );
    const { runtime: engineRuntime, engine } = await openEngine(
      join(root, "vellum.db"),
    );
    let mode: "ok" | "fail" = "fail";
    const source = makeSource("alpha", () =>
      mode === "ok"
        ? quotaSnapshot("alpha", "codex", 63)
        : failedSnapshot("alpha"),
    );
    const service = serviceRuntime(engine, legacyPath, [source]);
    const usage = await service.runPromise(UsageService);

    const failed = await service.runPromise(usage.refresh());
    expect(failed.stale).toBe(true);
    expect(failed.snapshots[0]?.quotas[0]?.provider).toBe("claude");
    expect(failed.lastError).toBe("provider unavailable");

    await engineRuntime.runPromise(
      engine.transaction("test.reject-usage-save", (writer) => {
        writer.run(`
          CREATE TRIGGER reject_usage_state_update
          BEFORE UPDATE ON usage_state
          BEGIN
            SELECT RAISE(ABORT, 'forced persistence failure');
          END
        `);
      }),
    );

    mode = "ok";
    const live = await service.runPromise(usage.refresh());
    expect(live.stale).toBe(false);
    expect(live.snapshots[0]?.quotas[0]?.provider).toBe("codex");

    const durableRuntime = cacheRuntime(engine, legacyPath);
    const durable = await durableRuntime.runPromise(
      Effect.flatMap(UsageCache, (cache) => cache.loadLastGood),
    );
    expect(durable?.snapshots[0]?.quotas[0]?.provider).toBe("claude");
    expect(durable?.snapshots[0]?.quotas[0]?.windows[0]?.usedPercent).toBe(18);
  });
});
