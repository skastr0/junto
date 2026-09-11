import { chmod, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  templateFor,
  type HarnessId,
} from "../../src/shared/managed-terminal-templates";
import type { Sandbox } from "./sandbox";

export type ClaudeModelCacheEntry = {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
};

export const seededHarnessBinDir = (sandbox: Sandbox): string =>
  join(sandbox.homeDir, ".local", "bin");

/**
 * Plant no-op harness CLIs the install probe and command-based enumerators
 * can resolve. Hermes stays owned by e2e/fakes/bin.
 */
export const seedInstalledHarnesses = async (
  sandbox: Sandbox,
  harnesses: readonly HarnessId[],
): Promise<void> => {
  const binDir = seededHarnessBinDir(sandbox);
  await mkdir(binDir, { recursive: true });
  for (const harness of harnesses) {
    if (harness === "hermes") continue;
    const binary = templateFor(harness).argvSpec.binary;
    if (isAbsolute(binary)) {
      throw new Error(`Cannot seed an absolute harness binary: ${binary}`);
    }
    const path = join(binDir, binary);
    await writeFile(path, "#!/bin/sh\nexit 0\n", { encoding: "utf8" });
    await chmod(path, 0o755);
    if (harness === "kimi") {
      const kimiDir = join(sandbox.homeDir, ".kimi-code", "bin");
      await mkdir(kimiDir, { recursive: true });
      const kimiPath = join(kimiDir, binary);
      await writeFile(kimiPath, "#!/bin/sh\nexit 0\n", { encoding: "utf8" });
      await chmod(kimiPath, 0o755);
    }
  }
};

export const seedClaudeModelCache = async (
  sandbox: Sandbox,
  models: readonly ClaudeModelCacheEntry[],
): Promise<void> => {
  await writeFile(
    join(sandbox.homeDir, ".claude.json"),
    `${JSON.stringify({ additionalModelOptionsCache: models }, null, 2)}\n`,
    { encoding: "utf8" },
  );
};
