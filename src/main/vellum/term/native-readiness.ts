import type { ServiceCheck } from "@shared/contracts";
import {
  appProcessPlane,
  type AppProcessPlane,
  type AppTerminalExit,
  type AppTerminalLease,
} from "../app-process-plane";
import { validateExecutableShell } from "./shell-policy";

export type NativeTerminalProbeAuthority = Pick<
  AppProcessPlane,
  "spawnTerminal" | "terminate" | "forceTerminate"
>;

export type NativeTerminalReadiness =
  | {
      readonly ready: true;
      readonly backend: "pty";
      readonly exitCode: 0;
    }
  | {
      readonly ready: false;
      readonly code:
        | "native_spawn_failed"
        | "native_backend_error"
        | "native_probe_timeout"
        | "native_probe_exit";
      readonly detail: string;
    };

export interface NativeTerminalReadinessOptions {
  /** Tests may lower, never raise, the product probe deadline. */
  readonly timeoutMs?: number;
  /** Tests may lower, never raise, each opaque-lease cleanup phase. */
  readonly cleanupGraceMs?: number;
}

const PROBE_TIMEOUT_MS = 1_500;
const PROBE_CLEANUP_GRACE_MS = 400;

const boundedDuration = (
  candidate: number | undefined,
  ceiling: number,
  label: string,
): number => {
  if (candidate === undefined) return ceiling;
  if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > ceiling) {
    throw new RangeError(`${label} must be a bounded positive integer`);
  }
  return candidate;
};

const settleExitBefore = async (
  exit: Promise<AppTerminalExit>,
  timeoutMs: number,
): Promise<AppTerminalExit | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exit,
      new Promise<undefined>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const boundedMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 240);

const stopTimedOutProbe = async (
  authority: NativeTerminalProbeAuthority,
  lease: AppTerminalLease,
  cleanupGraceMs: number,
): Promise<void> => {
  authority.terminate(lease, "native-terminal-readiness-timeout");
  if (await settleExitBefore(lease.io.exited, cleanupGraceMs)) return;
  authority.forceTerminate(lease, "native-terminal-readiness-timeout");
  await settleExitBefore(lease.io.exited, cleanupGraceMs);
};

/**
 * Proves that the exact runtime can load node-pty and spawn one native PTY.
 * The receipt deliberately contains no PID, lease, signal sink, or other
 * process authority.
 */
export const probeNativeTerminalReadiness = async (
  authority: NativeTerminalProbeAuthority = appProcessPlane,
  options: NativeTerminalReadinessOptions = {},
): Promise<NativeTerminalReadiness> => {
  const timeoutMs = boundedDuration(
    options.timeoutMs,
    PROBE_TIMEOUT_MS,
    "native terminal probe timeout",
  );
  const cleanupGraceMs = boundedDuration(
    options.cleanupGraceMs,
    PROBE_CLEANUP_GRACE_MS,
    "native terminal cleanup grace",
  );
  let lease: AppTerminalLease;
  try {
    const shell = validateExecutableShell("/bin/sh");
    lease = authority.spawnTerminal({
      source: "doctor:native-terminal",
      purpose: "prove native PTY load and spawn",
      command: shell,
      args: ["-c", "exit 0"],
      cwd: "/",
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
      cols: 80,
      rows: 24,
    });
  } catch (error) {
    return {
      ready: false,
      code: "native_spawn_failed",
      detail: boundedMessage(error),
    };
  }

  const backendErrors: Error[] = [];
  let removeErrorListener = (): void => undefined;
  try {
    removeErrorListener = lease.io.onError((error) => backendErrors.push(error));
    const exited = await settleExitBefore(lease.io.exited, timeoutMs);
    if (exited === undefined) {
      await stopTimedOutProbe(authority, lease, cleanupGraceMs);
      return {
        ready: false,
        code: "native_probe_timeout",
        detail: "native PTY probe did not exit inside its bounded deadline",
      };
    }
    if (backendErrors.length > 0) {
      return {
        ready: false,
        code: "native_backend_error",
        detail: boundedMessage(backendErrors[0]),
      };
    }
    // node-pty reports signal=0 for an ordinary exit on Unix. Only a nonzero
    // signal is termination evidence.
    if (exited.code !== 0 || (exited.signal !== undefined && exited.signal !== 0)) {
      return {
        ready: false,
        code: "native_probe_exit",
        detail: `native PTY probe exited code=${String(exited.code)} signal=${String(exited.signal)}`,
      };
    }
    return { ready: true, backend: "pty", exitCode: 0 };
  } catch (error) {
    await stopTimedOutProbe(authority, lease, cleanupGraceMs);
    return {
      ready: false,
      code: "native_backend_error",
      detail: boundedMessage(error),
    };
  } finally {
    removeErrorListener();
  }
};

export const assessNativeTerminalDoctor = (input: {
  readonly probe: NativeTerminalReadiness;
  readonly controlReady: boolean;
  readonly running: number;
}): ServiceCheck => {
  if (!input.probe.ready) {
    return {
      id: "terminal",
      label: "Native terminal",
      status: "error",
      detail: `native PTY load/spawn failed (${input.probe.code}): ${input.probe.detail}`,
    };
  }
  if (!input.controlReady) {
    return {
      id: "terminal",
      label: "Native terminal",
      status: "warning",
      detail: `native PTY load/spawn passed (${input.running} running) but control socket is missing — remote attach unavailable until term plane starts`,
    };
  }
  return {
    id: "terminal",
    label: "Native terminal",
    status: "ok",
    detail: `native PTY load/spawn + control UDS ready (${input.running} running)`,
  };
};
