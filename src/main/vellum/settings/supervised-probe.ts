import type { SupervisedInstallState } from "@shared/station";
import {
  appProcessPlane,
  type AppProcessClose,
  type AppProcessLease,
} from "../app-process-plane";

/** Matches scripts/app-paths.sh LABEL / main ensureSupervised LAUNCHD_LABEL. */
export const VELLUM_LAUNCHD_LABEL = "skastr0.vellum";

export type SupervisedProbe = () => Promise<SupervisedInstallState>;

const SUPERVISED_PROBE_TIMEOUT_MS = 3_000;

const classifyProbeError = (error: Error): SupervisedInstallState => {
  const err = error as NodeJS.ErrnoException & {
    readonly killed?: boolean;
    readonly signal?: NodeJS.Signals | null;
  };
  return err.killed || err.signal === "SIGTERM" || err.code === "ENOENT"
    ? "unknown"
    : "absent";
};

const classifyProbeClose = (
  event: AppProcessClose,
  timedOut: boolean,
): SupervisedInstallState => {
  if (event.code === 0 && event.signal === null) return "installed";
  if (timedOut || event.signal === "SIGTERM") return "unknown";
  return "absent";
};

/**
 * Probe whether the Vellum LaunchAgent is loaded for this user (gui/$uid).
 * Darwin-only; non-macOS reports "absent". Fail-closed to "unknown" only when
 * the probe itself cannot run (no getuid / launchctl missing / killed).
 */
export const probeLaunchAgentLoaded: SupervisedProbe = () => {
  if (process.platform !== "darwin") return Promise.resolve("absent");
  const uid = process.getuid?.();
  if (uid === undefined) return Promise.resolve("unknown");

  let lease: AppProcessLease;
  try {
    lease = appProcessPlane.spawnChild({
      source: "settings.supervised-probe",
      purpose: "probe supervised launch agent",
      command: "/bin/launchctl",
      args: ["print", `gui/${uid}/${VELLUM_LAUNCHD_LABEL}`],
    });
  } catch {
    // Admission closes synchronously during app shutdown. A probe that cannot
    // start has the same fail-closed result as a missing launchctl binary.
    return Promise.resolve("unknown");
  }

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribeError = (): void => undefined;
    let unsubscribeClose = (): void => undefined;

    const settle = (state: SupervisedInstallState): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribeError();
      unsubscribeClose();
      resolve(state);
    };

    // execFile consumed both pipes even though this probe ignores their
    // contents. Keep that behavior so launchctl cannot block on a full pipe.
    lease.io.stdout.resume();
    lease.io.stderr.resume();

    const removeErrorListener = lease.io.onError((error) => {
      // Match execFile's error path: destroy its output pipes and classify the
      // spawn failure immediately. The central plane still retains the child
      // until its terminal close witness.
      lease.io.stdout.destroy();
      lease.io.stderr.destroy();
      settle(classifyProbeError(error));
    });
    if (settled) removeErrorListener();
    else unsubscribeError = removeErrorListener;

    if (settled) return;
    const removeCloseListener = lease.io.onClose((event) => {
      settle(classifyProbeClose(event, timedOut));
    });
    if (settled) removeCloseListener();
    else unsubscribeClose = removeCloseListener;

    if (settled) return;
    timer = setTimeout(() => {
      timedOut = true;
      lease.io.stdout.destroy();
      lease.io.stderr.destroy();
      try {
        appProcessPlane.terminate(lease, "supervised probe timeout");
      } catch (error) {
        // execFile completed immediately when its kill callback threw.
        settle(classifyProbeError(error as Error));
      }
    }, SUPERVISED_PROBE_TIMEOUT_MS);
  });
};
