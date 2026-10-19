/**
 * The operator's shell environment, one module for the whole product.
 *
 * Every spawn path awaits `ensure()` (through adapters/exec.ts
 * resolvedSpawnEnv), and app start resolves it before any seat: the window
 * in index.ts, the windowless core on a linked machine or a Boat sandbox in
 * term/core-seats.ts. Each Junto reads its own machine's shell. A change the
 * operator makes to their rc files reaches seats through `refresh()`; nothing
 * polls.
 */
import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveJuntoHome } from "@shared/junto-home";
import { runTool } from "../region-env/tool";
import { makeShellEnvironment } from "./environment";
import { operatorShell, SHELL_ENVIRONMENT_SWITCH_KEY } from "./probe";

export { makeShellEnvironment, diffVariableNames, type ShellEnvironment, type ShellEnvironmentState } from "./environment";
export { mergePath, pathDirs, staticPathDirs } from "./path";
export {
  operatorShell,
  probeShellEnvironment,
  shellEnvironmentFromProbeOutput,
  SHELL_ENVIRONMENT_RESOLVING_KEY,
  SHELL_ENVIRONMENT_SWITCH_KEY,
  SHELL_ENVIRONMENT_TIMEOUT_MS,
} from "./probe";

/** Product state, never the operator home: the probe's rc files start here. */
const appOwnedCwd = async (): Promise<string> => {
  const dir = join(resolveJuntoHome(), ".junto");
  try {
    await mkdir(dir, { recursive: true });
    return dir;
  } catch {
    return tmpdir();
  }
};

export const shellEnvironment = makeShellEnvironment({
  runTool,
  target: process.env,
  home: homedir,
  now: Date.now,
  shell: operatorShell,
  turnedOff: (launched) => launched[SHELL_ENVIRONMENT_SWITCH_KEY] === "inherit",
  cwd: appOwnedCwd,
  log: (line) => console.log(line),
  warn: (line) => console.warn(line),
});
