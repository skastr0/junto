import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  declareMachineCoreOwnsSessions,
  launchForManagedSpawn,
  shouldAvoidSharedHarnessResume,
} from "../src/main/junto/term/managed-spawn-plan";

describe("isolated JUNTO_HOME that owns its sessions", () => {
  it("still refuses shared resume by default", () => {
    expect(shouldAvoidSharedHarnessResume("/tmp/junto-iso", undefined)).toBe(true);
    expect(shouldAvoidSharedHarnessResume("/tmp/junto-iso", "0")).toBe(true);
  });

  it("resumes when the tree declares every pin on it its own", () => {
    expect(shouldAvoidSharedHarnessResume("/tmp/junto-iso", "1")).toBe(false);
  });

  it("the production home never isolates", () => {
    expect(shouldAvoidSharedHarnessResume("", "")).toBe(false);
  });
});

describe("a machine core's home", () => {
  it("is owned by the core: a pinned Claude seat launches the id it pinned", () => {
    const saved = { home: process.env.JUNTO_HOME, owns: process.env.JUNTO_HOME_OWNS_SESSIONS };
    const pinned = "19f242d7-0000-4000-8000-000000000001";
    const launch = () =>
      launchForManagedSpawn({ harness: "claude", agentKey: "local:claude", sessionId: pinned, resume: false }).launch?.argv ?? [];
    try {
      // The service sets JUNTO_HOME for every machine core, the default home included.
      process.env.JUNTO_HOME = "/Users/op";
      delete process.env.JUNTO_HOME_OWNS_SESSIONS;
      expect(launch()).not.toContain(pinned);
      declareMachineCoreOwnsSessions(process.env);
      expect(launch()).toContain(pinned);
    } finally {
      if (saved.home === undefined) delete process.env.JUNTO_HOME;
      else process.env.JUNTO_HOME = saved.home;
      if (saved.owns === undefined) delete process.env.JUNTO_HOME_OWNS_SESSIONS;
      else process.env.JUNTO_HOME_OWNS_SESSIONS = saved.owns;
    }
  });

  it("is declared owned by the machine entry before the core starts", () => {
    const entry = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/main/headless.ts"), "utf8");
    const declared = entry.indexOf("declareMachineCoreOwnsSessions(process.env)");
    expect(declared).toBeGreaterThan(-1);
    expect(declared).toBeLessThan(entry.indexOf("await startCore("));
  });
});
