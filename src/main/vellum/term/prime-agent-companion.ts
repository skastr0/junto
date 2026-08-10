import { mkdtempDisposableSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  appProcessPlane,
  type AppProcessExit,
  type AppProcessLease,
  type AppProcessPlane,
  type AppProcessSignalReceipt,
} from "../app-process-plane";
import {
  primeAgentReporterPlane,
  type PrimeAgentReporterPlane,
  type PrimeAgentReporterRegistration,
  type PrimeAgentReporterReport,
} from "./prime-agent-reporter";

const PRIME_AGENT_DAEMON_SOCKET_NAME = "daemon.sock";
const PRIME_AGENT_TEMP_PREFIX = "vc-pa-";
const PRIME_AGENT_OUTPUT_LIMIT_BYTES = 64 * 1024;
const PRIME_AGENT_MAX_ROOTS = 32;
const PRIME_AGENT_ACTIVE_SESSION_ID_MAX_BYTES = 256;
const PRIME_AGENT_COMMAND_TIMEOUT_MS = 4_000;
const PRIME_AGENT_COMMAND_TERM_GRACE_MS = 250;
const PRIME_AGENT_COMMAND_KILL_GRACE_MS = 500;
const PRIME_AGENT_DAEMON_TERM_GRACE_MS = 1_500;
const PRIME_AGENT_DAEMON_KILL_GRACE_MS = 1_500;
const PRIME_AGENT_LIST_ATTEMPTS = 3;
const PRIME_AGENT_LIST_RETRY_MS = 50;
const PRIME_AGENT_REPLACEMENT_PROBES = 6;
const PRIME_AGENT_REPLACEMENT_RETRY_MS = 500;

/**
 * The PTY wrapper does readiness work in its own process. Electron main only
 * creates the foreground daemon lease and returns this launch synchronously.
 * Every dynamic value is passed after the `sh -c` program and consumed through
 * positional parameters; no path or authored argument is interpolated here.
 */
const PRIME_AGENT_CLIENT_WRAPPER = String.raw`prime_agent=$1
socket_path=$2
shift 2
attempt=0
while [ "$attempt" -lt 3 ]; do
  if "$prime_agent" list --json --daemon-socket "$socket_path" >/dev/null 2>&1; then
    case "$1" in
      stop|rename) exec "$prime_agent" --daemon-socket "$socket_path" -- "$@" ;;
      *) exec "$prime_agent" --daemon-socket "$socket_path" "$@" ;;
    esac
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done
printf '%s\n' 'Vellum Command: timed out waiting for the managed Prime Agent daemon.' >&2
exit 70`;

const PRIME_AGENT_CLIENT_WRAPPER_ARG0 = "vellum-command-prime-agent";

type DisposableTempDirectory = ReturnType<typeof mkdtempDisposableSync>;

export type PrimeAgentCompanionLaunch = {
  readonly file: string;
  readonly args: string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
};

export type PrimeAgentCompanionStartInput = {
  readonly bindingId: string;
  readonly epoch: string;
  readonly launch: {
    readonly file: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<NodeJS.ProcessEnv>;
  };
  readonly onReport?: (report: PrimeAgentReporterReport) => void;
  readonly onUnexpectedExit?: (
    event: PrimeAgentCompanionUnexpectedExit,
  ) => void;
};

export type PrimeAgentCompanionDiagnosticStage =
  | "reporter-release"
  | "list"
  | "stop"
  | "verify"
  | "daemon-exit"
  | "daemon-term"
  | "daemon-kill"
  | "replacement"
  | "temporary-directory";

export type PrimeAgentCompanionDiagnostic = Readonly<{
  stage: PrimeAgentCompanionDiagnosticStage;
  message: string;
  argv?: readonly string[];
  exit?: AppProcessExit;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: true;
  stderrTruncated?: true;
}>;

export type PrimeAgentCompanionStopReceipt = Readonly<{
  bindingId: string;
  epoch: string;
  reason: string;
  clean: boolean;
  reporterReleased: boolean;
  rootSessionIds: readonly string[];
  stoppedSessionIds: readonly string[];
  remainingActiveSessionIds: readonly string[];
  daemonExited: boolean;
  directoryRemoved: boolean;
  term?: AppProcessSignalReceipt;
  kill?: AppProcessSignalReceipt;
  diagnostics: readonly PrimeAgentCompanionDiagnostic[];
}>;

/** Alias for consumers that only need the one-handle cleanup receipt. */
export type PrimeAgentCompanionReceipt = PrimeAgentCompanionStopReceipt;

export type PrimeAgentCompanionShutdownReceipt = Readonly<{
  clean: boolean;
  receipts: readonly PrimeAgentCompanionStopReceipt[];
}>;

