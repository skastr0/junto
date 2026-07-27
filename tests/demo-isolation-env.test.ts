import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDemo = process.env.VELLUM_DEMO;
const originalE2E = process.env.VELLUM_E2E;
const originalVitest = process.env.VITEST;
const originalStateDatabase = process.env.VELLUM_STATE_DB;
const originalProjectionRoot = process.env.VELLUM_CANVASES_DIR;

const restore = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

beforeEach(() => {
  vi.resetModules();
  delete process.env.VELLUM_DEMO;
  delete process.env.VELLUM_E2E;
  delete process.env.VITEST;
  delete process.env.VELLUM_STATE_DB;
  delete process.env.VELLUM_CANVASES_DIR;
});

afterEach(() => {
  restore("VELLUM_DEMO", originalDemo);
  restore("VELLUM_E2E", originalE2E);
  restore("VITEST", originalVitest);
  restore("VELLUM_STATE_DB", originalStateDatabase);
  restore("VELLUM_CANVASES_DIR", originalProjectionRoot);
  vi.resetModules();
});

describe("demo runtime isolation", () => {
  it("defaults both canonical state and projection outputs under a demo-only root", async () => {
    process.env.VELLUM_DEMO = "1";
    process.env.VELLUM_STATE_DB = "";
    process.env.VELLUM_CANVASES_DIR = "";

    await import("../src/main/vellum/demo/isolation-env");

    const demoRoot = join(homedir(), ".vellum", "demo");
    expect(process.env.VELLUM_STATE_DB).toBe(
      join(demoRoot, "state", "vellum.db"),
    );
    expect(process.env.VELLUM_CANVASES_DIR).toBe(
      join(demoRoot, "projections"),
    );

    const { stateDatabasePath } = await import(
      "../src/main/vellum/state/engine"
    );
    expect(stateDatabasePath()).toBe(join(demoRoot, "state", "vellum.db"));
  });

  it("preserves explicit hermetic launch overrides", async () => {
    process.env.VELLUM_DEMO = "1";
    process.env.VELLUM_STATE_DB = "/tmp/vellum-demo-test/state.db";
    process.env.VELLUM_CANVASES_DIR = "/tmp/vellum-demo-test/projections";

    await import("../src/main/vellum/demo/isolation-env");

    expect(process.env.VELLUM_STATE_DB).toBe(
      "/tmp/vellum-demo-test/state.db",
    );
    expect(process.env.VELLUM_CANVASES_DIR).toBe(
      "/tmp/vellum-demo-test/projections",
    );
  });

  it("is inert outside demo mode", async () => {
    await import("../src/main/vellum/demo/isolation-env");

    expect(process.env.VELLUM_STATE_DB).toBeUndefined();
    expect(process.env.VELLUM_CANVASES_DIR).toBeUndefined();
  });

  it("does not let an ordinary product environment redirect authority", async () => {
    process.env.VELLUM_STATE_DB = "/tmp/vellum-untrusted-override/state.db";

    await import("../src/main/vellum/demo/isolation-env");
    const { stateDatabasePath } = await import(
      "../src/main/vellum/state/engine"
    );

    expect(process.env.VELLUM_STATE_DB).toBe(
      "/tmp/vellum-untrusted-override/state.db",
    );
    expect(stateDatabasePath()).toBe(
      join(homedir(), ".vellum", "state", "vellum.db"),
    );
  });

  it("honors the explicit E2E isolation contract", async () => {
    process.env.VELLUM_E2E = "1";
    process.env.VELLUM_STATE_DB = "/tmp/vellum-e2e/state.db";

    const { stateDatabasePath } = await import(
      "../src/main/vellum/state/engine"
    );

    expect(stateDatabasePath()).toBe("/tmp/vellum-e2e/state.db");
  });

  it("keeps Vitest app runtimes on their supplied sandbox database", async () => {
    process.env.VITEST = "true";
    process.env.VELLUM_STATE_DB = "/tmp/vellum-vitest/state.db";

    const { stateDatabasePath } = await import(
      "../src/main/vellum/state/engine"
    );

    expect(stateDatabasePath()).toBe("/tmp/vellum-vitest/state.db");
    expect(stateDatabasePath()).not.toBe(
      join(homedir(), ".vellum", "state", "vellum.db"),
    );
  });

  it("runs before the runtime import in the Electron entry point", () => {
    const indexSource = readFileSync(
      join(import.meta.dirname, "..", "src", "main", "index.ts"),
      "utf8",
    );
    const isolationImport = indexSource.indexOf(
      'import "./vellum/demo/isolation-env";',
    );
    const runtimeImport = indexSource.indexOf(
      'import { AppRuntime } from "./runtime";',
    );

    expect(isolationImport).toBeGreaterThanOrEqual(0);
    expect(runtimeImport).toBeGreaterThan(isolationImport);
    expect(indexSource.slice(0, isolationImport)).not.toContain("import ");
  });
});
