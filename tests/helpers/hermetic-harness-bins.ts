/**
 * Hermetic harness binaries for seat-launch tests.
 *
 * `resolveLaunch` resolves a managed seat's harness argv against the seat PATH
 * plus the operator's own install dirs, and fails closed when it cannot — the
 * point being that a dead version-manager shim must never shadow a real binary.
 * Unit tests must not inherit which agent CLIs happen to be installed on the
 * machine running them, so they register a temp dir of stub executables through
 * the same operator-tool-directory escape hatch Settings uses.
 *
 * Usage:
 *   let restoreHarnessBins: () => void;
 *   beforeEach(() => { restoreHarnessBins = installHermeticHarnessBins(); });
 *   afterEach(() => { restoreHarnessBins(); });
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  HARNESS_IDS,
  templateFor,
} from "../../src/shared/managed-terminal-templates";
import { setConfiguredToolDirectories } from "../../src/main/junto/adapters/exec";

/**
 * Install one no-op executable per harness template binary and register the
 * directory as a configured tool directory. Returns a disposer that clears the
 * registration and removes the directory.
 */
export const installHermeticHarnessBins = (): (() => void) => {
  const dir = mkdtempSync(join(tmpdir(), "junto-harness-bins-"));
  for (const harness of HARNESS_IDS) {
    const binary = templateFor(harness).argvSpec.binary;
    if (isAbsolute(binary)) continue;
    const path = join(dir, binary);
    writeFileSync(path, "#!/bin/sh\nexit 0\n", { encoding: "utf8" });
    chmodSync(path, 0o755);
  }
  setConfiguredToolDirectories([dir]);
  return () => {
    setConfiguredToolDirectories([]);
    rmSync(dir, { recursive: true, force: true });
  };
};
