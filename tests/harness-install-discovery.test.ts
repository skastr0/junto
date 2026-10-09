import { accessSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enumeratedToolDirs, enumeratedToolDirsAsync, setConfiguredToolDirectories } from "../src/main/junto/adapters/exec";
import {
  probeManagedHarnessInstalls,
  resetManagedHarnessInstallCacheForTests,
  resolveHarnessExecutable,
} from "../src/main/junto/term/templates/harness-install";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    accessSync: vi.fn(actual.accessSync),
    readdirSync: vi.fn(actual.readdirSync),
    statSync: vi.fn(actual.statSync),
  };
});

const homes: string[] = [];
const scratch = () => {
  const home = mkdtempSync(join(tmpdir(), "junto-install-discovery-"));
  homes.push(home);
  return home;
};
const binary = (dir: string, name: string, body = "exit 0", mode = 0o755) => {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, mode);
  return file;
};
const installed = async (options: Parameters<typeof probeManagedHarnessInstalls>[0], harness = "codex") =>
  (await probeManagedHarnessInstalls(options)).find((row) => row.harness === harness)?.installed;

afterEach(() => {
  resetManagedHarnessInstallCacheForTests();
  setConfiguredToolDirectories([]);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(readdir).mockClear();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("shared asynchronous harness discovery", () => {
  it("walks once for all harnesses and shares concurrent and repeated requests", async () => {
    const home = scratch();
    const dir = join(home, ".nvm", "versions", "node", "v24", "bin");
    binary(dir, "codex");
    binary(dir, "claude");
    for (const check of [accessSync, readdirSync, statSync]) vi.mocked(check).mockClear();
    const options = { home, pathEnv: "", extraDirs: [] };
    const first = probeManagedHarnessInstalls(options);
    expect(probeManagedHarnessInstalls(options)).toBe(first);
    expect((await first).filter((row) => row.installed).map((row) => row.harness)).toContain("codex");
    expect(await installed(options, "claude")).toBe(true);
    const walks = vi.mocked(readdir).mock.calls.length;
    expect(probeManagedHarnessInstalls(options)).toBe(first);
    expect(vi.mocked(readdir).mock.calls.length).toBe(walks);
    expect(vi.mocked(readdir).mock.calls.filter(([path]) => path === dir)).toHaveLength(1);
    expect(vi.mocked(readdir).mock.calls.filter(([path]) => path === join(home, ".nvm", "versions", "node"))).toHaveLength(1);
    for (const check of [accessSync, readdirSync, statSync]) expect(check).not.toHaveBeenCalled();
  });

  it("notices a new version-manager install and removal after expiry", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const home = scratch();
    const options = { home, pathEnv: "", extraDirs: [] };
    expect(await installed(options)).toBe(false);
    const file = binary(join(home, ".local", "share", "mise", "installs", "node", "24", "bin"), "codex");
    expect(await installed(options)).toBe(false);
    now += 60_000;
    expect(await installed(options)).toBe(true);
    rmSync(file);
    now += 60_000;
    expect(await installed(options)).toBe(false);
  });

  it("invalidates immediately for HOME, PATH and configured directories", async () => {
    const home = scratch();
    const dir = join(home, "tools");
    binary(dir, "codex");
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", "");
    expect(await installed({})).toBe(false);
    vi.stubEnv("PATH", dir);
    expect(await installed({})).toBe(true);
    vi.stubEnv("PATH", "");
    expect(await installed({})).toBe(false);
    setConfiguredToolDirectories([dir]);
    expect(await installed({})).toBe(true);
    setConfiguredToolDirectories([]);
    binary(join(home, ".local", "bin"), "codex");
    expect(await installed({})).toBe(true);
    vi.stubEnv("HOME", scratch());
    expect(await installed({})).toBe(false);
  });

  it("keeps executable and shim checks, while shim discovery yields to main", async () => {
    const home = scratch();
    const shims = join(home, "shims");
    const real = join(home, "real");
    binary(shims, "codex", "exit 1");
    binary(shims, "claude", "sleep 0.05\nexit 0");
    binary(real, "codex");
    binary(real, "prime-agent", "exit 0", 0o644);
    const options = { home, pathEnv: `${shims}:${real}`, extraDirs: [] };
    let yielded = false;
    setImmediate(() => { yielded = true; });
    const rows = await probeManagedHarnessInstalls(options);
    expect(yielded).toBe(true);
    expect(rows.find((row) => row.harness === "codex")?.installed).toBe(true);
    expect(rows.find((row) => row.harness === "claude")?.installed).toBe(true);
    expect(rows.find((row) => row.harness === "prime-agent")?.installed).toBe(false);
    // Cached palette truth cannot bypass the fresh executable check at launch.
    chmodSync(join(real, "codex"), 0o644);
    expect(resolveHarnessExecutable("codex", options)).toBeUndefined();
  });

  it("matches synchronous launch ordering for version aliases and numbered roots", async () => {
    const home = scratch();
    const root = join(home, ".local", "share", "mise", "installs", "node");
    for (const name of ["v9", "v24", "old"]) mkdirSync(join(root, name, "bin"), { recursive: true });
    symlinkSync(join(root, "v24"), join(root, "latest"));
    expect(await enumeratedToolDirsAsync(home)).toEqual(enumeratedToolDirs(home));
  });
});
