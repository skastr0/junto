import {
  APP_PROCESS_KILL_GRACE_MS,
  APP_PROCESS_PLANE_QUIESCING_ERROR,
  APP_PROCESS_TERM_GRACE_MS,
  appProcessPlane,
  type AppProcessClose,
  type AppProcessLease,
  type AppProcessPlane,
} from "../app-process-plane";

export const SYSTEMCTL_PATH = "/usr/bin/systemctl";
export const SYSTEMCTL_DEADLINE_MS = 3_000;
export const SYSTEMCTL_STDOUT_CAP_BYTES = 16 * 1024;
export const SYSTEMCTL_STDERR_CAP_BYTES = 16 * 1024;
/** The systemd provider owns one fixed Vellum user-service name. */
export const VELLUM_SYSTEMD_USER_UNIT = "vellum-remote.service";

const VellumSystemdUserUnitTargetTypeId: unique symbol = Symbol(
  "@vellum/VellumSystemdUserUnitTarget",
);

/** Opaque authority to address only Vellum's fixed systemd user unit. */
export interface VellumSystemdUserUnitTarget {
  readonly [VellumSystemdUserUnitTargetTypeId]:
    typeof VellumSystemdUserUnitTargetTypeId;
}

const systemdUserUnitTargets = new WeakMap<
  VellumSystemdUserUnitTarget,
  typeof VELLUM_SYSTEMD_USER_UNIT
>();

type SystemctlAction = "show" | "start";

export type SystemctlFailureKind =
  | "invalid-target"
  | "admission-refused"
  | "spawn-failed"
  | "process-error"
  | "stdout-overflow"
  | "stderr-overflow"
  | "deadline"
  | "exit-nonzero"
  | "close-timeout";

export interface SystemctlFailure {
  readonly kind: SystemctlFailureKind;
  /** Bounded text for logs only. Never used as lifecycle evidence. */
  readonly diagnostic: string;
}

interface SystemctlResultBase {
  readonly action: SystemctlAction;
  readonly unit: string;
  readonly stdout: string;
  readonly stderr: string;
}

export type SystemctlRunResult =
  | (SystemctlResultBase & {
    readonly clean: true;
    readonly ok: true;
    readonly close: AppProcessClose;
  })
  | (SystemctlResultBase & {
    readonly clean: true;
    readonly ok: false;
    readonly close?: AppProcessClose;
    readonly failure: SystemctlFailure;
  })
  | (SystemctlResultBase & {
    readonly clean: false;
    readonly ok: false;
    readonly failure: SystemctlFailure;
  });

export interface SystemctlRunner {
  readonly showVellumUnit: (
    target: VellumSystemdUserUnitTarget,
  ) => Promise<SystemctlRunResult>;
  readonly startVellumUnit: (
    target: VellumSystemdUserUnitTarget,
  ) => Promise<SystemctlRunResult>;
}

type SystemctlProcessPlane = Pick<
  AppProcessPlane,
  "spawnChild" | "terminate" | "forceTerminate" | "isQuiescing"
>;

interface SystemctlRunnerOptions {
  readonly processPlane?: SystemctlProcessPlane;
  readonly deadlineMs?: number;
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
  readonly stdoutCapBytes?: number;
  readonly stderrCapBytes?: number;
}

const MAX_DIAGNOSTIC_CHARACTERS = 512;

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
  kind: SystemctlFailureKind,
  diagnostic: string,
): SystemctlFailure => Object.freeze({ kind, diagnostic });

const appendDiagnostic = (
  existing: SystemctlFailure,
  next: string,
): SystemctlFailure => failure(
  existing.kind,
  `${existing.diagnostic}; ${next}`.slice(0, MAX_DIAGNOSTIC_CHARACTERS),
);

export const systemdUserUnitTarget = (): VellumSystemdUserUnitTarget => {
  const target: VellumSystemdUserUnitTarget = {
    [VellumSystemdUserUnitTargetTypeId]: VellumSystemdUserUnitTargetTypeId,
  };
  systemdUserUnitTargets.set(target, VELLUM_SYSTEMD_USER_UNIT);
  return Object.freeze(target);
};

const systemctlEnvironment = (): Readonly<NodeJS.ProcessEnv> => {
  const environment: NodeJS.ProcessEnv = {
    LANG: "C",
    LC_ALL: "C",
    SYSTEMD_COLORS: "0",
    SYSTEMD_PAGER: "",
    SYSTEMD_LESS: "",
  };
  for (
    const key of [
      "HOME",
      "USER",
      "LOGNAME",
      "XDG_RUNTIME_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
    ] as const
  ) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return Object.freeze(environment);
};

const actionArgs = (
  action: SystemctlAction,
  unit: typeof VELLUM_SYSTEMD_USER_UNIT,
): readonly string[] => action === "show"
  ? [
    "--user",
    "--no-pager",
    "--no-ask-password",
    "--property=LoadState",
    "--property=ActiveState",
    "--property=SubState",
    "--property=MainPID",
    "show",
    unit,
  ]
  : ["--user", "--no-pager", "--no-ask-password", "start", unit];

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

