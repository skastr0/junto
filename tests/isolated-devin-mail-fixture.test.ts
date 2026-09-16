import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedIsolatedVellumCli } from "../e2e/harness/isolated-devin-mail-fixture";
import { seededHarnessBinDir } from "../e2e/harness/agent-harness-fixture";
import type { Sandbox } from "../e2e/harness/sandbox";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "vellum-command-cli-fixture-"));
  roots.push(root);
  const repoRoot = join(root, "checkout");
  await mkdir(join(repoRoot, "src"), { recursive: true });
  await mkdir(join(repoRoot, "dist"));
  await writeFile(join(repoRoot, "src", "cli.ts"), "export const version = 1;\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  git("init", "-q");
  const commit = () => {
    git("add", "src");
    git("-c", "user.name=CLI fixture", "-c", "user.email=fixture@local",
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
      "commit", "-q", "-m", "fixture source");
    return git("rev-parse", "HEAD");
  };
  const sourceCommit = commit();
  // A labeled transport test artifact, never a substitute for the real CLI
  // in the Devin scenario. Native qualification builds the standalone CLI.
  const bytes = Buffer.from("#!/bin/sh\nprintf '%s\\n' 'fixture executable' \"$HOME\" \"$PWD\" \"$JUNTO_WORK_SOCKET\" \"$1\"\n");
  const binary = join(repoRoot, "dist", "vellum-command");
  const receiptPath = `${binary}-relink.json`;
  const receipt = {
    schema: "vellum-command/cli-relink/v1", sourceCommit, featureProfile: "all-on",
    binary: { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
  };
  const installArtifact = async (metadata: unknown = receipt) => {
    await writeFile(binary, bytes);
    await writeFile(receiptPath, JSON.stringify(metadata));
  };
  const sandbox: Sandbox = {
    root: join(root, "sandbox"), homeDir: join(root, "sandbox", "home"),
    userDataDir: join(root, "sandbox", "user-data"),
    canvasesDir: join(root, "sandbox", "home", ".vellum-command", "canvases"),
  };
  return { repoRoot, sandbox, binary, receiptPath, receipt, bytes, git, commit, installArtifact };
};

describe("isolated real-harness CLI provisioning", () => {
  it("fails before any sandbox seeding when the build is absent", async () => {
    const f = await fixture();
    await expect(seedIsolatedVellumCli(f.sandbox, f.repoRoot)).rejects.toThrow("no compiled Junto CLI");
    expect(existsSync(f.sandbox.homeDir)).toBe(false);
  });

  it.each([
    { sourceCommit: null }, { sourceCommit: "unknown" }, { featureProfile: "ship" },
  ])("refuses an unproven or mismatched profile receipt: %j", async (override) => {
    const f = await fixture();
    await f.installArtifact({ ...f.receipt, ...override });
    await expect(seedIsolatedVellumCli(f.sandbox, f.repoRoot)).rejects.toThrow("committed, all-on CLI build receipt");
    expect(existsSync(f.sandbox.homeDir)).toBe(false);
  });

  it("refuses changed CLI bytes despite a valid source receipt", async () => {
    const f = await fixture();
    await f.installArtifact();
    await writeFile(f.binary, Buffer.from("different executable"));
    await expect(seedIsolatedVellumCli(f.sandbox, f.repoRoot)).rejects.toThrow("bytes do not match");
    expect(existsSync(f.sandbox.homeDir)).toBe(false);
  });

  it.each([false, true])("refuses source drift, committed=%s", async (committed) => {
    const f = await fixture();
    await f.installArtifact();
    await writeFile(join(f.repoRoot, "src", "cli.ts"), "export const version = 2;\n");
    if (committed) f.commit();
    await expect(seedIsolatedVellumCli(f.sandbox, f.repoRoot)).rejects.toThrow("source differs");
    expect(existsSync(f.sandbox.homeDir)).toBe(false);
  });

  it("resolves the copied executable on isolated PATH, preserves seat env, and permits test-only commits", async () => {
    const f = await fixture();
    await f.installArtifact();
    await mkdir(join(f.repoRoot, "tests"));
    await writeFile(join(f.repoRoot, "tests", "new.test.ts"), "// test-only change\n");
    f.git("add", "tests");
    f.commit();
    const seeded = await seedIsolatedVellumCli(f.sandbox, f.repoRoot);
    expect(seeded.sourceCommit).toBe(f.receipt.sourceCommit);
    expect(await readFile(seeded.executable)).toEqual(f.bytes);
    expect(JSON.parse(await readFile(`${seeded.executable}-relink.json`, "utf8"))).toEqual(f.receipt);
    // Rebuilding dist cannot silently replace an already-seeded executable.
    await writeFile(f.binary, "new build");
    expect(await readFile(seeded.executable)).toEqual(f.bytes);
    const cwd = join(f.sandbox.root, "throwaway-cwd");
    await mkdir(cwd);
    const socket = join(f.sandbox.homeDir, ".vellum-command", "work", "control.sock");
    const stdout = execFileSync("/bin/sh", ["-c", "command -v vellum-command && exec vellum-command --help"], {
      cwd, encoding: "utf8", env: {
        HOME: f.sandbox.homeDir, PATH: `${seededHarnessBinDir(f.sandbox)}:/usr/bin:/bin`,
        JUNTO_WORK_SOCKET: socket,
      },
    });
    const lines = stdout.trim().split("\n");
    expect(lines.slice(0, 3)).toEqual([seeded.executable, "fixture executable", f.sandbox.homeDir]);
    // macOS resolves /var to /private/var when the child shell establishes PWD.
    expect(lines[3]?.endsWith("/sandbox/throwaway-cwd")).toBe(true);
    expect(lines.slice(4)).toEqual([socket, "--help"]);
  });
});
