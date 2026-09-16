import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RETIRED_PRODUCT_STATE_SIGNATURES } from "../scripts/audit-retired-state-signatures";

const originalDemo = process.env.JUNTO_DEMO;
const originalE2E = process.env.JUNTO_E2E;
const originalVitest = process.env.VITEST;
const originalStateDatabase = process.env.JUNTO_STATE_DB;
const originalProjectionRoot = process.env.JUNTO_CANVASES_DIR;

let releaseDemo: (() => void) | undefined;

const restore = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

const runtimeSources = (root: string): ReadonlyArray<string> => {
  const sources: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const info = statSync(path);
      if (info.isDirectory()) {
        visit(path);
      } else if (info.isFile() && path.endsWith(".ts")) {
        sources.push(path);
      }
    }
  };
  visit(root);
  return sources;
};

beforeEach(() => {
  vi.resetModules();
  releaseDemo = undefined;
  delete process.env.JUNTO_DEMO;
  delete process.env.JUNTO_E2E;
  delete process.env.VITEST;
  delete process.env.JUNTO_STATE_DB;
  delete process.env.JUNTO_CANVASES_DIR;
});

afterEach(() => {
  releaseDemo?.();
  releaseDemo = undefined;
  restore("JUNTO_DEMO", originalDemo);
  restore("JUNTO_E2E", originalE2E);
  restore("VITEST", originalVitest);
  restore("JUNTO_STATE_DB", originalStateDatabase);
  restore("JUNTO_CANVASES_DIR", originalProjectionRoot);
  vi.resetModules();
});

describe("demo runtime isolation", () => {
  it("owns one OS-temporary database and removes it after SQLite closes", async () => {
    process.env.JUNTO_DEMO = "1";
    process.env.JUNTO_STATE_DB = "/tmp/caller-selected-state.db";

    const isolation = await import(
      "../src/main/vellum-command/demo/runtime-isolation"
    );
    releaseDemo = isolation.releaseDemoRuntimeIsolation;
    const { makeStateEngineLive, stateDatabasePath } = await import(
      "../src/main/vellum-command/state/engine"
    );
    const { StateEngine } = await import(
      "../src/main/vellum-command/state/service"
    );

    const databasePath = stateDatabasePath();
    const ownedRoot = dirname(databasePath);
    expect(databasePath).not.toBe("/tmp/caller-selected-state.db");
    expect(databasePath).not.toBe(
      join(homedir(), ".junto", "demo", "state", "junto.db"),
    );
    expect(relative(tmpdir(), ownedRoot)).toMatch(
      /^vellum-command-demo-runtime-[^/]+$/u,
    );
    expect(process.env.JUNTO_CANVASES_DIR).toBe(
      join(ownedRoot, "projections"),
    );

    const runtime = ManagedRuntime.make(makeStateEngineLive());
    const state = await runtime.runPromise(StateEngine);
    expect(state.info.path).toBe(databasePath);
    expect(existsSync(databasePath)).toBe(true);
    await runtime.dispose();

    isolation.releaseDemoRuntimeIsolation();
    releaseDemo = undefined;
    expect(existsSync(ownedRoot)).toBe(false);
  });

  it("preserves only an explicit derivative-sidecar output root", async () => {
    process.env.JUNTO_DEMO = "1";
    process.env.JUNTO_CANVASES_DIR = "/tmp/vellum-demo-sidecars";

    const isolation = await import(
      "../src/main/vellum-command/demo/runtime-isolation"
    );
    releaseDemo = isolation.releaseDemoRuntimeIsolation;
    const databasePath = isolation.demoStateDatabasePath();

    expect(databasePath).toBeDefined();
    expect(relative(tmpdir(), dirname(databasePath!))).toMatch(
      /^vellum-command-demo-runtime-[^/]+$/u,
    );
    expect(process.env.JUNTO_CANVASES_DIR).toBe(
      "/tmp/vellum-demo-sidecars",
    );
  });

  it("is inert outside demo mode", async () => {
    const isolation = await import(
      "../src/main/vellum-command/demo/runtime-isolation"
    );
    releaseDemo = isolation.releaseDemoRuntimeIsolation;

    expect(isolation.demoStateDatabasePath()).toBeUndefined();
    expect(process.env.JUNTO_CANVASES_DIR).toBeUndefined();
  });

  it("ignores database redirection even under test-looking environment flags", async () => {
    process.env.JUNTO_E2E = "1";
    process.env.VITEST = "true";
    process.env.JUNTO_STATE_DB = "/tmp/untrusted-second-home.db";

    const { stateDatabasePath } = await import(
      "../src/main/vellum-command/state/engine"
    );
    const { resolveJuntoHome } = await import("../src/shared/junto-home");

    // JUNTO_HOME is the only product redirect (test setup / dev use it).
    // Retired flags like JUNTO_STATE_DB must not open a second store.
    expect(stateDatabasePath()).toBe(
      join(resolveJuntoHome(), ".junto", "state", "junto.db"),
    );
    expect(stateDatabasePath()).not.toBe("/tmp/untrusted-second-home.db");
  });

  it("keeps database override vocabulary out of every shipped main source", () => {
    const mainRoot = join(import.meta.dirname, "..", "src", "main");
    const offenders = runtimeSources(mainRoot)
      .filter((path) =>
        readFileSync(path, "utf8").includes("JUNTO_STATE_DB")
      )
      .map((path) => relative(mainRoot, path));

    expect(offenders).toEqual([]);
    // The retired-signature audit remains anchored to the historical token so
    // an old packaged payload cannot silently reintroduce the override.
    expect(RETIRED_PRODUCT_STATE_SIGNATURES).toContain("JUNTO_STATE_DB");
  });

  it("releases the demo capability after the sole runtime owner disposes", () => {
    const indexSource = readFileSync(
      join(import.meta.dirname, "..", "src", "main", "index.ts"),
      "utf8",
    );
    const engineSource = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "src",
        "main",
        "vellum-command",
        "state",
        "engine.ts",
      ),
      "utf8",
    );

    expect(indexSource).toContain(
      ".finally(releaseDemoRuntimeIsolation)",
    );
    expect(engineSource).not.toContain("JUNTO_E2E");
    expect(engineSource).not.toContain("VITEST");
    expect(engineSource).not.toContain("process.env");
  });
});
