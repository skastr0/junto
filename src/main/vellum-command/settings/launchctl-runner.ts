import {
  APP_PROCESS_KILL_GRACE_MS,
  APP_PROCESS_PLANE_QUIESCING_ERROR,
  APP_PROCESS_TERM_GRACE_MS,
  appProcessPlane,
  type AppProcessClose,
  type AppProcessLease,
  type AppProcessPlane,
} from "../app-process-plane";

export const LAUNCHCTL_PATH = "/bin/launchctl";
export const LAUNCHCTL_DEADLINE_MS = 3_000;
export const LAUNCHCTL_STDOUT_CAP_BYTES = 64 * 1024;
export const LAUNCHCTL_STDERR_CAP_BYTES = 16 * 1024;
export const VELLUM_COMMAND_LAUNCHD_LABEL = "skastr0.vellumcommand";

const VellumLaunchAgentTargetTypeId: unique symbol = Symbol(
  "@vellum-command/VellumLaunchAgentTarget",
);

/** Opaque authority to address only this user's Vellum Command LaunchAgent. */
export interface VellumLaunchAgentTarget {
  readonly [VellumLaunchAgentTargetTypeId]:
    typeof VellumLaunchAgentTargetTypeId;
}

const launchAgentTargets = new WeakMap<VellumLaunchAgentTarget, string>();

type LaunchctlAction = "print" | "kickstart";

export type LaunchctlFailureKind =
  | "invalid-target"
  | "admission-refused"
  | "spawn-failed"
  | "process-error"
  | "stdout-overflow"
  | "stderr-overflow"
  | "deadline"
  | "exit-nonzero"
  | "close-timeout";

export interface LaunchctlFailure {
  readonly kind: LaunchctlFailureKind;
  /** Bounded text for logs only. Never used as lifecycle evidence. */
  readonly diagnostic: string;
}

interface LaunchctlResultBase {
  readonly action: LaunchctlAction;
  readonly target: string;
  readonly stdout: string;
  readonly stderr: string;
}

export type LaunchctlRunResult =
  | (LaunchctlResultBase & {
    readonly clean: true;
    readonly ok: true;
    readonly close: AppProcessClose;
  })
  | (LaunchctlResultBase & {
    readonly clean: true;
    readonly ok: false;
    readonly close?: AppProcessClose;
    readonly failure: LaunchctlFailure;
  })
  | (LaunchctlResultBase & {
    /** A child was admitted but never produced the exact close witness. */
    readonly clean: false;
    readonly ok: false;
    readonly failure: LaunchctlFailure;
  });

export interface LaunchctlRunner {
  readonly printLaunchAgent: (
    target: VellumLaunchAgentTarget,
  ) => Promise<LaunchctlRunResult>;
  readonly kickstartLaunchAgent: (
    target: VellumLaunchAgentTarget,
  ) => Promise<LaunchctlRunResult>;
}

type LaunchctlProcessPlane = Pick<
  AppProcessPlane,
  "spawnChild" | "terminate" | "forceTerminate" | "isQuiescing"
>;

interface LaunchctlRunnerOptions {
  readonly processPlane?: LaunchctlProcessPlane;
  readonly deadlineMs?: number;
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
  readonly stdoutCapBytes?: number;
  readonly stderrCapBytes?: number;
}

const MAX_DIAGNOSTIC_CHARACTERS = 512;
const MAX_LAUNCHD_UID = 0xffff_ffff;
const LAUNCHD_TARGET_PATTERN =
  /^gui\/(0|[1-9]\d{0,9})\/skastr0\.vellumcommand$/;

