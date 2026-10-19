import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  mergePath,
  resolvedSpawnEnvSync,
  staticPathDirs,
} from "../src/main/junto/adapters/exec";
import { runTool } from "../src/main/junto/region-env/tool";
import { probeShellEnvironment, shellEnvironmentFromProbeOutput } from "../src/main/junto/shell-environment";

// The spawn plane resolves user-installed CLIs under a packaged/launchd/Finder
// launch from the operator's login-shell environment, merged over inherited
// PATH, operator tool directories, and a static fallback floor. The merge and
// the probe's parse are pure; the probe itself runs here against a fake shell,
// never the operator's own rc files.

const HOME = "/home/tester";
const split = (p: string) => p.split(":");

describe("staticPathDirs", () => {
  it("lists the guaranteed floor in priority order", () => {
    expect(staticPathDirs(HOME)).toEqual([
      "/home/tester/.local/bin",
      "/home/tester/.kimi-code/bin",
      "/home/tester/.bun/bin",
      "/home/tester/.grok/bin",
      "/home/tester/.volta/bin",
      "/home/tester/.cargo/bin",
      "/home/tester/.deno/bin",
      "/home/tester/go/bin",
      "/home/tester/bin",
      "/home/tester/.local/share/pnpm",
      "/home/tester/Library/pnpm",
      "/home/tester/.nix-profile/bin",
      "/home/tester/.local/share/mise/shims",
      "/home/tester/.asdf/shims",
      "/home/tester/.pyenv/shims",
      "/home/tester/.rbenv/shims",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/opt/local/bin",
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

  it("puts the operator's shell PATH first, then inherited PATH, tool dirs and the floor", () => {
    const merged = mergePath({
      shellPath: "/home/tester/.local/share/mise/installs/node/24/bin:/usr/bin",
      currentPath: "/usr/bin:/opt/inherited/bin",
      home: HOME,
      extraDirs: ["/opt/custom/bin"],
    });
    const dirs = split(merged);
    expect(dirs.slice(0, 4)).toEqual([
      "/home/tester/.local/share/mise/installs/node/24/bin",
      "/usr/bin",
      "/opt/inherited/bin",
      "/opt/custom/bin",
    ]);
    // An activated install outranks the same manager's shim dir in the floor.
    expect(dirs.indexOf("/home/tester/.local/share/mise/installs/node/24/bin")).toBeLessThan(
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

describe("resolvedSpawnEnvSync", () => {
  it("returns an env whose PATH carries the real static floor without spawning a shell", () => {
    const env = resolvedSpawnEnvSync();
    const dirs = split(env.PATH ?? "");
    expect(dirs).toContain(`${homedir()}/.local/bin`);
    expect(dirs).toContain(`${homedir()}/.local/share/mise/shims`);
  });
});

const scratch: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in login shell: rc noise, then the framed dump the probe asks for. */
const fakeShell = (body: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "junto-fake-shell-"));
  scratch.push(dir);
  const shell = join(dir, "fakesh");
  writeFileSync(shell, `#!/bin/sh\nprintf 'Welcome back\\n'\n${body}\n`);
  chmodSync(shell, 0o755);
  return shell;
};

const DUMP = String.raw`printf 'JUNTO_ENV_BEGIN\n'
printf 'PATH=/fake/bin:/usr/bin\0PROBE_ARGS=%s\0PROBE_CWD=%s\0PROBE_RESOLVING=%s\0PROBE_STDIN=%s\0' "$1 $2 $3" "$(pwd -P)" "$JUNTO_RESOLVING_ENVIRONMENT" "$(cat)"
printf 'MULTI=one\ntwo\0JUNTO_HOME=/elsewhere\0PWD=/rc/cwd\0SHLVL=3\0'
printf 'JUNTO_ENV_END\n'`;

describe("shellEnvironmentFromProbeOutput", () => {
  it("reads only between the sentinels, keeping values with newlines", () => {
    expect(shellEnvironmentFromProbeOutput(
      "motd\nJUNTO_ENV_BEGIN\nPATH=/a:/b\0KEY=x=y\0MULTI=1\n2\0JUNTO_ENV_END\nbye\n",
    )).toEqual({ PATH: "/a:/b", KEY: "x=y", MULTI: "1\n2" });
  });

  it("drops shell bookkeeping and the app's own keys", () => {
    expect(shellEnvironmentFromProbeOutput(
      "JUNTO_ENV_BEGIN\nPATH=/a\0PWD=/x\0OLDPWD=/y\0SHLVL=2\0_=/usr/bin/env\0TERM=dumb\0JUNTO_HOME=/h\0ELECTRON_RUN_AS_NODE=1\0JUNTO_RESOLVING_ENVIRONMENT=1\0JUNTO_ENV_END\n",
    )).toEqual({ PATH: "/a" });
  });

  it("refuses a cut-off dump, an `env` without -0, and an environment with no PATH", () => {
    expect(shellEnvironmentFromProbeOutput("JUNTO_ENV_BEGIN\nPATH=/a\0HOME=/h")).toBeUndefined();
    expect(shellEnvironmentFromProbeOutput("JUNTO_ENV_BEGIN\nPATH=/a\nHOME=/h\nJUNTO_ENV_END\n")).toBeUndefined();
    expect(shellEnvironmentFromProbeOutput("JUNTO_ENV_BEGIN\nHOME=/h\0JUNTO_ENV_END\n")).toBeUndefined();
    expect(shellEnvironmentFromProbeOutput("no sentinels at all")).toBeUndefined();
  });
});

describe("probeShellEnvironment", () => {
  it("runs the shell as login and interactive, in the given cwd, with stdin closed and the resolving marker", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "junto-probe-cwd-")));
    scratch.push(cwd);
    const probe = await probeShellEnvironment(runTool, { shell: fakeShell(DUMP), cwd, env: process.env });
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.environment.PROBE_ARGS).toBe("-l -i -c");
    expect(probe.environment.PROBE_CWD).toBe(cwd);
    expect(probe.environment.PROBE_RESOLVING).toBe("1");
    expect(probe.environment.PROBE_STDIN).toBe("");
  });

  it("takes a complete dump even when the shell then exits non-zero", async () => {
    const probe = await probeShellEnvironment(runTool, {
      shell: fakeShell(`${DUMP}\nexit 3`),
      cwd: tmpdir(),
      env: process.env,
    });
    expect(probe.ok && probe.environment.PATH).toBe("/fake/bin:/usr/bin");
  });

  it("fails with a typed cause, never the shell's own words, when it prints no environment", async () => {
    const probe = await probeShellEnvironment(runTool, {
      shell: fakeShell("echo 'rc broke: token sk-live-123' >&2; exit 1"),
      cwd: tmpdir(),
      env: process.env,
    });
    expect(probe).toEqual({ ok: false, cause: { _tag: "Exited", code: 1 } });
  });

  it("names a shell that printed but without the markers", async () => {
    const probe = await probeShellEnvironment(runTool, {
      shell: fakeShell("env"),
      cwd: tmpdir(),
      env: process.env,
    });
    expect(probe).toEqual({ ok: false, cause: { _tag: "NoEnvironment" } });
  });
});

describe("resolvedSpawnEnv", () => {
  const originalPath = process.env.PATH;
  afterAll(() => {
    process.env.PATH = originalPath;
    for (const key of ["PROBE_ARGS", "PROBE_CWD", "PROBE_RESOLVING", "PROBE_STDIN", "MULTI"]) {
      delete process.env[key];
    }
  });

  it("adopts the operator shell's environment once, from an app-owned cwd, over the floor", async () => {
    vi.stubEnv("SHELL", fakeShell(DUMP));
    vi.stubEnv("JUNTO_SHELL_ENVIRONMENT", "");
    const juntoHome = process.env.JUNTO_HOME;
    // The module reads its switch as it loads: a fresh copy, with the probe on.
    vi.resetModules();
    const { resolvedSpawnEnv } = await import("../src/main/junto/adapters/exec");
    const env = await resolvedSpawnEnv();
    const dirs = split(env.PATH ?? "");
    // The shell's PATH leads; the static floor still backs it.
    expect(dirs.slice(0, 2)).toEqual(["/fake/bin", "/usr/bin"]);
    expect(dirs).toContain(`${homedir()}/.local/share/mise/shims`);
    // The single documented mutation: process.env carries the shell's
    // variables and the merged PATH, and nothing of the app's own.
    expect(process.env.PATH).toBe(env.PATH);
    expect(process.env.MULTI).toBe("one\ntwo");
    expect(process.env.JUNTO_HOME).toBe(juntoHome);
    expect(process.env.PWD).not.toBe("/rc/cwd");
    expect(env.PROBE_CWD).toBe(realpathSync(join(juntoHome!, ".junto")));
    // Memoized: a second call returns the same object without a second probe.
    const again = await resolvedSpawnEnv();
    expect(again).toBe(env);
  });
});
