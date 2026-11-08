/**
 * The windowless core bundles as a machine build bundles it
 * (scripts/build-machine.ts, bundleMachineCore), and the bundle reaches no
 * Electron: a remote machine has none, and the build refuses one that does.
 * The machine's bin/junto is the native CLI as the build compiles it
 * (compileMachineCli), and it refuses the browser CLI: the browser is local
 * to the desktop app.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("the machine core bundle", () => {
  it("bundles without Electron", () => {
    const out = mkdtempSync(join(tmpdir(), "junto-core-bundle-"));
    try {
      const script = [
        `import { bundleMachineCore } from ${JSON.stringify(join(repoRoot, "scripts/build-machine.ts"))};`,
        `import { resolveBuildFeatures } from ${JSON.stringify(join(repoRoot, "scripts/build-features.ts"))};`,
        `await bundleMachineCore(${JSON.stringify(out)}, { build: "test", version: "0.0.0", features: resolveBuildFeatures(process.env) });`,
      ].join("\n");
      const result = spawnSync("bun", ["-e", script], { cwd: repoRoot, encoding: "utf8", timeout: 120_000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);

  const hostTarget = `${process.platform}-${process.arch}`;
  it.runIf(hostTarget === "darwin-arm64" || hostTarget === "linux-x64")("compiles bin/junto without the browser CLI", () => {
    const out = mkdtempSync(join(tmpdir(), "junto-machine-cli-"));
    try {
      const script = [
        `import { compileMachineCli } from ${JSON.stringify(join(repoRoot, "scripts/build-machine.ts"))};`,
        `import { resolveBuildFeatures } from ${JSON.stringify(join(repoRoot, "scripts/build-features.ts"))};`,
        `compileMachineCli(${JSON.stringify(join(out, "junto"))}, { target: ${JSON.stringify(hostTarget)}, version: "0.0.0", features: resolveBuildFeatures(process.env) });`,
      ].join("\n");
      const machine = spawnSync("bun", ["-e", script], { cwd: repoRoot, encoding: "utf8", timeout: 600_000 });
      expect(machine.error).toBeUndefined();
      expect(machine.status, machine.stderr).toBe(0);
      const cli = join(out, "junto");
      expect(spawnSync(cli, ["--version"], { encoding: "utf8" }).stdout).toBe("junto v0.0.0\n");
      const browser = spawnSync(cli, ["browser", "doctor"], { encoding: "utf8" });
      expect(browser.status).toBe(2);
      expect(browser.stderr).toContain("the browser runs in the desktop app, not on a Junto Remote machine");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 600_000);
});