export type PrimeAgentCompanionUnexpectedExit = Readonly<{
  bindingId: string;
  epoch: string;
  daemonPid: number;
  exit: AppProcessExit;
  stdout: string;
  stderr: string;
  cleanup: Promise<PrimeAgentCompanionStopReceipt>;
}>;

export interface PrimeAgentCompanionHandle {
  readonly bindingId: string;
  readonly epoch: string;
  /** Diagnostics and process-bind only. Never signal this numeric value. */
  readonly daemonPid: number;
  /** Explicit alias documenting the limited authority of the numeric value. */
  readonly daemonPidForDiagnostics: number;
  readonly socketPath: string;
  readonly terminalLaunch: PrimeAgentCompanionLaunch;
  readonly stop: (reason?: string) => Promise<PrimeAgentCompanionStopReceipt>;
}

export interface PrimeAgentCompanionManager {
  readonly start: (
    input: PrimeAgentCompanionStartInput,
  ) => PrimeAgentCompanionHandle;
  readonly shutdownAll: (
    reason?: string,
  ) => Promise<PrimeAgentCompanionShutdownReceipt>;
}

export type PrimeAgentCompanionProcessPlane = Pick<
  AppProcessPlane,
  "spawnChild" | "terminate" | "forceTerminate"
>;

export type PrimeAgentCompanionReporterPort = Pick<
  PrimeAgentReporterPlane,
  "register"
>;

export type PrimeAgentCompanionManagerOptions = Readonly<{
  processPlane?: PrimeAgentCompanionProcessPlane;
  reporterPort?: PrimeAgentCompanionReporterPort;
  commandTimeoutMs?: number;
  commandTermGraceMs?: number;
  commandKillGraceMs?: number;
  daemonTermGraceMs?: number;
  daemonKillGraceMs?: number;
  listAttempts?: number;
  listRetryMs?: number;
  replacementProbes?: number;
  replacementRetryMs?: number;
}>;

type ManagerTiming = Readonly<{
  commandTimeoutMs: number;
  commandTermGraceMs: number;
  commandKillGraceMs: number;
  daemonTermGraceMs: number;
  daemonKillGraceMs: number;
  listAttempts: number;
  listRetryMs: number;
  replacementProbes: number;
  replacementRetryMs: number;
}>;

type BoundedSnapshot = Readonly<{
  text: string;
  truncated: boolean;
}>;

type CommandOutcome = Readonly<{
  argv: readonly string[];
  spawned: boolean;
  exit?: AppProcessExit;
  stdout: BoundedSnapshot;
  stderr: BoundedSnapshot;
  errors: readonly string[];
  timedOut: boolean;
  term?: AppProcessSignalReceipt;
  kill?: AppProcessSignalReceipt;
}>;

type ScopedList = Readonly<{
  roots: readonly string[];
  active: readonly string[];
}>;

type ListOutcome =
  | Readonly<{ ok: true; list: ScopedList; command: CommandOutcome }>
  | Readonly<{ ok: false; message: string; command: CommandOutcome }>;

