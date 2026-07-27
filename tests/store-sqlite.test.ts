import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import {
  StoreError,
  StoreLive,
  StoreService,
} from "../src/main/services/store";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";

const roots: string[] = [];
const runtimes: Array<{ readonly dispose: () => Promise<void> }> = [];

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "vellum-store-sqlite-"));
  roots.push(root);
  return root;
};

const makeRuntime = (root: string) => {
  const state = makeStateEngineLive(join(root, "vellum.db"));
  const runtime = ManagedRuntime.make(Layer.provideMerge(StoreLive, state));
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

describe("StoreService SQLite state", () => {
  test("starts empty and reports the sole database", async () => {
    const root = await makeRoot();
    const path = join(root, "vellum.db");
    const runtime = makeRuntime(root);
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* StoreService;
        return {
          missing: yield* store.get("kernel.armed"),
          doctor: yield* store.doctor,
        };
      }),
    );

    expect(result.missing).toBeUndefined();
    expect(result.doctor).toMatchObject({
      status: "ok",
      metadata: { database: path },
    });
    expect(result.doctor.metadata).toEqual({ database: path });
  });

  test("persists committed values across a complete runtime restart", async () => {
    const root = await makeRoot();
    const first = makeRuntime(root);
    await first.runPromise(
      Effect.flatMap(StoreService, (store) =>
        store.set("kernel.armed", { "canvas::region": true }),
      ),
    );
    await disposeRuntime(first);

    const second = makeRuntime(root);
    await expect(
      second.runPromise(
        Effect.flatMap(StoreService, (store) => store.get("kernel.armed")),
      ),
    ).resolves.toEqual({ "canvas::region": true });
  });

  test("keeps every independently written key across concurrent calls and restart", async () => {
    const root = await makeRoot();
    const entries = Array.from(
      { length: 64 },
      (_, index) => [`independent.${index}`, { index }] as const,
    );
    const first = makeRuntime(root);
    await first.runPromise(
      Effect.flatMap(StoreService, (store) =>
        Effect.all(
          entries.map(([key, value]) => store.set(key, value)),
          { concurrency: "unbounded", discard: true },
        ),
      ),
    );
    await disposeRuntime(first);

    const second = makeRuntime(root);
    const persisted = await second.runPromise(
      Effect.flatMap(StoreService, (store) =>
        Effect.all(
          entries.map(([key]) => store.get<{ index: number }>(key)),
          { concurrency: "unbounded" },
        ),
      ),
    );
    expect(persisted).toEqual(entries.map(([, value]) => value));
  });

  test("returns a typed failure instead of resetting an invalid stored value", async () => {
    const root = await makeRoot();
    const runtime = makeRuntime(root);
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const state = yield* StateEngine;
        const store = yield* StoreService;
        yield* store.set("kernel.armed", { "canvas::region": true });
        yield* state.transaction("test.corrupt-store-value", (writer) => {
          writer.run("PRAGMA ignore_check_constraints = ON");
          writer.run(
            "UPDATE runtime_store_values SET value_json = ? WHERE key = ?",
            ["{ invalid json", "kernel.armed"],
          );
          writer.run("PRAGMA ignore_check_constraints = OFF");
        });
        return yield* Effect.either(store.get("kernel.armed"));
      }),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(StoreError);
      expect(result.left.message).toContain("not valid JSON");
    }
  });

  test("rejects non-JSON values without changing a previously committed key", async () => {
    const root = await makeRoot();
    const runtime = makeRuntime(root);
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* StoreService;
        yield* store.set("stable", { value: 1 });
        const failed = yield* Effect.either(store.set("stable", 1n));
        return {
          failed,
          preserved: yield* store.get("stable"),
        };
      }),
    );

    expect(result.failed._tag).toBe("Left");
    expect(result.preserved).toEqual({ value: 1 });
  });

  test("drops the obsolete legacy-import table on reopen", async () => {
    const root = await makeRoot();
    const first = makeRuntime(root);
    await first.runPromise(
      Effect.flatMap(StateEngine, (state) =>
        state.transaction("test.seed-obsolete-store-table", (writer) => {
          writer.run(
            `
              CREATE TABLE runtime_store_legacy_import (
                singleton INTEGER PRIMARY KEY
              ) STRICT
            `,
          );
        }),
      ),
    );
    await disposeRuntime(first);

    const second = makeRuntime(root);
    const tables = await second.runPromise(
      Effect.flatMap(StateEngine, (state) =>
        state.read("test.runtime-store-tables", (reader) =>
          reader
            .all<{ name: string }>(
              `
                SELECT name
                FROM sqlite_master
                WHERE type = 'table'
                  AND name LIKE 'runtime_store_%'
                ORDER BY name
              `,
            )
            .map((row) => row.name),
        ),
      ),
    );

    expect(tables).toEqual(["runtime_store_values"]);
  });
});