const boundedPositiveInteger = (
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number => {
  const selected = value ?? fallback;
  if (
    !Number.isSafeInteger(selected) || selected <= 0 || selected > maximum
  ) {
    throw new Error(`${label} must be an integer from 1 through ${maximum}`);
  }
  return selected;
};

const boundedDiagnostic = (value: unknown): string => {
  const error = value instanceof Error ? value : undefined;
  const code = error === undefined
    ? undefined
    : (error as NodeJS.ErrnoException).code;
  const text = error === undefined
    ? String(value)
    : `${error.name}${code === undefined ? "" : ` (${code})`}: ${error.message}`;
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�")
    .slice(0, MAX_DIAGNOSTIC_CHARACTERS);
};

const failure = (
  kind: LaunchctlFailureKind,
  diagnostic: string,
): LaunchctlFailure => Object.freeze({ kind, diagnostic });

const isValidLaunchdTarget = (target: string): boolean => {
  const match = LAUNCHD_TARGET_PATTERN.exec(target);
  if (match === null) return false;
  const uid = Number(match[1]);
  return Number.isSafeInteger(uid) && uid >= 0 && uid <= MAX_LAUNCHD_UID;
};

/**
 * Mint the sole launchd target this process may inspect or kickstart. The
 * WeakMap rejects cast forgeries at runtime; callers never choose a label or
 * another user's launchd domain.
 */
export const launchAgentTargetForCurrentUser = (
): VellumLaunchAgentTarget | undefined => {
  const uid = process.getuid?.();
  if (
    uid === undefined || !Number.isSafeInteger(uid) || uid < 0 ||
    uid > MAX_LAUNCHD_UID
  ) return undefined;
  const target = `gui/${uid}/${VELLUM_COMMAND_LAUNCHD_LABEL}`;
  if (!isValidLaunchdTarget(target)) return undefined;
  const capability: VellumLaunchAgentTarget = {
    [VellumLaunchAgentTargetTypeId]: VellumLaunchAgentTargetTypeId,
  };
  launchAgentTargets.set(capability, target);
  return Object.freeze(capability);
};

const appendDiagnostic = (
  existing: LaunchctlFailure,
  next: string,
): LaunchctlFailure => failure(
  existing.kind,
  `${existing.diagnostic}; ${next}`.slice(0, MAX_DIAGNOSTIC_CHARACTERS),
);

interface OutputAccumulator {
  readonly chunks: Buffer[];
  readonly capBytes: number;
  bytes: number;
  overflowed: boolean;
}

const outputText = (output: OutputAccumulator): string =>
  Buffer.concat(output.chunks, output.bytes).toString("utf8");

const appendOutput = (
  output: OutputAccumulator,
  chunk: string | Buffer,
): boolean => {
  if (output.overflowed) return false;
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = output.capBytes - output.bytes;
  if (remaining > 0) {
    const accepted = buffer.length <= remaining
      ? buffer
      : Buffer.from(buffer.subarray(0, remaining));
    output.chunks.push(accepted);
    output.bytes += accepted.length;
  }
  if (buffer.length <= remaining) return false;
  output.overflowed = true;
  return true;
};

const successfulClose = (event: AppProcessClose): boolean =>
  event.code === 0 && event.signal === null;

export const createLaunchctlRunner = (
  options: LaunchctlRunnerOptions = {},
): LaunchctlRunner => {
  const processPlane = options.processPlane ?? appProcessPlane;
  const deadlineMs = boundedPositiveInteger(
    options.deadlineMs,
    LAUNCHCTL_DEADLINE_MS,
    LAUNCHCTL_DEADLINE_MS,
    "launchctl deadline",
  );
  const termGraceMs = boundedPositiveInteger(
    options.termGraceMs,
    APP_PROCESS_TERM_GRACE_MS,
    APP_PROCESS_TERM_GRACE_MS,
    "launchctl TERM grace",
  );
  const killGraceMs = boundedPositiveInteger(
    options.killGraceMs,
    APP_PROCESS_KILL_GRACE_MS,
    APP_PROCESS_KILL_GRACE_MS,
    "launchctl KILL grace",
  );
  const stdoutCapBytes = boundedPositiveInteger(
    options.stdoutCapBytes,
    LAUNCHCTL_STDOUT_CAP_BYTES,
    LAUNCHCTL_STDOUT_CAP_BYTES,
    "launchctl stdout cap",
  );
  const stderrCapBytes = boundedPositiveInteger(
    options.stderrCapBytes,
    LAUNCHCTL_STDERR_CAP_BYTES,
    LAUNCHCTL_STDERR_CAP_BYTES,
    "launchctl stderr cap",
  );

  const run = async (
    action: LaunchctlAction,
    targetCapability: VellumLaunchAgentTarget,
  ): Promise<LaunchctlRunResult> => {
    const target = launchAgentTargets.get(targetCapability);
    const emptyBase: LaunchctlResultBase = {
      action,
      target: target ?? "<unadmitted>",
      stdout: "",
      stderr: "",
    };
    if (target === undefined || !isValidLaunchdTarget(target)) {
      return Object.freeze({
        ...emptyBase,
        clean: true,
        ok: false,
        failure: failure(
          "invalid-target",
          "missing Vellum Command launch-agent target authority",
        ),
      });
    }
    if (processPlane.isQuiescing()) {
      return Object.freeze({
        ...emptyBase,
        clean: true,
        ok: false,
        failure: failure(
          "admission-refused",
          APP_PROCESS_PLANE_QUIESCING_ERROR,
        ),
      });
    }

    let lease: AppProcessLease;
    try {
      lease = processPlane.spawnChild({
        source: "settings.launchctl-runner",
        purpose: `${action} launch agent`,
        command: LAUNCHCTL_PATH,
        args: [action, target],
        shell: false,
      });
    } catch (error) {
      const quiescing = processPlane.isQuiescing();
      if (quiescing) {
        return Object.freeze({
          ...emptyBase,
          clean: true,
          ok: false,
          failure: failure(
            "admission-refused",
            boundedDiagnostic(error),
          ),
        });
      }
      return Object.freeze({
        ...emptyBase,
        clean: false,
        ok: false,
        failure: failure("spawn-failed", boundedDiagnostic(error)),
      });
    }

    return new Promise<LaunchctlRunResult>((resolve) => {
      const stdout: OutputAccumulator = {
        chunks: [],
        capBytes: stdoutCapBytes,
        bytes: 0,
        overflowed: false,
      };
      const stderr: OutputAccumulator = {
        chunks: [],
        capBytes: stderrCapBytes,
        bytes: 0,
        overflowed: false,
      };
      let activeFailure: LaunchctlFailure | undefined;
      let settled = false;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let phaseTimer: ReturnType<typeof setTimeout> | undefined;
      let removeClose = (): void => undefined;
      let removeProcessError = (): void => undefined;

      const streamErrorSink = (): void => undefined;

      const clearTimers = (): void => {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        if (phaseTimer !== undefined) clearTimeout(phaseTimer);
        deadlineTimer = undefined;
        phaseTimer = undefined;
      };

      const base = (): LaunchctlResultBase => ({
        action,
        target,
        stdout: outputText(stdout),
        stderr: outputText(stderr),
      });

      const stopObserving = (retainStreamSinks: boolean): void => {
        removeClose();
        removeProcessError();
        lease.io.stdout.off("data", onStdout);
        lease.io.stderr.off("data", onStderr);
        lease.io.stdout.off("error", onStdoutError);
        lease.io.stderr.off("error", onStderrError);
        lease.io.stdin.off("error", onStdinError);
        if (retainStreamSinks) {
          lease.io.stdout.on("error", streamErrorSink);
          lease.io.stderr.on("error", streamErrorSink);
          lease.io.stdin.on("error", streamErrorSink);
          lease.io.stdout.resume();
          lease.io.stderr.resume();
        }
      };

      const settleUnclean = (): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        stopObserving(true);
        const trigger = activeFailure?.kind ?? "deadline";
        const triggerDiagnostic = activeFailure?.diagnostic;
        resolve(Object.freeze({
          ...base(),
          clean: false,
          ok: false,
          failure: failure(
            "close-timeout",
            [
              `launchctl emitted no close witness after ${trigger} teardown`,
              triggerDiagnostic,
            ].filter((part): part is string => part !== undefined).join(": ")
              .slice(0, MAX_DIAGNOSTIC_CHARACTERS),
          ),
        }));
      };

      const settleClose = (close: AppProcessClose): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        stopObserving(false);
        // Resolve after the current signal call returns. A hostile/injected
        // signal sink can synchronously emit close and then throw; the close is
        // authoritative, while that bounded diagnostic still belongs in the
        // result.
        queueMicrotask(() => {
          if (activeFailure !== undefined) {
            resolve(Object.freeze({
              ...base(),
              clean: true,
              ok: false,
              close,
              failure: activeFailure,
            }));
            return;
          }
          if (successfulClose(close)) {
            resolve(Object.freeze({
              ...base(),
              clean: true,
              ok: true,
              close,
            }));
            return;
          }
          resolve(Object.freeze({
            ...base(),
            clean: true,
            ok: false,
            close,
            failure: failure(
              "exit-nonzero",
              `launchctl closed with code ${String(close.code)} and signal ${String(close.signal)}`,
            ),
          }));
        });
      };

      const scheduleForce = (): void => {
        if (settled) return;
        phaseTimer = setTimeout(() => {
          phaseTimer = undefined;
          if (settled) return;
          try {
            processPlane.forceTerminate(
              lease,
              `launchctl ${action} bounded teardown escalation`,
            );
          } catch (error) {
            if (activeFailure !== undefined) {
              activeFailure = appendDiagnostic(
                activeFailure,
                `KILL request failed: ${boundedDiagnostic(error)}`,
              );
            }
          }
          if (settled) return;
          phaseTimer = setTimeout(settleUnclean, killGraceMs);
        }, termGraceMs);
      };

      const beginTeardown = (nextFailure: LaunchctlFailure): void => {
        if (settled || activeFailure !== undefined) return;
        activeFailure = nextFailure;
        if (deadlineTimer !== undefined) {
          clearTimeout(deadlineTimer);
          deadlineTimer = undefined;
        }
        try {
          processPlane.terminate(
            lease,
            `launchctl ${action} bounded teardown`,
          );
        } catch (error) {
          activeFailure = appendDiagnostic(
            activeFailure,
            `TERM request failed: ${boundedDiagnostic(error)}`,
          );
        }
        scheduleForce();
      };

      function onStdout(chunk: string | Buffer): void {
        if (appendOutput(stdout, chunk)) {
          beginTeardown(failure(
            "stdout-overflow",
            `launchctl stdout exceeded ${stdoutCapBytes} bytes`,
          ));
        }
      }

      function onStderr(chunk: string | Buffer): void {
        if (appendOutput(stderr, chunk)) {
          beginTeardown(failure(
            "stderr-overflow",
            `launchctl stderr exceeded ${stderrCapBytes} bytes`,
          ));
        }
      }

      function onStdoutError(error: Error): void {
        beginTeardown(failure(
          "process-error",
          `launchctl stdout error: ${boundedDiagnostic(error)}`,
        ));
      }

      function onStderrError(error: Error): void {
        beginTeardown(failure(
          "process-error",
          `launchctl stderr error: ${boundedDiagnostic(error)}`,
        ));
      }

      function onStdinError(error: Error): void {
        beginTeardown(failure(
          "process-error",
          `launchctl stdin error: ${boundedDiagnostic(error)}`,
        ));
      }

      lease.io.stdout.on("data", onStdout);
      lease.io.stderr.on("data", onStderr);
      lease.io.stdout.on("error", onStdoutError);
      lease.io.stderr.on("error", onStderrError);
      lease.io.stdin.on("error", onStdinError);

      const closeSubscription = lease.io.onClose(settleClose);
      if (settled) closeSubscription();
      else removeClose = closeSubscription;

      if (settled) return;
      const errorSubscription = lease.io.onError((error) => {
        // Process errors are diagnostics, never terminal witnesses. Teardown
        // still waits for the exact close event owned by appProcessPlane.
        beginTeardown(failure("process-error", boundedDiagnostic(error)));
      });
      if (settled) errorSubscription();
      else removeProcessError = errorSubscription;

      if (settled) return;
      deadlineTimer = setTimeout(() => {
        deadlineTimer = undefined;
        beginTeardown(failure(
          "deadline",
          `launchctl exceeded ${deadlineMs}ms deadline`,
        ));
      }, deadlineMs);
    });
  };

  return Object.freeze({
    printLaunchAgent: (target: VellumLaunchAgentTarget) =>
      run("print", target),
    kickstartLaunchAgent: (target: VellumLaunchAgentTarget) =>
      run("kickstart", target),
  });
};

const launchctlRunner = createLaunchctlRunner();

export const printLaunchAgent = (
  target: VellumLaunchAgentTarget,
): Promise<LaunchctlRunResult> => launchctlRunner.printLaunchAgent(target);

export const kickstartLaunchAgent = (
  target: VellumLaunchAgentTarget,
): Promise<LaunchctlRunResult> => launchctlRunner.kickstartLaunchAgent(target);
