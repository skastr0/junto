import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import {
  makeStoreLive,
  StoreError,
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
  const store = makeStoreLive({ legacyPath: join(root, "store.json") });
  const runtime = ManagedRuntime.make(Layer.provideMerge(store, state));
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

describe("StoreService SQLite compatibility store", () => {
  test("imports a valid legacy store once, then leaves the file inert", async () => {
    const root = await makeRoot();
    const legacyPath = join(root, "store.json");
    const legacy = {
      "kernel.armed": { "canvas::region": true },
      "kernel.debug": { pulseLog: [{ kind: "manual" }] },
    };
    await writeFile(legacyPath, JSON.stringify(legacy), "utf8");

    const first = makeRuntime(root);
    await expect(
      first.runPromise(
        Effect.flatMap(StoreService, (store) => store.get("kernel.armed")),
      ),
    ).resolves.toEqual({ "canvas::region": true });
    await disposeRuntime(first);

    const laterLegacy = "{ legacy file is now corrupt";
    await writeFile(legacyPath, laterLegacy, "utf8");
    const second = makeRuntime(root);
    await expect(
      second.runPromise(
        Effect.gen(function* () {
          const store = yield* StoreService;
          const imported = yield* store.get("kernel.debug");
          yield* store.set("kernel.armed", { "canvas::next": true });
          return imported;
        }),
      ),
    ).resolves.toEqual({ pulseLog: [{ kind: "manual" }] });
    await disposeRuntime(second);

    expect(await readFile(legacyPath, "utf8")).toBe(laterLegacy);
    const third = makeRuntime(root);
    await expect(
      third.runPromise(
        Effect.flatMap(StoreService, (store) => store.get("kernel.armed")),
      ),
    ).resolves.toEqual({ "canvas::next": true });
  });

  test("fails closed on corrupt legacy evidence and imports after explicit repair", async () => {
    const root = await makeRoot();
    const legacyPath = join(root, "store.json");
    const corrupt = "{ definitely not json";
    await writeFile(legacyPath, corrupt, "utf8");

    const failed = makeRuntime(root);
    await expect(
      failed.runPromise(
        Effect.flatMap(StoreService, (store) => store.get("kernel.armed")),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("refusing to treat as empty"),
    });
    await expect(
      failed.runPromise(Effect.flatMap(StoreService, (store) => store.doctor)),
    ).resolves.toMatchObject({
      status: "error",
      detail: expect.stringContaining("refusing to treat as empty"),
    });
    await expect(
      failed.runPromise(
        Effect.flatMap(StoreService, (store) =>
          store.set("kernel.armed", { "canvas::must-not-land": true }),
        ),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("refusing to treat as empty"),
    });
    await disposeRuntime(failed);
    expect(await readFile(legacyPath, "utf8")).toBe(corrupt);

    await writeFile(
      legacyPath,
      JSON.stringify({ "kernel.armed": { "canvas::repaired": true } }),
      "utf8",
    );
    const repaired = makeRuntime(root);
    await expect(
      repaired.runPromise(
        Effect.flatMap(StoreService, (store) => store.get("kernel.armed")),
      ),
    ).resolves.toEqual({ "canvas::repaired": true });
  });

  test("records an absent legacy store so a later file cannot become truth", async () => {
    const root = await makeRoot();
    const first = makeRuntime(root);
    await expect(
      first.runPromise(
        Effect.flatMap(StoreService, (store) => store.get("kernel.armed")),
      ),
    ).resolves.toBeUndefined();
    await disposeRuntime(first);

    await writeFile(
      join(root, "store.json"),
      JSON.stringify({ "kernel.armed": { "canvas::late": true } }),
      "utf8",
    );
    const second = makeRuntime(root);
    const result = await second.runPromise(
      Effect.gen(function* () {
        const store = yield* StoreService;
        return {
          value: yield* store.get("kernel.armed"),
          doctor: yield* store.doctor,
        };
      }),
    );
    expect(result.value).toBeUndefined();
    expect(result.doctor.status).toBe("ok");
    expect(result.doctor.metadata?.legacyImport).toBe("absent");
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
});
