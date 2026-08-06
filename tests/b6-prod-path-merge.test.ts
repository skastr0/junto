import { homedir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import {
  mergePath,
  resolvedSpawnEnv,
  resolvedSpawnEnvSync,
  staticPathDirs,
} from "../src/main/vellum/adapters/exec";

// b6-prod: the spawn plane must resolve user-installed CLIs under a
// packaged/launchd/Finder launch, where the process inherits launchd's minimal
// PATH (/usr/bin:/bin:/usr/sbin:/sbin) and no shell rc is sourced. The merge
// logic is extracted pure so its ordering/dedup/fallback contract is testable
// without spawning a shell; one guarded integration case exercises the real
// login-shell probe.

const HOME = "/home/tester";
const split = (p: string) => p.split(":");

describe("staticPathDirs", () => {
  it("lists the guaranteed floor in priority order", () => {
    expect(staticPathDirs(HOME)).toEqual([
      "/home/tester/.local/bin",
      "/home/tester/.local/share/mise/shims",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]);
  });
});

describe("mergePath", () => {
  it("login-shell success: user PATH entries come first, in order", () => {
    const merged = mergePath({
      loginShellPath: "/opt/homebrew/bin:/home/tester/.local/bin",
      currentPath: "/usr/bin:/bin",
      home: HOME,
    });
    const dirs = split(merged);
    expect(dirs[0]).toBe("/opt/homebrew/bin");
    expect(dirs[1]).toBe("/home/tester/.local/bin");
    // process PATH follows the login PATH, before the static-only remainder.
    expect(dirs.indexOf("/usr/bin")).toBeLessThan(dirs.indexOf("/usr/local/bin"));
    // every static-floor dir is still present after the merge.
    for (const dir of staticPathDirs(HOME)) expect(dirs).toContain(dir);
  });

  it("login-shell failure: falls back to current PATH + static floor", () => {
    // The exact hostile case: launchd's minimal PATH, no login shell resolved.
    const merged = mergePath({
      loginShellPath: undefined,
      currentPath: "/usr/bin:/bin:/usr/sbin:/sbin",
      home: HOME,
    });
    const dirs = split(merged);
    // The two dirs that actually resolve hermes/codex/bun tooling.
    expect(dirs).toContain("/home/tester/.local/bin");
    expect(dirs).toContain("/home/tester/.local/share/mise/shims");
    expect(dirs).toContain("/opt/homebrew/bin");
    // inherited minimal PATH is preserved, still first.
    expect(dirs.slice(0, 4)).toEqual(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
  });

  it("empty current PATH (undefined) still yields the full static floor", () => {
    const merged = mergePath({ home: HOME });
    expect(split(merged)).toEqual(staticPathDirs(HOME));
  });

  it("dedups, keeping first occurrence", () => {
    const merged = mergePath({
      loginShellPath: "/a:/a:/b",
      currentPath: "/b:/c",
      home: HOME,
    });
    const dirs = split(merged);
    expect(dirs.slice(0, 3)).toEqual(["/a", "/b", "/c"]);
    // no dir appears twice across the whole merged PATH.
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it("drops empty segments and trims whitespace", () => {
    const merged = mergePath({
      loginShellPath: " /x : : /y ",
      currentPath: "",
      home: HOME,
    });
    const dirs = split(merged);
    expect(dirs[0]).toBe("/x");
    expect(dirs[1]).toBe("/y");
    expect(dirs).not.toContain("");
    expect(dirs).not.toContain(" ");
  });
});

describe("resolvedSpawnEnvSync", () => {
  it("returns an env whose PATH carries the real static floor without spawning a shell", () => {
    const env = resolvedSpawnEnvSync();
    const dirs = split(env.PATH ?? "");
    expect(dirs).toContain(`${homedir()}/.local/bin`);
    expect(dirs).toContain(`${homedir()}/.local/share/mise/shims`);
  });
});

// One guarded integration case — spawns the real login shell exactly once.
// Skip with VELLUM_COMMAND_SKIP_SHELL_INTEGRATION=1 in shell-less CI.
const skipShell = process.env.VELLUM_COMMAND_SKIP_SHELL_INTEGRATION === "1";
describe("resolvedSpawnEnv (integration)", () => {
  const originalPath = process.env.PATH;
  afterAll(() => {
    process.env.PATH = originalPath;
  });

  it.skipIf(skipShell)(
    "resolves an env containing the static floor and mutates process.env.PATH once",
    async () => {
      const env = await resolvedSpawnEnv();
      const dirs = split(env.PATH ?? "");
      // Deterministic regardless of whether the login shell succeeds: the
      // static floor is always appended.
      expect(dirs).toContain(`${homedir()}/.local/bin`);
      expect(dirs).toContain(`${homedir()}/.local/share/mise/shims`);
      // The single documented mutation: process.env.PATH now equals the merge.
      expect(process.env.PATH).toBe(env.PATH);
      // Memoized: a second call returns the same object.
      const again = await resolvedSpawnEnv();
      expect(again).toBe(env);
    },
  );
});
