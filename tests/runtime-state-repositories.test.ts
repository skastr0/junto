import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, test } from "vitest";
import {
  FactoryPauseRepository,
  FactoryPauseRepositoryLive,
} from "../src/main/junto/pause/repository";
import {
  makeStateEngineLive,
} from "../src/main/junto/state/engine";

const roots: string[] = [];
const runtimes: Array<{ readonly dispose: () => Promise<void> }> = [];

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "junto-runtime-state-"));
  roots.push(root);
  return root;
};

const makeRuntime = (root: string) => {
  const state = makeStateEngineLive(join(root, "junto.db"));
  const repositories = Layer.provideMerge(
    FactoryPauseRepositoryLive,
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

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.dispose();
  }
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("typed runtime-state repositories", () => {
  test("canvas play survives a restart; retired pause scope rows stay inert", async () => {
    const root = await makeRoot();
    const first = makeRuntime(root);
    await first.runPromise(
      Effect.gen(function* () {
        const pause = yield* FactoryPauseRepository;
        yield* pause.setPlaying("factory", true);
        // Rows written by the retired node and region pause are never read.
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(Effect.gen(function* () {
          for (const [kind, id] of [["node", "agent-1"], ["region", "region-1"]]) {
            yield* sql`
              INSERT INTO factory_pause_scopes(canvas_name, scope_kind, scope_id, paused_at)
              VALUES ('factory', ${kind}, ${id}, '2026-01-01T00:00:00.000Z')
            `;
          }
        }));
      }),
    );
    await disposeRuntime(first);

    const second = makeRuntime(root);
    const result = await second.runPromise(
      Effect.gen(function* () {
        const pause = yield* FactoryPauseRepository;
        return { paused: (yield* pause.loadAll).get("factory") };
      }),
    );

    expect(result.paused).toEqual({ playing: true, everPlayed: true });
  });

  test("independent normalized writes serialize without losing rows", async () => {
    const root = await makeRoot();
    const runtime = makeRuntime(root);
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const pause = yield* FactoryPauseRepository;
        yield* Effect.all(
          Array.from({ length: 32 }, (_, index) =>
            pause.setPlaying(`canvas-${index}`, true)
          ),
          { concurrency: "unbounded", discard: true },
        );
        return {
          playing: [...(yield* pause.loadAll).values()].filter((state) => state.playing),
        };
      }),
    );

    expect(result.playing).toHaveLength(32);
  });
});
