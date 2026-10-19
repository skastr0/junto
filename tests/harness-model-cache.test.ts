/**
 * The harness model cache lives in junto.db: a scan's answer is stored as
 * rows, the next run serves it without scanning again, it can be searched, and
 * the inventory writes nothing under the Junto home. The old `~/.junto/state/harness-models.json`
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
import { templateFor } from "../src/shared/managed-terminal-templates";
import { makeStateEngineLive } from "../src/main/junto/state/engine";

const scans = vi.hoisted(() => ({ count: 0, executable: "" }));

vi.mock("../src/main/junto/term/templates/harness-install", () => ({
  probeManagedHarnessInstalls: async () => [{ harness: "claude", installed: true, executable: scans.executable }],
}));
vi.mock("../src/main/junto/term/templates/enumerate-dispatch", () => ({
  // As a real scan answers: the harness's efforts are its template's.
  enumerateManagedModels: async () => {
    scans.count += 1;
    return { models: [{ id: "opus", label: "Opus" }], source: "command", efforts: ["low", "medium", "high", "xhigh", "max", "ultracode"] };
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
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.all({
        scans: sql`SELECT harness, version, source FROM harness_scans`,
        models: sql`SELECT harness, model, provider, label, description, position FROM harness_models`,
      }),
    ),
  );

/** The cache itself over this test's database. */
const withCache = <A>(use: (cache: ReturnType<typeof harnessModelCacheIn>) => Effect.Effect<A>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => use(harnessModelCacheIn(sql))));

const codex = {
  fingerprint: "/bin/codex:10:20",
  scannedAt: 1_760_000_000_000,
  version: "0.130.0",
  result: {
    models: [
      { id: "gpt-6-luna", label: "GPT-6 Luna", description: "Fast", efforts: ["low", "high"] },
      { id: "gpt-reserve", label: "GPT Reserve" },
    ],
    source: "command" as const,
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
};
const pi = {
  fingerprint: "/bin/pi:1:2",
  scannedAt: 1_760_000_000_001,
  result: {
    models: [
      { id: "opencode-go/deepseek-v4-flash", label: "deepseek-v4-flash", description: "opencode-go", provider: "opencode-go" },
      { id: "anthropic/claude-opus-5-5", label: "claude-opus-5-5", description: "anthropic", provider: "anthropic" },
    ],
    source: "command" as const,
    efforts: [],
  },
  profiles: [{ name: "work", model: "anthropic/claude-opus-5-5" }, { name: "play" }],
};

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
    expect(await rows()).toEqual({
      scans: [{ harness: "claude", version: "2.1.300", source: "command" }],
      models: [{ harness: "claude", model: "opus", provider: null, label: "Opus", description: null, position: 0 }],
    });

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

  it("gives back every scan as it was stored, with the harness's efforts from its template", async () => {
    await withCache((cache) => Effect.all([cache.save("codex", codex), cache.save("pi", pi)]));
    const loaded = await withCache((cache) => cache.load);
    expect(loaded.get("codex")).toEqual({ ...codex, result: { ...codex.result, efforts: [...templateFor("codex").efforts] } });
    expect(loaded.get("pi")).toEqual({ ...pi, result: { ...pi.result, efforts: [...templateFor("pi").efforts] } });
  });

  it("replaces a harness's scan whole, so a model it no longer lists is gone and not found", async () => {
    await withCache((cache) => cache.save("pi", pi));
    await withCache((cache) => cache.save("pi", { ...pi, profiles: undefined, result: { ...pi.result, models: [pi.result.models[1]!] } }));
    const loaded = await withCache((cache) => cache.load);
    expect(loaded.get("pi")?.result.models.map((model) => model.id)).toEqual(["anthropic/claude-opus-5-5"]);
    expect(loaded.get("pi")?.profiles).toBeUndefined();
    expect(await withCache((cache) => cache.search("deepseek", 10))).toEqual([]);
  });

  it("searches any three letters anywhere, and the start of an id or label under three", async () => {
    await withCache((cache) => Effect.all([cache.save("codex", codex), cache.save("pi", pi)]));
    const search = (text: string) => withCache((cache) => cache.search(text, 10));
    expect(await search("seek")).toEqual([
      { harness: "pi", model: "opencode-go/deepseek-v4-flash", provider: "opencode-go", label: "deepseek-v4-flash" },
    ]);
    expect((await search("luna")).map((match) => match.model)).toEqual(["gpt-6-luna"]);
    expect((await search("anthropic")).map((match) => match.model)).toEqual(["anthropic/claude-opus-5-5"]);
    expect((await search("gp")).map((match) => match.model)).toEqual(["gpt-6-luna", "gpt-reserve"]);
    expect((await search("cl")).map((match) => match.model)).toEqual(["anthropic/claude-opus-5-5"]);
    expect(await search("ee")).toEqual([]);
    // The text is matched as written, never read as search syntax.
    expect(await search('"opus')).toEqual([]);
    expect(await search("opus OR luna")).toEqual([]);
    expect(await search("%")).toEqual([]);
    expect(await search("  ")).toEqual([]);
  });
});
