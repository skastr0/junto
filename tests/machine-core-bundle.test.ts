/**
 * The windowless core bundles as a machine build bundles it
 * (scripts/build-machine.ts, bundleMachineCore), and the bundle reaches no
 * Electron: a remote machine has none, and the build refuses one that does.
 * The machine's bin/junto compiles as the build compiles it
 * (compileMachineCli) and carries no browser CLI: the browser is local to the
 * desktop app.
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
    // A string only the browser CLI's control client carries.
    const browserCli = "control token unavailable";
    try {
      const script = [
        `import { compileMachineCli } from ${JSON.stringify(join(repoRoot, "scripts/build-machine.ts"))};`,
        `import { resolveBuildFeatures } from ${JSON.stringify(join(repoRoot, "scripts/build-features.ts"))};`,
        `compileMachineCli(${JSON.stringify(join(out, "junto"))}, { target: ${JSON.stringify(hostTarget)}, build: "test", version: "0.0.0", features: resolveBuildFeatures(process.env) });`,
      ].join("\n");
      const machine = spawnSync("bun", ["-e", script], { cwd: repoRoot, encoding: "utf8", timeout: 180_000 });
      expect(machine.error).toBeUndefined();
      expect(machine.status, machine.stderr).toBe(0);
      const binary = readFileSync(join(out, "junto"));
      // The binary keeps its source as text: a CLI string every build carries is there.
      expect(binary.includes("Show a short-lived thought bubble above this agent node.")).toBe(true);
      expect(binary.includes(browserCli)).toBe(false);

      // Without the machine define the same entry carries it, so the check is not vacuous.
      const desktop = spawnSync("bun", ["build", "--target=bun", "--outdir", join(out, "desktop"), join(repoRoot, "src/cli/main.ts")], { cwd: repoRoot, encoding: "utf8", timeout: 180_000 });
      expect(desktop.status, desktop.stderr).toBe(0);
      const chunks = readdirSync(join(out, "desktop"), { recursive: true, encoding: "utf8" })
        .filter((name) => name.endsWith(".js"))
        .map((name) => readFileSync(join(out, "desktop", name), "utf8"));
      expect(chunks.some((chunk) => chunk.includes(browserCli))).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 240_000);
});
