import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, expect, it, vi } from "vitest";

// Main with the core in its own process: the flag is read once, at import.
const home = await mkdtemp("/tmp/junto-flag-");
process.env.JUNTO_CORE_PROCESS = "1";
process.env.JUNTO_HOME = home;
vi.mock("electron", () => {
  const electron = {
    app: { getVersion: () => "0.0.0", isPackaged: false, getPath: () => "/tmp", getAppPath: () => "/tmp" },
    utilityProcess: { fork: () => { throw new Error("no utilityProcess in tests"); } },
  };
  return { ...electron, default: electron };
});
vi.mock("../src/main/core-process/entry?modulePath", () => ({ default: "/core-entry.js" }));

const { AppRuntime } = await import("../src/main/runtime");
const { coreRunner } = await import("../src/main/core-runner");

afterAll(async () => {
  await AppRuntime.dispose();
  delete process.env.JUNTO_CORE_PROCESS;
  await rm(home, { recursive: true, force: true });
});

it("builds no business writer in main when the core runs in its own process", async () => {
  // Nothing in main reaches the database: main's runtime gives no SQL client...
  await expect(AppRuntime.runPromise(Effect.asVoid(SqlClient.SqlClient))).rejects.toThrow();
  // ...the core runner is not main's (with the flag off it is)...
  await expect(coreRunner.runPromise(Effect.asVoid(SqlClient.SqlClient))).rejects.toThrow("Junto core is not running");
  // ...and main opened no database file.
  expect(existsSync(join(home, ".junto", "state", "junto.db"))).toBe(false);
});
