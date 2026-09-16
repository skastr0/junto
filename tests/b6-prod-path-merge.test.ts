import { homedir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import {
  loginShellPathFromProbeOutput,
  mergePath,
  resolvedSpawnEnv,
  resolvedSpawnEnvSync,
  staticPathDirs,
} from "../src/main/junto/adapters/exec";

// The spawn plane resolves user-installed CLIs under a packaged/launchd/Finder
// launch by merging the operator's login-shell PATH with a static fallback
// floor. The merge logic is pure so the ordering, deduplication, and floor
// are testable without executing any user-controlled shell code.

const HOME = "/home/tester";
const split = (p: string) => p.split(":");

describe("staticPathDirs", () => {
  it("lists the guaranteed floor in priority order", () => {
    expect(staticPathDirs(HOME)).toEqual([
      "/home/tester/.local/bin",
      "/home/tester/.kimi-code/bin",
      "/home/tester/.bun/bin",
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
  it("inherited PATH entries come first, in order", () => {
    const merged = mergePath({
      currentPath: "/opt/homebrew/bin:/home/tester/.local/bin:/usr/bin:/bin",
      home: HOME,
    });
    const dirs = split(merged);
    expect(dirs[0]).toBe("/opt/homebrew/bin");
    expect(dirs[1]).toBe("/home/tester/.local/bin");
    // inherited PATH remains ahead of the static-only remainder.
    expect(dirs.indexOf("/usr/bin")).toBeLessThan(dirs.indexOf("/usr/local/bin"));
    // every static-floor dir is still present after the merge.
    for (const dir of staticPathDirs(HOME)) expect(dirs).toContain(dir);
  });

  it("launchd's minimal PATH gains the static floor", () => {
    const merged = mergePath({
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

  it("places explicit tool directories after inherited PATH and before the static floor", () => {
    const merged = mergePath({
      currentPath: "/usr/bin:/bin",
      home: HOME,
      extraDirs: ["/opt/custom/bin", " /opt/custom/bin "],
    });
    const dirs = split(merged);
    expect(dirs.slice(0, 3)).toEqual(["/usr/bin", "/bin", "/opt/custom/bin"]);
    expect(dirs.indexOf("/opt/custom/bin")).toBeLessThan(
      dirs.indexOf("/home/tester/.local/bin"),
    );
  });

  it("login-shell PATH precedes inherited PATH and the floor", () => {
    const merged = mergePath({
      loginShellPath: "/home/tester/.bun/bin:/opt/login/bin",
      currentPath: "/usr/bin:/bin",
      home: HOME,
    });
    const dirs = split(merged);
    expect(dirs[0]).toBe("/home/tester/.bun/bin");
    expect(dirs[1]).toBe("/opt/login/bin");
    expect(dirs.indexOf("/opt/login/bin")).toBeLessThan(dirs.indexOf("/usr/bin"));
    // A real binary dir from the login shell outranks a stale shim dir below.
    expect(dirs.indexOf("/home/tester/.bun/bin")).toBeLessThan(
      dirs.indexOf("/home/tester/.local/share/mise/shims"),
    );
  });

  it("dedups, keeping first occurrence", () => {
    const merged = mergePath({
      currentPath: "/a:/a:/b:/b:/c",
      home: HOME,
    });
    const dirs = split(merged);
    expect(dirs.slice(0, 3)).toEqual(["/a", "/b", "/c"]);
    // no dir appears twice across the whole merged PATH.
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it("drops empty segments and trims whitespace", () => {
    const merged = mergePath({
      currentPath: " /x : : /y ",
      home: HOME,
    });
    const dirs = split(merged);
    expect(dirs[0]).toBe("/x");
    expect(dirs[1]).toBe("/y");
    expect(dirs).not.toContain("");
    expect(dirs).not.toContain(" ");
  });
});

describe("loginShellPathFromProbeOutput", () => {
  it("extracts PATH between the sentinels, ignoring rc noise", () => {
    const output = [
      "shell greeting noise",
      "JUNTO_ENV_BEGIN",
      "HOME=/home/tester",
      "PATH=/home/tester/.bun/bin:/usr/bin:/bin",
      "SHELL=/bin/zsh",
      "JUNTO_ENV_END",
      "more noise after",
    ].join("\n");
    expect(loginShellPathFromProbeOutput(output)).toBe(
      "/home/tester/.bun/bin:/usr/bin:/bin",
    );
  });

  it("returns undefined when sentinels or PATH are absent", () => {
    expect(loginShellPathFromProbeOutput("")).toBeUndefined();
    expect(
      loginShellPathFromProbeOutput("JUNTO_ENV_BEGIN\nFOO=1\n"),
    ).toBeUndefined();
    expect(
      loginShellPathFromProbeOutput(
        "JUNTO_ENV_BEGIN\nFOO=1\nJUNTO_ENV_END\n",
      ),
    ).toBeUndefined();
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

describe("resolvedSpawnEnv", () => {
  const originalPath = process.env.PATH;
  afterAll(() => {
    process.env.PATH = originalPath;
  });

  it("resolves an env containing the static floor and mutates process.env.PATH once", async () => {
    const env = await resolvedSpawnEnv();
    const dirs = split(env.PATH ?? "");
    // Deterministic without invoking a shell: the static floor is appended.
    expect(dirs).toContain(`${homedir()}/.local/bin`);
    expect(dirs).toContain(`${homedir()}/.local/share/mise/shims`);
    // The single documented mutation: process.env.PATH now equals the merge.
    expect(process.env.PATH).toBe(env.PATH);
    // Memoized: a second call returns the same object.
    const again = await resolvedSpawnEnv();
    expect(again).toBe(env);
  });
});
