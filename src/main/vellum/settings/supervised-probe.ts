import type { SupervisedInstallState } from "@shared/station";
import {
  APP_PROCESS_KILL_GRACE_MS,
  APP_PROCESS_TERM_GRACE_MS,
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
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      unsubscribeError();
      unsubscribeClose();
      resolve(state);
    };

    const schedule = (delayMs: number, action: () => void): void => {
      if (settled) return;
      timer = setTimeout(() => {
        timer = undefined;
        action();
      }, delayMs);
    };

    // execFile consumed both pipes even though this probe ignores their
    // contents. Keep that behavior so launchctl cannot block on a full pipe.
    lease.io.stdout.resume();
    lease.io.stderr.resume();

    const removeErrorListener = lease.io.onError((error) => {
      // Match execFile's error path: destroy its output pipes and classify the
      // diagnostic immediately. Error is not a terminal witness, so request
      // TERM for this exact lease before returning; the central plane retains
      // it, including any refusal receipt, until its terminal close witness.
      lease.io.stdout.destroy();
      lease.io.stderr.destroy();
      try {
        appProcessPlane.terminate(lease, "supervised probe process error");
      } catch {
        // The original probe result is still determined by the process error.
        // Central admission remains strongly registered for global quit drain.
      }
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
    schedule(SUPERVISED_PROBE_TIMEOUT_MS, () => {
      timedOut = true;
      lease.io.stdout.destroy();
      lease.io.stderr.destroy();
      try {
        appProcessPlane.terminate(lease, "supervised probe timeout");
      } catch {
        // Continue to the bounded force phase. The central registry remains
        // the authority for any still-live process.
      }
      schedule(APP_PROCESS_TERM_GRACE_MS, () => {
        try {
          appProcessPlane.forceTerminate(
            lease,
            "supervised probe timeout escalation",
          );
        } catch {
          // The late-close window still bounds the caller-facing probe.
        }
        schedule(APP_PROCESS_KILL_GRACE_MS, () => settle("unknown"));
      });
    });
  });
};
