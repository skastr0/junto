import { execFile } from "node:child_process";
import type { SupervisedInstallState } from "@shared/station";

/** Matches scripts/app-paths.sh LABEL / main ensureSupervised LAUNCHD_LABEL. */
export const VELLUM_LAUNCHD_LABEL = "skastr0.vellum";

export type SupervisedProbe = () => Promise<SupervisedInstallState>;

/**
 * Probe whether the Vellum LaunchAgent is loaded for this user (gui/$uid).
 * Darwin-only; non-macOS reports "absent". Fail-closed to "unknown" only when
 * the probe itself cannot run (no getuid / launchctl missing / killed).
 */
export const probeLaunchAgentLoaded: SupervisedProbe = () =>
  new Promise((resolve) => {
    if (process.platform !== "darwin") {
      resolve("absent");
      return;
    }
    const uid = process.getuid?.();
    if (uid === undefined) {
      resolve("unknown");
      return;
    }
    execFile(
      "/bin/launchctl",
      ["print", `gui/${uid}/${VELLUM_LAUNCHD_LABEL}`],
      { timeout: 3_000 },
      (error) => {
        if (!error) {
          resolve("installed");
          return;
        }
        // Timeout / signal → unknown; normal "job not found" exit → absent.
        const err = error as NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: NodeJS.Signals | null;
          code?: string | number | null;
        };
        if (err.killed || err.signal === "SIGTERM" || err.code === "ENOENT") {
          resolve("unknown");
          return;
        }
        resolve("absent");
      },
    );
  });
