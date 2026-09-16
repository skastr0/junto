import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import type { UsageSnapshot, UsageState } from "../src/shared/usage";
import {
  makeStateEngineLive,
  StateEngine,
  type StateEngineError,
} from "../src/main/junto/state/engine";
import {
  makeUsageCacheLive,
  UsageCache,
} from "../src/main/junto/usage/usage-cache";
import {
  UsageSources,
  type UsageSource,
} from "../src/main/junto/usage/usage-source";
import {
  UsageService,
  UsageServiceLive,
} from "../src/main/junto/usage/usage-service";
import { UsagePreferences } from "../src/main/junto/usage/preferences";

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
  const root = await mkdtemp(join(tmpdir(), "junto-usage-sqlite-"));
  roots.push(root);
  return root;
};

const openEngine = async (path: string): Promise<{
  readonly runtime: EngineRuntime;
  readonly engine: Context.Service.Shape<typeof StateEngine>;
}> => {
  const runtime = ManagedRuntime.make(makeStateEngineLive(path));
  dispose.push(() => runtime.dispose());
  const engine = await runtime.runPromise(StateEngine);
  return { runtime, engine };
};

const cacheRuntime = (
  engine: Context.Service.Shape<typeof StateEngine>,
): ManagedRuntime.ManagedRuntime<UsageCache, never> => {
  const runtime = ManagedRuntime.make(
    Layer.provide(
      makeUsageCacheLive(),
      Layer.succeed(StateEngine, engine),
    ),
  );
  dispose.push(() => runtime.dispose());
  return runtime;
};

const serviceRuntime = (
  engine: Context.Service.Shape<typeof StateEngine>,
  sources: ReadonlyArray<UsageSource>,
): ManagedRuntime.ManagedRuntime<UsageService, never> => {
  const cache = Layer.provide(
    makeUsageCacheLive(),
    Layer.succeed(StateEngine, engine),
  );
  const runtime = ManagedRuntime.make(
    Layer.provide(
      UsageServiceLive,
      Layer.mergeAll(
        cache,
        Layer.succeed(UsageSources, sources),
        Layer.succeed(
          UsagePreferences,
          UsagePreferences.of({
            read: () => ({ enabledSources: [] }),
            enabledSources: () => new Set(sources.map((source) => source.id)),
            subscribeEnabledSources: () => () => undefined,
            hermesHostSnapshots: () => false,
            subscribeHermesHostSnapshots: () => () => undefined,
          }),
        ),
      ),
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
    const databasePath = join(root, "state", "junto.db");
    const first = await openEngine(databasePath);
    const firstCacheRuntime = cacheRuntime(first.engine);
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
    const secondCacheRuntime = cacheRuntime(second.engine);
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

  test("an empty database has no cache row until a successful snapshot is saved", async () => {
    const root = await tempRoot();
    const { engine } = await openEngine(join(root, "junto.db"));
    const runtime = cacheRuntime(engine);
    const empty = await runtime.runPromise(
      Effect.flatMap(UsageCache, (cache) => cache.loadLastGood),
    );
    const rows = await runtime.runPromise(
      engine.read("test.usage-row-count", (reader) =>
        reader.get<{ count: number }>(
          "SELECT count(*) AS count FROM usage_state",
        )?.count
      ),
    );

    expect(empty).toBeUndefined();
    expect(rows).toBe(0);
  });

  test("rejects an excess persisted snapshot without pruning or rewriting it", async () => {
    const root = await tempRoot();
    const { engine } = await openEngine(join(root, "junto.db"));
    const encoded = JSON.stringify([
      {
        ...quotaSnapshot("alpha", "claude", 42),
        legacyEnvelope: { source: "retired-cache" },
      },
    ]);
    await Effect.runPromise(
      engine.transaction("test.usage-excess-snapshot", (writer) => {
        writer.run(
          `INSERT INTO usage_state(
             singleton,
             snapshots_json,
             last_live_at,
             updated_at
           ) VALUES (1, ?, ?, ?)`,
          [
            encoded,
            "2026-07-27T12:00:00.000Z",
            "2026-07-27T12:00:00.000Z",
          ],
        );
      }),
    );
    const runtime = cacheRuntime(engine);

    const result = await runtime.runPromise(
      Effect.result(
        Effect.flatMap(UsageCache, (cache) => cache.loadLastGood),
      ),
    );
    const persisted = await runtime.runPromise(
      engine.read("test.usage-rejected-row", (reader) =>
        reader.get<{ snapshots_json: string }>(
          "SELECT snapshots_json FROM usage_state WHERE singleton = 1",
        )?.snapshots_json
      ),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.operation).toBe("load.decode");
      expect(result.failure.message).toContain("legacyEnvelope");
    }
    expect(persisted).toBe(encoded);
  });

  test("failed refresh retains SQLite last-good and a persistence fault stays non-fatal", async () => {
    const root = await tempRoot();
    const { runtime: engineRuntime, engine } = await openEngine(
      join(root, "junto.db"),
    );
    const seedRuntime = cacheRuntime(engine);
    const seed = await seedRuntime.runPromise(UsageCache);
    await seedRuntime.runPromise(
      seed.saveLastGood(lastGood("alpha", "claude", 18)),
    );
    let mode: "ok" | "fail" = "fail";
    const source = makeSource("alpha", () =>
      mode === "ok"
        ? quotaSnapshot("alpha", "codex", 63)
        : failedSnapshot("alpha"),
    );
    const service = serviceRuntime(engine, [source]);
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

    const durableRuntime = cacheRuntime(engine);
    const durable = await durableRuntime.runPromise(
      Effect.flatMap(UsageCache, (cache) => cache.loadLastGood),
    );
    expect(durable?.snapshots[0]?.quotas[0]?.provider).toBe("claude");
    expect(durable?.snapshots[0]?.quotas[0]?.windows[0]?.usedPercent).toBe(18);
  });
});