type CompanionRecord = {
  readonly bindingId: string;
  readonly epoch: string;
  readonly file: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly socketPath: string;
  readonly directory: DisposableTempDirectory;
  readonly registration: PrimeAgentReporterRegistration;
  readonly lease: AppProcessLease;
  readonly daemonPid: number;
  readonly daemonStdout: BoundedCollector;
  readonly daemonStderr: BoundedCollector;
  readonly onUnexpectedExit:
    | ((event: PrimeAgentCompanionUnexpectedExit) => void)
    | undefined;
  handle: PrimeAgentCompanionHandle | undefined;
  stopFlight: Promise<PrimeAgentCompanionStopReceipt> | undefined;
  daemonExit: AppProcessExit | undefined;
  daemonClose: AppProcessExit | undefined;
  unexpected: boolean;
  unexpectedScheduled: boolean;
  directoryRemoved: boolean;
  outputCleanup: (() => void) | undefined;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizedText = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} required`);
  }
  return value.trim();
};

/**
 * These flags select the daemon topology itself. Authored launch argv may use
 * normal Prime Agent session flags, but can never replace the app-owned socket
 * or turn the managed PTY client into another low-level server.
 */
const assertManagedClientArgs = (args: readonly string[]): void => {
  let positionalOnly = false;
  for (const arg of args) {
    if (positionalOnly) continue;
    if (arg === "--") {
      positionalOnly = true;
      continue;
    }
    if (
      arg === "--daemon-socket" ||
      arg.startsWith("--daemon-socket=") ||
      arg === "--mode" ||
      arg.startsWith("--mode=")
    ) {
      throw new Error(
        `Prime Agent managed seats reserve ${arg.split("=", 1)[0]} for Vellum Command`,
      );
    }
  }
};

const boundedInteger = (
  value: number | undefined,
  fallback: number,
  label: string,
  options: { readonly minimum: number; readonly maximum: number },
): number => {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < options.minimum ||
    resolved > options.maximum
  ) {
    throw new RangeError(
      `${label} must be an integer from ${options.minimum} through ${options.maximum}`,
    );
  }
  return resolved;
};

const managerTiming = (
  options: PrimeAgentCompanionManagerOptions,
): ManagerTiming =>
  Object.freeze({
    commandTimeoutMs: boundedInteger(
      options.commandTimeoutMs,
      PRIME_AGENT_COMMAND_TIMEOUT_MS,
      "Prime Agent command timeout",
      { minimum: 1, maximum: 30_000 },
    ),
    commandTermGraceMs: boundedInteger(
      options.commandTermGraceMs,
      PRIME_AGENT_COMMAND_TERM_GRACE_MS,
      "Prime Agent command TERM grace",
      { minimum: 0, maximum: 5_000 },
    ),
    commandKillGraceMs: boundedInteger(
      options.commandKillGraceMs,
      PRIME_AGENT_COMMAND_KILL_GRACE_MS,
      "Prime Agent command KILL grace",
      { minimum: 0, maximum: 5_000 },
    ),
    daemonTermGraceMs: boundedInteger(
      options.daemonTermGraceMs,
      PRIME_AGENT_DAEMON_TERM_GRACE_MS,
      "Prime Agent daemon TERM grace",
      { minimum: 0, maximum: 30_000 },
    ),
    daemonKillGraceMs: boundedInteger(
      options.daemonKillGraceMs,
      PRIME_AGENT_DAEMON_KILL_GRACE_MS,
      "Prime Agent daemon KILL grace",
      { minimum: 0, maximum: 30_000 },
    ),
    listAttempts: boundedInteger(
      options.listAttempts,
      PRIME_AGENT_LIST_ATTEMPTS,
      "Prime Agent list attempts",
      { minimum: 1, maximum: 10 },
    ),
    listRetryMs: boundedInteger(
      options.listRetryMs,
      PRIME_AGENT_LIST_RETRY_MS,
      "Prime Agent list retry delay",
      { minimum: 0, maximum: 1_000 },
    ),
    replacementProbes: boundedInteger(
      options.replacementProbes,
      PRIME_AGENT_REPLACEMENT_PROBES,
      "Prime Agent replacement probes",
      { minimum: 1, maximum: 10 },
    ),
    replacementRetryMs: boundedInteger(
      options.replacementRetryMs,
      PRIME_AGENT_REPLACEMENT_RETRY_MS,
      "Prime Agent replacement retry delay",
      { minimum: 0, maximum: 1_000 },
    ),
  });

class BoundedCollector {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private didTruncate = false;

  constructor(private readonly limit: number) {}

  readonly append = (chunk: unknown): void => {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(typeof chunk === "string" ? chunk : String(chunk));
    const remaining = this.limit - this.bytes;
    if (remaining > 0) {
      const accepted = buffer.subarray(0, remaining);
      this.chunks.push(Buffer.from(accepted));
      this.bytes += accepted.byteLength;
    }
    if (buffer.byteLength > Math.max(0, remaining)) this.didTruncate = true;
  };

  snapshot(): BoundedSnapshot {
    return Object.freeze({
      text: Buffer.concat(this.chunks, this.bytes).toString("utf8"),
      truncated: this.didTruncate,
    });
  }
}

const attachCollector = (
  stream: Readable,
  collector: BoundedCollector,
): (() => void) => {
  stream.on("data", collector.append);
  return () => stream.off("data", collector.append);
};

const scrubPrimeAgentCompanionEnv = (
  env: Readonly<NodeJS.ProcessEnv>,
  registration: PrimeAgentReporterRegistration,
): Record<string, string> => {
  const scrubbed: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key === "PI_CODING_AGENT") continue;
    if (key.startsWith("PRIME_AGENT_INTERNAL_")) continue;
    scrubbed[key] = value;
  }
  scrubbed.HERDR_ENV = "1";
  scrubbed.HERDR_SOCKET_PATH = registration.socketPath;
  scrubbed.HERDR_PANE_ID = registration.paneId;
  return scrubbed;
};

const terminalLaunchFor = (
  launch: PrimeAgentCompanionStartInput["launch"],
  socketPath: string,
  env: Record<string, string>,
): PrimeAgentCompanionLaunch => {
  const args = Object.freeze([
    "-c",
    PRIME_AGENT_CLIENT_WRAPPER,
    PRIME_AGENT_CLIENT_WRAPPER_ARG0,
    launch.file,
    socketPath,
    ...launch.args,
  ]) as unknown as string[];
  const terminalEnv = Object.freeze({ ...env }) as Record<string, string>;
  return Object.freeze({
    file: "/bin/sh",
    args,
    cwd: launch.cwd,
    env: terminalEnv,
  });
};

const delay = (milliseconds: number): Promise<void> =>
  milliseconds === 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, milliseconds));

type PromiseObservation<Value> =
  | Readonly<{ state: "resolved"; value: Value }>
  | Readonly<{ state: "rejected"; error: unknown }>
  | Readonly<{ state: "timeout" }>;

const observeWithin = <Value>(
  promise: Promise<Value>,
  timeoutMs: number,
): Promise<PromiseObservation<Value>> => {
  if (timeoutMs === 0) return Promise.resolve({ state: "timeout" });
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ state: "timeout" });
    }, timeoutMs);
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ state: "resolved", value });
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ state: "rejected", error });
      },
    );
  });
};

const safeMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 1_000);

const sessionIdsFromList = (value: unknown): ScopedList | undefined => {
  if (!isObject(value) || !Array.isArray(value.sessions)) return undefined;
  const roots: string[] = [];
  const active: string[] = [];
  for (const session of value.sessions) {
    // This command is `list` without `--all`: every row is an active runtime
    // entry. A malformed or saved-only-looking row is uncertainty about a live
    // root, never evidence that the scoped daemon is empty.
    if (!isObject(session)) return undefined;
    const activeSessionId = session.activeSessionId;
    if (typeof activeSessionId !== "string") return undefined;
    const id = activeSessionId.trim();
    if (
      id.length === 0 ||
      id.startsWith("-") ||
      Buffer.byteLength(id, "utf8") >
        PRIME_AGENT_ACTIVE_SESSION_ID_MAX_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(id)
    ) {
      return undefined;
    }
    if (!active.includes(id)) active.push(id);
    if (
      session.runtimeKind === "top-level" &&
      session.rlmDepth === 0 &&
      !roots.includes(id)
    ) {
      roots.push(id);
    }
  }
  return Object.freeze({
    roots: Object.freeze(roots),
    active: Object.freeze(active),
  });
};

const diagnosticForCommand = (
  stage: Extract<PrimeAgentCompanionDiagnosticStage, "list" | "stop" | "verify" | "replacement">,
  message: string,
  outcome: CommandOutcome,
): PrimeAgentCompanionDiagnostic => {
  const stdout = outcome.stdout.text.trim();
  const stderr = outcome.stderr.text.trim();
  return Object.freeze({
    stage,
    message,
    argv: outcome.argv,
    ...(outcome.exit === undefined ? {} : { exit: outcome.exit }),
    ...(stdout.length === 0 ? {} : { stdout }),
    ...(stderr.length === 0 ? {} : { stderr }),
    ...(outcome.stdout.truncated ? { stdoutTruncated: true as const } : {}),
    ...(outcome.stderr.truncated ? { stderrTruncated: true as const } : {}),
  });
};

const commandSucceeded = (outcome: CommandOutcome): boolean =>
  outcome.spawned &&
  !outcome.timedOut &&
  outcome.errors.length === 0 &&
  outcome.exit?.code === 0;

export const makePrimeAgentCompanionManager = (
  options: PrimeAgentCompanionManagerOptions = {},
): PrimeAgentCompanionManager => {
  const processPlane = options.processPlane ?? appProcessPlane;
  const reporterPort = options.reporterPort ?? primeAgentReporterPlane;
  const timing = managerTiming(options);
  const records = new Set<CompanionRecord>();
  let closing = false;
  let closeFlight: Promise<PrimeAgentCompanionShutdownReceipt> | undefined;

  const runCommand = async (
    record: CompanionRecord,
    argv: readonly string[],
    purpose: string,
  ): Promise<CommandOutcome> => {
    const stdout = new BoundedCollector(PRIME_AGENT_OUTPUT_LIMIT_BYTES);
    const stderr = new BoundedCollector(PRIME_AGENT_OUTPUT_LIMIT_BYTES);
    const errors: string[] = [];
    let lease: AppProcessLease;
    try {
      lease = processPlane.spawnChild({
        source: `term:prime-agent:${record.bindingId}`,
        purpose,
        command: record.file,
        args: [...argv],
        cwd: record.cwd,
        env: { ...record.env },
        isolateProcessGroup: true,
      });
    } catch (error) {
      errors.push(safeMessage(error));
      return Object.freeze({
        argv: Object.freeze([...argv]),
        spawned: false,
        stdout: stdout.snapshot(),
        stderr: stderr.snapshot(),
        errors: Object.freeze(errors),
        timedOut: false,
      });
    }

    const cleanupStdout = attachCollector(lease.io.stdout, stdout);
    const cleanupStderr = attachCollector(lease.io.stderr, stderr);
    const cleanupError = lease.io.onError((error) => {
      if (errors.length < 8) errors.push(safeMessage(error));
    });
    const cleanup = (): void => {
      cleanupStdout();
      cleanupStderr();
      cleanupError();
    };
    try {
      lease.io.stdin.end();
    } catch (error) {
      if (errors.length < 8) errors.push(safeMessage(error));
    }

    let timedOut = false;
    let term: AppProcessSignalReceipt | undefined;
    let kill: AppProcessSignalReceipt | undefined;
    let close = await observeWithin(lease.io.closed, timing.commandTimeoutMs);
    if (close.state !== "resolved") {
      timedOut = close.state === "timeout";
      if (close.state === "rejected") errors.push(safeMessage(close.error));
      term = processPlane.terminate(
        lease,
        `prime-agent-companion-command:${purpose}`,
      );
      close = await observeWithin(
        lease.io.closed,
        timing.commandTermGraceMs,
      );
    }
    if (close.state !== "resolved") {
      if (close.state === "rejected") errors.push(safeMessage(close.error));
      kill = processPlane.forceTerminate(
        lease,
        `prime-agent-companion-command:${purpose}`,
      );
      close = await observeWithin(
        lease.io.closed,
        timing.commandKillGraceMs,
      );
    }

    if (close.state === "resolved") {
      cleanup();
    } else {
      if (close.state === "rejected") errors.push(safeMessage(close.error));
      // A refused exact-lease signal must not make an undrained child block on
      // its pipes. Keep the bounded listeners until the central close witness.
      void lease.io.closed.then(cleanup, cleanup);
    }

    return Object.freeze({
      argv: Object.freeze([...argv]),
      spawned: true,
      ...(close.state === "resolved" ? { exit: close.value } : {}),
      stdout: stdout.snapshot(),
      stderr: stderr.snapshot(),
      errors: Object.freeze(errors),
      timedOut,
      ...(term === undefined ? {} : { term }),
      ...(kill === undefined ? {} : { kill }),
    });
  };

  const listOnce = async (
    record: CompanionRecord,
    purpose: string,
  ): Promise<ListOutcome> => {
    const command = await runCommand(
      record,
      ["list", "--json", "--daemon-socket", record.socketPath],
      purpose,
    );
    if (!commandSucceeded(command)) {
      const detail = command.errors[0] ??
        (command.timedOut
          ? "command timed out"
          : `command exited with ${String(command.exit?.code)}`);
      return Object.freeze({
        ok: false as const,
        message: `scoped Prime Agent list failed: ${detail}`,
        command,
      });
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(command.stdout.text);
    } catch (error) {
      return Object.freeze({
        ok: false as const,
        message: `scoped Prime Agent list returned invalid JSON: ${safeMessage(error)}`,
        command,
      });
    }
    const list = sessionIdsFromList(decoded);
    if (list === undefined) {
      return Object.freeze({
        ok: false as const,
        message: "scoped Prime Agent list returned a malformed active sessions roster",
        command,
      });
    }
    return Object.freeze({ ok: true as const, list, command });
  };

  const listWithRetry = async (
    record: CompanionRecord,
    purpose: string,
  ): Promise<ListOutcome> => {
    let last: ListOutcome | undefined;
    for (let attempt = 0; attempt < timing.listAttempts; attempt += 1) {
      last = await listOnce(record, `${purpose}:${attempt + 1}`);
      if (last.ok) return last;
      if (attempt + 1 < timing.listAttempts) await delay(timing.listRetryMs);
    }
    return last!;
  };

  const waitForDaemonExit = async (
    record: CompanionRecord,
    timeoutMs: number,
  ): Promise<boolean> => {
    if (record.daemonExit !== undefined) return true;
    const observed = await observeWithin(record.lease.io.exited, timeoutMs);
    if (observed.state !== "resolved") return false;
    record.daemonExit = observed.value;
    return true;
  };

  const waitForReplacement = async (
    record: CompanionRecord,
  ): Promise<ListOutcome | undefined> => {
    for (
      let attempt = 0;
      attempt < timing.replacementProbes;
      attempt += 1
    ) {
      await delay(timing.replacementRetryMs);
      const probe = await listOnce(
        record,
        `unexpected replacement discovery ${attempt + 1}`,
      );
      if (probe.ok) return probe;
    }
    return undefined;
  };

  const replacementDisappeared = async (
    record: CompanionRecord,
    diagnostics: PrimeAgentCompanionDiagnostic[],
  ): Promise<boolean> => {
    let answeredDuringWindow = false;
    for (
      let attempt = 0;
      attempt < timing.replacementProbes;
      attempt += 1
    ) {
      await delay(timing.replacementRetryMs);
      const probe = await listOnce(
        record,
        `unexpected replacement probe ${attempt + 1}`,
      );
      if (!probe.ok) continue;
      answeredDuringWindow = true;
      if (probe.list.active.length > 0) {
        diagnostics.push(
          diagnosticForCommand(
            "replacement",
            `unowned replacement retained active sessions: ${probe.list.active.join(", ")}`,
            probe.command,
          ),
        );
        return false;
      }
    }
    if (!answeredDuringWindow) return true;
    diagnostics.push(
      Object.freeze({
        stage: "replacement",
        message:
          "an unowned replacement answered during the bounded convergence window; it was not adopted or signaled",
      }),
    );
    return false;
  };

  const performStop = async (
    record: CompanionRecord,
    reason: string,
  ): Promise<PrimeAgentCompanionStopReceipt> => {
    const diagnostics: PrimeAgentCompanionDiagnostic[] = [];
    let failed = false;
    let reporterReleased = false;
    try {
      record.registration.release();
      reporterReleased = true;
    } catch (error) {
      failed = true;
      diagnostics.push(
        Object.freeze({
          stage: "reporter-release",
          message: safeMessage(error),
        }),
      );
    }

    let initial = await listWithRetry(record, "scoped list before stop");
    let rootSessionIds: readonly string[] = [];
    let stoppedSessionIds: readonly string[] = [];
    let remainingActiveSessionIds: readonly string[] = [];
    let scopedEmpty = false;
    let replacementObserved = false;

    if (
      !initial.ok &&
      record.unexpected &&
      record.daemonExit !== undefined
    ) {
      const replacement = await waitForReplacement(record);
      if (replacement !== undefined) {
        initial = replacement;
        replacementObserved = true;
      }
    }

    if (!initial.ok) {
      failed = true;
      diagnostics.push(
        diagnosticForCommand("list", initial.message, initial.command),
      );
      if (record.unexpected && record.daemonExit !== undefined) {
        diagnostics.push(
          Object.freeze({
            stage: "replacement",
            message:
              "no exact-socket replacement appeared during the bounded convergence window; detached roots could not be proven gone",
          }),
        );
      }
    } else {
      replacementObserved =
        replacementObserved ||
        (record.unexpected && record.daemonExit !== undefined);
      rootSessionIds = initial.list.roots;
      if (rootSessionIds.length > PRIME_AGENT_MAX_ROOTS) {
        failed = true;
        diagnostics.push(
          Object.freeze({
            stage: "list",
            message: `refusing an unbounded root cleanup of ${rootSessionIds.length} sessions`,
          }),
        );
      } else {
        const stopResults = await Promise.all(
          rootSessionIds.map(async (activeSessionId) => {
            const command = await runCommand(
              record,
              [
                "stop",
                activeSessionId,
                "--json",
                "--daemon-socket",
                record.socketPath,
              ],
              `stop root ${activeSessionId}`,
            );
            return { activeSessionId, command } as const;
          }),
        );
        const stopped: string[] = [];
        for (const result of stopResults) {
          if (commandSucceeded(result.command)) {
            stopped.push(result.activeSessionId);
          } else {
            failed = true;
            diagnostics.push(
              diagnosticForCommand(
                "stop",
                `failed to stop scoped root ${result.activeSessionId}`,
                result.command,
              ),
            );
          }
        }
        stoppedSessionIds = Object.freeze(stopped);

        const verification = await listWithRetry(
          record,
          "scoped list after stop",
        );
        if (!verification.ok) {
          failed = true;
          diagnostics.push(
            diagnosticForCommand(
              "verify",
              verification.message,
              verification.command,
            ),
          );
        } else {
          remainingActiveSessionIds = verification.list.active;
          scopedEmpty = remainingActiveSessionIds.length === 0;
          if (!scopedEmpty) {
            failed = true;
            diagnostics.push(
              diagnosticForCommand(
                "verify",
                `scoped daemon retained active sessions: ${remainingActiveSessionIds.join(", ")}`,
                verification.command,
              ),
            );
          }
        }
      }
    }

    let term: AppProcessSignalReceipt | undefined;
    let kill: AppProcessSignalReceipt | undefined;
    let daemonExited = record.daemonExit !== undefined;
    let replacementGone = !replacementObserved;

    if (scopedEmpty) {
      if (!daemonExited) {
        term = processPlane.terminate(
          record.lease,
          `prime-agent-companion:${reason}`,
        );
        daemonExited = await waitForDaemonExit(
          record,
          timing.daemonTermGraceMs,
        );
        if (!daemonExited) {
          kill = processPlane.forceTerminate(
            record.lease,
            `prime-agent-companion:${reason}`,
          );
          daemonExited = await waitForDaemonExit(
            record,
            timing.daemonKillGraceMs,
          );
        }
      }
      if (daemonExited && replacementObserved) {
        replacementGone = await replacementDisappeared(record, diagnostics);
        if (!replacementGone) failed = true;
      }
    }

    if (!daemonExited && scopedEmpty) {
      failed = true;
      diagnostics.push(
        Object.freeze({
          stage: kill === undefined ? "daemon-term" : "daemon-kill",
          message: "the exact retained daemon lease did not produce an exit witness",
        }),
      );
    }

    let directoryRemoved = record.directoryRemoved;
    if (scopedEmpty && daemonExited && replacementGone && !directoryRemoved) {
      try {
        record.directory.remove();
        record.directoryRemoved = true;
        directoryRemoved = true;
      } catch (error) {
        failed = true;
        diagnostics.push(
          Object.freeze({
            stage: "temporary-directory",
            message: safeMessage(error),
          }),
        );
      }
    }

    if (record.unexpected && record.daemonExit !== undefined) {
      const stdout = record.daemonStdout.snapshot();
      const stderr = record.daemonStderr.snapshot();
      diagnostics.unshift(
        Object.freeze({
          stage: "daemon-exit",
          message: `managed Prime Agent daemon exited unexpectedly with code ${String(record.daemonExit.code)} and signal ${String(record.daemonExit.signal)}`,
          exit: record.daemonExit,
          ...(stdout.text.trim().length === 0 ? {} : { stdout: stdout.text.trim() }),
          ...(stderr.text.trim().length === 0 ? {} : { stderr: stderr.text.trim() }),
          ...(stdout.truncated ? { stdoutTruncated: true as const } : {}),
          ...(stderr.truncated ? { stderrTruncated: true as const } : {}),
        }),
      );
    }

    if (directoryRemoved && daemonExited) records.delete(record);
    const receipt: PrimeAgentCompanionStopReceipt = Object.freeze({
      bindingId: record.bindingId,
      epoch: record.epoch,
      reason,
      clean:
        !failed &&
        reporterReleased &&
        scopedEmpty &&
        daemonExited &&
        replacementGone &&
        directoryRemoved,
      reporterReleased,
      rootSessionIds: Object.freeze([...rootSessionIds]),
      stoppedSessionIds: Object.freeze([...stoppedSessionIds]),
      remainingActiveSessionIds: Object.freeze([
        ...remainingActiveSessionIds,
      ]),
      daemonExited,
      directoryRemoved,
      ...(term === undefined ? {} : { term }),
      ...(kill === undefined ? {} : { kill }),
      diagnostics: Object.freeze(diagnostics),
    });
    return receipt;
  };

  const stopRecord = (
    record: CompanionRecord,
    reason: string,
    unexpected = false,
  ): Promise<PrimeAgentCompanionStopReceipt> => {
    if (record.stopFlight !== undefined) return record.stopFlight;
    record.unexpected = record.unexpected || unexpected;
    const normalizedReason = reason.trim() || "seat_stop";
    const flight = performStop(record, normalizedReason);
    record.stopFlight = flight;
    return flight;
  };

  const start = (
    input: PrimeAgentCompanionStartInput,
  ): PrimeAgentCompanionHandle => {
    if (closing) throw new Error("Prime Agent companion manager is closing");
    if (process.platform !== "darwin" && process.platform !== "linux") {
      throw new Error("Prime Agent companion requires Linux or macOS");
    }
    const bindingId = normalizedText(input.bindingId, "bindingId");
    const epoch = normalizedText(input.epoch, "epoch");
    const file = normalizedText(input.launch.file, "Prime Agent executable");
    const cwd = normalizedText(input.launch.cwd, "Prime Agent cwd");
    assertManagedClientArgs(input.launch.args);
    // Local replacement is synchronous: identity revocation and old-generation
    // stop admission happen before the new PTY is opened, but exact cleanup is
    // asynchronous. Permit a distinct epoch only after that old stop cut exists.
    for (const record of records) {
      if (
        record.bindingId === bindingId &&
        (record.epoch === epoch || record.stopFlight === undefined)
      ) {
        throw new Error(
          `Prime Agent companion already owns managed seat ${bindingId}@${record.epoch}`,
        );
      }
    }

    const directory = mkdtempDisposableSync(
      join(tmpdir(), PRIME_AGENT_TEMP_PREFIX),
    );
    const socketPath = join(directory.path, PRIME_AGENT_DAEMON_SOCKET_NAME);
    let registration: PrimeAgentReporterRegistration | undefined;
    let lease: AppProcessLease | undefined;
    try {
      registration = reporterPort.register({
        bindingId,
        epoch,
        onReport: input.onReport ?? (() => undefined),
      });
      const env = scrubPrimeAgentCompanionEnv(input.launch.env, registration);
      lease = processPlane.spawnChild({
        source: `term:prime-agent:${bindingId}`,
        purpose: `managed Prime Agent daemon ${bindingId}@${epoch}`,
        command: file,
        args: ["--mode", "daemon", "--daemon-socket", socketPath],
        cwd,
        env: { ...env },
        isolateProcessGroup: true,
      });
      const daemonPid = lease.io.pidForDiagnostics;
      if (daemonPid === undefined) {
        processPlane.terminate(
          lease,
          "prime-agent-companion-spawn-without-pid",
        );
        throw new Error("managed Prime Agent daemon did not expose a child pid");
      }

      const daemonStdout = new BoundedCollector(
        PRIME_AGENT_OUTPUT_LIMIT_BYTES,
      );
      const daemonStderr = new BoundedCollector(
        PRIME_AGENT_OUTPUT_LIMIT_BYTES,
      );
      const cleanupStdout = attachCollector(lease.io.stdout, daemonStdout);
      const cleanupStderr = attachCollector(lease.io.stderr, daemonStderr);
      const cleanupError = lease.io.onError((error) => daemonStderr.append(
        `\n${safeMessage(error)}`,
      ));
      const record: CompanionRecord = {
        bindingId,
        epoch,
        file,
        cwd,
        env,
        socketPath,
        directory,
        registration,
        lease,
        daemonPid,
        daemonStdout,
        daemonStderr,
        onUnexpectedExit: input.onUnexpectedExit,
        handle: undefined,
        stopFlight: undefined,
        daemonExit: undefined,
        daemonClose: undefined,
        unexpected: false,
        unexpectedScheduled: false,
        directoryRemoved: false,
        outputCleanup: () => {
          cleanupStdout();
          cleanupStderr();
          cleanupError();
        },
      };
      const terminalLaunch = terminalLaunchFor(
        input.launch,
        socketPath,
        env,
      );
      const handle: PrimeAgentCompanionHandle = Object.freeze({
        bindingId,
        epoch,
        daemonPid,
        daemonPidForDiagnostics: daemonPid,
        socketPath,
        terminalLaunch,
        stop: (reason = "seat_stop") => stopRecord(record, reason),
      });
      record.handle = handle;
      records.add(record);

      void lease.io.closed.then(
        (event) => {
          record.daemonClose = event;
          record.outputCleanup?.();
          record.outputCleanup = undefined;
        },
        (error) => daemonStderr.append(`\n${safeMessage(error)}`),
      );
      lease.io.onExit((event) => {
        record.daemonExit = event;
        if (record.stopFlight !== undefined || record.unexpectedScheduled) return;
        record.unexpectedScheduled = true;
        queueMicrotask(() => {
          if (record.stopFlight !== undefined) return;
          // Record crash semantics before the owner callback can coalesce the
          // same stop flight under its own reason.
          record.unexpected = true;
          // Publish the cleanup flight now, but defer its first instruction to
          // the next microtask. The LocalSessionHost callback therefore gets a
          // synchronous cut line to revoke both process identities and stop the
          // PTY before reporter release or any scoped cleanup child can start.
          const cleanup = Promise.resolve().then(() =>
            stopRecord(record, "daemon_unexpected_exit", true)
          );
          try {
            record.onUnexpectedExit?.(
              Object.freeze({
                bindingId,
                epoch,
                daemonPid,
                exit: event,
                stdout: daemonStdout.snapshot().text,
                stderr: daemonStderr.snapshot().text,
                cleanup,
              }),
            );
          } catch {
            // Operator observers cannot interrupt exact-resource convergence.
          }
        });
      });
      return handle;
    } catch (error) {
      try {
        registration?.release();
      } catch {
        // Preserve the setup failure. The registration remains generation-local.
      }
      if (lease === undefined) {
        try {
          directory.remove();
        } catch {
          // Preserve the setup failure; only this minted capability was touched.
        }
      } else {
        // A lease returned without a usable diagnostic pid remains owned by the
        // central process plane. Never replace that capability with a number.
        void lease.io.closed.then(
          () => {
            try {
              directory.remove();
            } catch {
              // The central plane retains any straggler for app-level drain.
            }
          },
          () => undefined,
        );
      }
      throw error;
    }
  };

  const shutdownAll = (
    reason = "app_quit",
  ): Promise<PrimeAgentCompanionShutdownReceipt> => {
    if (closeFlight !== undefined) return closeFlight;
    closing = true;
    const snapshot = [...records];
    const flight = Promise.all(
      snapshot.map((record) => stopRecord(record, reason)),
    ).then((receipts) =>
      Object.freeze({
        clean: receipts.every((receipt) => receipt.clean),
        receipts: Object.freeze(receipts),
      }),
    );
    closeFlight = flight;
    return flight;
  };

  return Object.freeze({ start, shutdownAll });
};

/** Shared product manager; tests should inject isolated process and reporter planes. */
export const primeAgentCompanionManager: PrimeAgentCompanionManager =
  makePrimeAgentCompanionManager();
