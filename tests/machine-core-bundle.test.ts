/**
 * The windowless core bundles as a machine build bundles it
 * (scripts/build-machine.ts, bundleMachineCore), and the bundle reaches no
 * Electron: a remote machine has none, and the build refuses one that does.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
});
