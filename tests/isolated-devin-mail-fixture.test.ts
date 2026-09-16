import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedIsolatedJuntoCli } from "../e2e/harness/isolated-devin-mail-fixture";
import { seededHarnessBinDir } from "../e2e/harness/agent-harness-fixture";
import type { Sandbox } from "../e2e/harness/sandbox";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-cli-fixture-"));
  roots.push(root);
  const repoRoot = join(root, "checkout");
  await mkdir(join(repoRoot, "dist"), { recursive: true });
  const bytes = Buffer.from("#!/bin/sh\nprintf '%s\\n' 'fixture executable' \"$HOME\" \"$PWD\" \"$JUNTO_WORK_SOCKET\" \"$1\"\n");
  const binary = join(repoRoot, "dist", "junto");
  const installArtifact = async () => {
    await writeFile(binary, bytes);
  };
  const sandbox: Sandbox = {
    root: join(root, "sandbox"), homeDir: join(root, "sandbox", "home"),
    userDataDir: join(root, "sandbox", "user-data"),
    canvasesDir: join(root, "sandbox", "home", ".junto", "canvases"),
  };
  return { repoRoot, sandbox, binary, bytes, installArtifact };
};

describe("isolated real-harness CLI provisioning", () => {
  it("fails before any sandbox seeding when the build is absent", async () => {
    const f = await fixture();
    await expect(seedIsolatedJuntoCli(f.sandbox, f.repoRoot)).rejects.toThrow("no compiled Junto CLI");
    expect(existsSync(f.sandbox.homeDir)).toBe(false);
  });

  it("resolves the copied executable on isolated PATH and preserves seat env", async () => {
    const f = await fixture();
    await f.installArtifact();
    const seeded = await seedIsolatedJuntoCli(f.sandbox, f.repoRoot);
    expect(await readFile(seeded.executable)).toEqual(f.bytes);
    await writeFile(f.binary, "new build");
    expect(await readFile(seeded.executable)).toEqual(f.bytes);
    const cwd = join(f.sandbox.root, "throwaway-cwd");
    await mkdir(cwd);
    const socket = join(f.sandbox.homeDir, ".junto", "work", "control.sock");
    const stdout = execFileSync("/bin/sh", ["-c", "command -v junto && exec junto --help"], {
      cwd, encoding: "utf8", env: {
        HOME: f.sandbox.homeDir, PATH: `${seededHarnessBinDir(f.sandbox)}:/usr/bin:/bin`,
        JUNTO_WORK_SOCKET: socket,
      },
    });
    const lines = stdout.trim().split("\n");
    expect(lines.slice(0, 3)).toEqual([seeded.executable, "fixture executable", f.sandbox.homeDir]);
    expect(lines[3]?.endsWith("/sandbox/throwaway-cwd")).toBe(true);
    expect(lines.slice(4)).toEqual([socket, "--help"]);
  });
});
