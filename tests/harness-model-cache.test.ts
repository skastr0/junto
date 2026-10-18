/**
 * The harness model cache lives in junto.db: a scan's answer is stored as a
 * row, the next run serves it without scanning again, and the inventory writes
 * nothing under the Junto home. The old `~/.junto/state/harness-models.json`
 * is neither read nor written, and stays on disk as it was.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveJuntoHome } from "../src/shared/junto-home";
import { makeStateEngineLive } from "../src/main/junto/state/engine";

const scans = vi.hoisted(() => ({ count: 0, executable: "" }));

vi.mock("../src/main/junto/term/templates/harness-install", () => ({
  probeManagedHarnessInstalls: async () => [{ harness: "claude", installed: true, executable: scans.executable }],
}));
vi.mock("../src/main/junto/term/templates/enumerate-dispatch", () => ({
  enumerateManagedModels: async () => {
    scans.count += 1;
    return { models: [{ id: "opus", label: "Opus" }], source: "command", efforts: ["high"] };
  },
  listManagedProfiles: async () => undefined,
}));
vi.mock("../src/main/junto/adapters/exec", () => ({
  runCli: async () => ({ ok: true, stdout: "2.1.300 (Claude Code)" }),
}));

const { harnessModelCacheIn, makeHarnessInventory } = await import("../src/main/junto/term/templates/harness-inventory");

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-harness-model-cache-"));
  scans.count = 0;
  scans.executable = join(root, "claude");
  writeFileSync(scans.executable, "#!/bin/sh\n");
  runtime = ManagedRuntime.make(makeStateEngineLive(join(root, "junto.db")));
});

afterEach(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

/** One inventory run over this test's database: its answer for Claude. */
const modelsOnce = () =>
  runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const inventory = yield* makeHarnessInventory({
          cache: harnessModelCacheIn(yield* SqlClient.SqlClient),
          warm: false,
          machineName: Effect.succeed("mac"),
        });
        return yield* inventory.models("claude");
      }),
    ),
  );

const rows = () =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT harness, version, result, profiles FROM harness_model_cache`),
  );

/** Every file under a directory, with its size and modification time. */
const filesUnder = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (path: string): void => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const info = statSync(child);
      if (info.isDirectory()) walk(child);
      else out[child] = `${info.size}:${info.mtimeMs}`;
    }
  };
  walk(dir);
  return out;
};

describe("the harness model cache", () => {
  it("keeps a scan's answer in junto.db and serves it on the next run without scanning", async () => {
    const first = await modelsOnce();
    expect(first.models).toEqual([{ id: "opus", label: "Opus" }]);
    expect(scans.count).toBe(1);
    expect(await rows()).toEqual([
      {
        harness: "claude",
        version: "2.1.300",
        result: JSON.stringify({ models: [{ id: "opus", label: "Opus" }], source: "command", efforts: ["high"] }),
        profiles: null,
      },
    ]);

    expect(await modelsOnce()).toEqual(first);
    expect(scans.count).toBe(1);
  });

  it("writes nothing under the Junto home, and leaves the old file as it was", async () => {
    const home = resolveJuntoHome();
    const old = join(home, ".junto", "state", "harness-models.json");
    mkdirSync(join(home, ".junto", "state"), { recursive: true });
    const text = `${JSON.stringify({ version: 3, harnesses: {} })}\n`;
    writeFileSync(old, text);
    const before = filesUnder(home);

    await modelsOnce();
    await modelsOnce();

    expect(filesUnder(home)).toEqual(before);
    expect(readFileSync(old, "utf8")).toBe(text);
  });

  it("drops a row that no longer reads, so the next look scans again", async () => {
    await modelsOnce();
    await runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE harness_model_cache SET result = '{"models":"none"}'`),
    );
    expect((await modelsOnce()).models).toEqual([{ id: "opus", label: "Opus" }]);
    expect(scans.count).toBe(2);
  });
});