export const createSystemctlRunner = (
  options: SystemctlRunnerOptions = {},
): SystemctlRunner => {
  const processPlane = options.processPlane ?? appProcessPlane;
  const deadlineMs = boundedPositiveInteger(
    options.deadlineMs,
    SYSTEMCTL_DEADLINE_MS,
    SYSTEMCTL_DEADLINE_MS,
    "systemctl deadline",
  );
  const termGraceMs = boundedPositiveInteger(
    options.termGraceMs,
    APP_PROCESS_TERM_GRACE_MS,
    APP_PROCESS_TERM_GRACE_MS,
    "systemctl TERM grace",
  );
  const killGraceMs = boundedPositiveInteger(
    options.killGraceMs,
    APP_PROCESS_KILL_GRACE_MS,
    APP_PROCESS_KILL_GRACE_MS,
    "systemctl KILL grace",
  );
  const stdoutCapBytes = boundedPositiveInteger(
    options.stdoutCapBytes,
    SYSTEMCTL_STDOUT_CAP_BYTES,
    SYSTEMCTL_STDOUT_CAP_BYTES,
    "systemctl stdout cap",
  );
  const stderrCapBytes = boundedPositiveInteger(
    options.stderrCapBytes,
    SYSTEMCTL_STDERR_CAP_BYTES,
    SYSTEMCTL_STDERR_CAP_BYTES,
    "systemctl stderr cap",
  );

  const run = async (
    action: SystemctlAction,
    targetCapability: VellumSystemdUserUnitTarget,
  ): Promise<SystemctlRunResult> => {
    const unit = systemdUserUnitTargets.get(targetCapability);
    const emptyBase: SystemctlResultBase = {
      action,
      unit: unit ?? "<unadmitted>",
      stdout: "",
      stderr: "",
    };
    if (unit === undefined) {
      return Object.freeze({
        ...emptyBase,
        clean: true,
        ok: false,
        failure: failure(
          "invalid-target",
          "missing Vellum systemd user-unit target authority",
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
        source: "supervision.systemctl-runner",
        purpose: `${action} Vellum systemd user unit`,
        command: SYSTEMCTL_PATH,
        args: actionArgs(action, unit),
        env: systemctlEnvironment(),
        shell: false,
      });
    } catch (error) {
      if (processPlane.isQuiescing()) {
        return Object.freeze({
          ...emptyBase,
          clean: true,
          ok: false,
          failure: failure("admission-refused", boundedDiagnostic(error)),
        });
      }
      return Object.freeze({
        ...emptyBase,
        clean: false,
        ok: false,
        failure: failure("spawn-failed", boundedDiagnostic(error)),
      });
    }

    return new Promise<SystemctlRunResult>((resolve) => {
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
      let activeFailure: SystemctlFailure | undefined;
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

      const base = (): SystemctlResultBase => ({
        action,
        unit,
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
              `systemctl emitted no close witness after ${trigger} teardown`,
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
              `systemctl closed with code ${String(close.code)} and signal ${String(close.signal)}`,
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
              `systemctl ${action} bounded teardown escalation`,
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

      const beginTeardown = (nextFailure: SystemctlFailure): void => {
        if (settled || activeFailure !== undefined) return;
        activeFailure = nextFailure;
        if (deadlineTimer !== undefined) {
          clearTimeout(deadlineTimer);
          deadlineTimer = undefined;
        }
        try {
          processPlane.terminate(
            lease,
            `systemctl ${action} bounded teardown`,
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
            `systemctl stdout exceeded ${stdoutCapBytes} bytes`,
          ));
        }
      }

      function onStderr(chunk: string | Buffer): void {
        if (appendOutput(stderr, chunk)) {
          beginTeardown(failure(
            "stderr-overflow",
            `systemctl stderr exceeded ${stderrCapBytes} bytes`,
          ));
        }
      }

      function onStdoutError(error: Error): void {
        beginTeardown(failure(
          "process-error",
          `systemctl stdout error: ${boundedDiagnostic(error)}`,
        ));
      }

      function onStderrError(error: Error): void {
        beginTeardown(failure(
          "process-error",
          `systemctl stderr error: ${boundedDiagnostic(error)}`,
        ));
      }

      function onStdinError(error: Error): void {
        beginTeardown(failure(
          "process-error",
          `systemctl stdin error: ${boundedDiagnostic(error)}`,
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
        beginTeardown(failure("process-error", boundedDiagnostic(error)));
      });
      if (settled) errorSubscription();
      else removeProcessError = errorSubscription;

      if (settled) return;
      deadlineTimer = setTimeout(() => {
        deadlineTimer = undefined;
        beginTeardown(failure(
          "deadline",
          `systemctl exceeded ${deadlineMs}ms deadline`,
        ));
      }, deadlineMs);
    });
  };

  return Object.freeze({
    showVellumUnit: (target: VellumSystemdUserUnitTarget) =>
      run("show", target),
    startVellumUnit: (target: VellumSystemdUserUnitTarget) =>
      run("start", target),
  });
};

const systemctlRunner = createSystemctlRunner();

export const showVellumSystemdUserUnit = (
  target: VellumSystemdUserUnitTarget,
): Promise<SystemctlRunResult> => systemctlRunner.showVellumUnit(target);

export const startVellumSystemdUserUnit = (
  target: VellumSystemdUserUnitTarget,
): Promise<SystemctlRunResult> => systemctlRunner.startVellumUnit(target);
