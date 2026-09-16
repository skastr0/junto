/**
 * Demo runtime isolation is a process-owned capability, never a second
 * product home. The database and derivative sidecars live under one
 * OS-temporary directory minted by this process and removed after the
 * StateEngine closes. A process-exit hook is the abnormal-startup backstop.
 *
 * There is deliberately no environment-selected database path here. Demo
 * callers may choose only a sidecar output directory; SQLite authority is
 * always either the canonical product database or this minted ephemeral one.
 */
import { mkdtempDisposableSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDemoMode } from "./mode";

type EphemeralDirectory = ReturnType<typeof mkdtempDisposableSync>;

let demoDirectory: EphemeralDirectory | undefined;
let exitCleanupRegistered = false;

const releaseOnExit = (): void => {
  releaseDemoRuntimeIsolation();
};

const acquireDemoDirectory = (): EphemeralDirectory => {
  if (demoDirectory !== undefined) return demoDirectory;
  demoDirectory = mkdtempDisposableSync(
    join(tmpdir(), "vellum-command-demo-runtime-"),
  );
  process.once("exit", releaseOnExit);
  exitCleanupRegistered = true;
  return demoDirectory;
};

/** Absolute path to this process's ephemeral demo database, if demo is on. */
export const demoStateDatabasePath = (): string | undefined =>
  isDemoMode()
    ? join(acquireDemoDirectory().path, "vellum-command.db")
    : undefined;

/**
 * Release the exact directory capability minted above. Main invokes this only
 * after AppRuntime disposal has closed SQLite; the exit hook covers boot
 * failures before the normal shutdown path is installed.
 */
export const releaseDemoRuntimeIsolation = (): void => {
  if (exitCleanupRegistered) {
    process.off("exit", releaseOnExit);
    exitCleanupRegistered = false;
  }
  const owned = demoDirectory;
  demoDirectory = undefined;
  owned?.remove();
};

// Demo sidecars are outputs, but they must not overwrite the operator's normal
// digest/SVG projections. E2E may supply its own already-minted output root.
if (isDemoMode() && !process.env.JUNTO_CANVASES_DIR) {
  process.env.JUNTO_CANVASES_DIR = join(
    acquireDemoDirectory().path,
    "projections",
  );
}
