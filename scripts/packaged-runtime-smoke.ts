import { spawnSync } from "node:child_process";
import { watch, writeSync, type FSWatcher } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Result } from "effect";
import { controlSocketPath, controlTokenPath } from "../src/shared/browser-control";
import {
  stationControlDir,
  stationControlSocketPath,
} from "../src/shared/station-ssh-control";
import {
  STATION_API_PROTOCOL,
  type StatusResponse,
} from "../src/shared/station-api";
import {
  STATION_SESSION_PROTOCOL,
  decodeStationSessionFrame,
} from "../src/shared/station-session";
import {
  createAppProcessPlane,
  type AppChildIo,
  type AppProcessDrainResult,
  type AppProcessLease,
  type AppProcessPlane,
} from "../src/main/vellum/app-process-plane";

const SMOKE_TIMEOUT_MS = 45_000;
const STARTUP_TIMEOUT_MS = 25_000;
const SHUTDOWN_TIMEOUT_MS = 7_000;
const CHILD_OUTPUT_LIMIT_BYTES = 64 * 1024;
const PACKAGED_STATION_STATUS_REQUEST_ID = "packaged-runtime-status";
const REQUIRED_PROCESS_ROLES = ["gpu-process", "main", "renderer", "utility"] as const;
// Darwin's sockaddr_un.sun_path is 104 bytes including the trailing NUL.
export const DARWIN_UNIX_SOCKET_PATH_MAX_BYTES = 103;

const currentUid = (): number => {
  if (process.getuid === undefined) {
    throw new Error("packaged runtime smoke requires POSIX ownership metadata");
  }
  return process.getuid();
};

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

export interface DoctorReceipt {
  readonly ok: true;
  readonly data: { readonly status: "ok" };
}

export const parseProcessRows = (output: string): ReadonlyArray<ProcessRow> => {
  const rows: ProcessRow[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const match = line.match(/^\s*([0-9]+)\s+([0-9]+)\s+(.+)$/u);
    if (match === null) throw new Error("ps returned a malformed process row");
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) {
      throw new Error("ps returned an invalid process identifier");
    }
    rows.push({ pid, ppid, command: match[3] });
  }
  return rows;
};

export const descendantRows = (
  rootPid: number,
  rows: ReadonlyArray<ProcessRow>,
): ReadonlyArray<ProcessRow> => {
  const descendants = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.pid) || !descendants.has(row.ppid)) continue;
      descendants.add(row.pid);
      changed = true;
    }
  }
  return rows.filter((row) => descendants.has(row.pid));
};

export const survivingProcessRows = (
  original: ReadonlyArray<ProcessRow>,
  current: ReadonlyArray<ProcessRow>,
): ReadonlyArray<ProcessRow> => {
  const originalCommands = new Map(original.map((row) => [row.pid, row.command]));
  return current.filter((row) => originalCommands.get(row.pid) === row.command);
};

const processRole = (row: ProcessRow, rootPid: number): string | undefined => {
  if (row.pid === rootPid) return "main";
  const match = row.command.match(/(?:^|\s)--type=([^\s]+)/u);
  if (match === null) return undefined;
  return match[1] === "gpu-process" || match[1] === "renderer" || match[1] === "utility"
    ? match[1]
    : undefined;
};

export const boundedProcessKind = (command: string): string => {
  for (const kind of [
    "codexbar",
    "grok",
    "hermes",
    "herdr",
    "zsh",
    "bash",
    "ssh",
    "launchctl",
    "prism",
    "bun",
    "node",
    "git",
  ]) {
    if (command.toLowerCase().includes(kind)) return kind;
  }
  return "other";
};

export const processRoles = (
  rootPid: number,
  rows: ReadonlyArray<ProcessRow>,
): ReadonlyArray<string> =>
  [...new Set(descendantRows(rootPid, rows).map((row) => processRole(row, rootPid)).filter(
    (role): role is string => role !== undefined,
  ))].sort();

export const hasDebugAuthority = (rows: ReadonlyArray<ProcessRow>): boolean =>
  rows.some((row) =>
    /(?:^|\s)--(?:remote-debugging(?:-port|-pipe)?|inspect(?:-brk)?)(?:=|\s|$)/u.test(
      row.command,
    ),
  );

export const assertNoLiveVellumRuntime = (
  rows: ReadonlyArray<ProcessRow>,
  bundleRoots: ReadonlyArray<string> = ["/Applications/Vellum Command.app"],
): void => {
  const prefixes = bundleRoots.map((root) => `${root}/Contents/`);
  const running = rows.some((row) =>
    prefixes.some((prefix) => row.command.startsWith(prefix)),
  );
  if (running) {
    throw new Error("a Vellum Command runtime is already running; close it before packaged smoke");
  }
};

export const parseDoctorReceipt = (output: string): DoctorReceipt => {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("packaged vellum browser returned non-JSON doctor output");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "data,ok" ||
    (value as { ok?: unknown }).ok !== true
  ) {
    throw new Error("packaged vellum browser returned the wrong doctor envelope");
  }
  const data = (value as { data?: unknown }).data;
  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    Object.keys(data).join(",") !== "status" ||
    (data as { status?: unknown }).status !== "ok"
  ) {
    throw new Error("packaged vellum browser returned the wrong doctor payload");
  }
  return value as DoctorReceipt;
};

export const modeString = (mode: number): string =>
  (mode & 0o777).toString(8).padStart(4, "0");

export const assertDarwinUnixSocketPathFits = (socketPath: string): void => {
  const bytes = Buffer.byteLength(socketPath);
  if (bytes > DARWIN_UNIX_SOCKET_PATH_MAX_BYTES) {
    throw new Error(
      `isolated control socket path exceeds the Darwin ${DARWIN_UNIX_SOCKET_PATH_MAX_BYTES}-byte limit`,
    );
  }
};

export const assertNoTcpListeners = (
  status: number | null,
  stdout: string,
): void => {
  if (status !== 1 || stdout.trim().length !== 0) {
    throw new Error("packaged Vellum Command descendants exposed a TCP listener");
  }
};

const runFixed = (
  executable: string,
  args: ReadonlyArray<string>,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly timeout?: number;
    readonly maxBuffer?: number;
    readonly input?: string;
  } = {},
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } => {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    shell: false,
    timeout: options.timeout ?? 10_000,
    maxBuffer: options.maxBuffer ?? 256 * 1024,
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  if (result.error !== undefined) {
    throw new Error(`${path.basename(executable)} could not run`);
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

export const parsePackagedStationStatus = (
  output: string,
  expectedRequestId: string = PACKAGED_STATION_STATUS_REQUEST_ID,
): StatusResponse => {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1) {
    throw new Error(
      "packaged vellum station-stdio returned the wrong response count",
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(lines[0]);
  } catch {
    throw new Error("packaged vellum station-stdio returned non-JSON output");
  }
  const decoded = decodeStationSessionFrame(raw);
  if (Result.isFailure(decoded)) {
    throw new Error(
      "packaged vellum station-stdio returned a malformed session frame",
    );
  }
  const frame = decoded.success;
  if (
    frame.frame !== "response" ||
    frame.requestId !== expectedRequestId ||
    !frame.envelope.ok ||
    frame.envelope.response.op !== "status"
  ) {
    throw new Error(
      "packaged vellum station-stdio returned the wrong status response",
    );
  }
  return frame.envelope.response;
};

export const verifyPackagedStationOwnerLocalHandoff = async (
  processPlane: AppProcessPlane,
  stationCli: string,
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    /** Unified CLI args; defaults to `station-stdio`. */
    readonly args?: ReadonlyArray<string>;
  },
): Promise<StatusResponse> => {
  const lease = processPlane.spawnChild({
    source: "packaged-runtime-smoke",
    purpose: "verify packaged Station owner-local handoff",
    command: stationCli,
    args: options.args ?? ["station-stdio"],
    cwd: options.cwd,
    env: options.env,
    shell: false,
    isolateProcessGroup: true,
  });
  const lifecycle = observeSpawnedRuntimeLease(lease);
  let stdout = "";
  let stderr = "";
  let responseObserved = false;
  let settleResponse!: () => void;
  let rejectResponse!: (error: Error) => void;
  const response = new Promise<void>((resolve, reject) => {
    settleResponse = resolve;
    rejectResponse = reject;
  });
  const observeBounded = (
    current: string,
    chunk: Buffer | string,
  ): string => {
    const next = `${current}${String(chunk)}`;
    if (Buffer.byteLength(next, "utf8") > CHILD_OUTPUT_LIMIT_BYTES) {
      rejectResponse(
        new Error("packaged vellum station-stdio exceeded its output bound"),
      );
    }
    return next;
  };
  const onStdout = (chunk: Buffer | string): void => {
    stdout = observeBounded(stdout, chunk);
    if (!responseObserved && /\r?\n/u.test(stdout)) {
      responseObserved = true;
      settleResponse();
    }
  };
  const onStderr = (chunk: Buffer | string): void => {
    stderr = observeBounded(stderr, chunk);
  };
  lease.io.stdout.on("data", onStdout);
  lease.io.stderr.on("data", onStderr);
  const removeErrorListener = lease.io.onError((error) =>
    rejectResponse(error)
  );
  const removeCloseListener = lease.io.onClose(() => {
    if (!responseObserved) {
      rejectResponse(
        new Error("packaged vellum station-stdio closed before its response"),
      );
    }
  });
  const timeout = setTimeout(
    () =>
      rejectResponse(
        new Error("packaged vellum station-stdio status response timed out"),
      ),
    options.timeoutMs ?? 15_000,
  );
  timeout.unref();

  try {
    lease.io.stdin.write(
      `${JSON.stringify({
        protocol: STATION_SESSION_PROTOCOL,
        frame: "request",
        requestId: PACKAGED_STATION_STATUS_REQUEST_ID,
        request: {
          protocol: STATION_API_PROTOCOL,
          op: "status",
        },
      })}\n`,
    );
    await response;
    const status = parsePackagedStationStatus(stdout);
    lease.io.stdin.end();
    const terminal = await lifecycle.waitForClose(
      options.timeoutMs ?? 15_000,
    );
    if (
      terminal.error !== undefined ||
      terminal.code !== 0 ||
      terminal.signal !== null ||
      stderr.trim().length > 0
    ) {
      throw new Error(
        "packaged vellum station-stdio did not complete its owner-local handoff",
      );
    }
    parsePackagedStationStatus(stdout);
    return status;
  } catch (error) {
    lease.io.stdin.end();
    await terminateSpawnedRuntime(
      processPlane,
      lifecycle,
      lease,
      options.timeoutMs ?? 15_000,
    ).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timeout);
    lease.io.stdout.off("data", onStdout);
    lease.io.stderr.off("data", onStderr);
    removeErrorListener();
    removeCloseListener();
  }
};

const currentProcessRows = (): ReadonlyArray<ProcessRow> => {
  const result = runFixed(
    "/bin/ps",
    ["-axo", "pid=,ppid=,command="],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error("ps failed during packaged runtime smoke");
  return parseProcessRows(result.stdout);
};

const preflightRuntime = (requestedAppPath: string): void => {
  assertNoLiveVellumRuntime(currentProcessRows(), [
    "/Applications/Vellum Command.app",
    requestedAppPath,
  ]);
  const launchAgent = runFixed("/bin/launchctl", [
    "print",
    `gui/${String(currentUid())}/skastr0.vellumcommand`,
  ]);
  if (launchAgent.status === 0) {
    throw new Error("the Vellum Command LaunchAgent is loaded; unload it before packaged smoke");
  }
};

type TreeSnapshot = ReadonlyMap<string, string>;

const snapshotTree = async (root: string): Promise<TreeSnapshot> => {
  const snapshot = new Map<string, string>();
  const walk = async (current: string, relative: string): Promise<void> => {
    let metadata;
    try {
      metadata = await lstat(current, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && relative === ".") {
        snapshot.set(".", "absent");
        return;
      }
      throw error;
    }
    snapshot.set(
      relative,
      [
        metadata.mode.toString(),
        metadata.uid.toString(),
        metadata.gid.toString(),
        metadata.size.toString(),
        metadata.mtimeNs.toString(),
        metadata.ctimeNs.toString(),
      ].join(":"),
    );
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
    const entries = await readdir(current);
    entries.sort();
    for (const name of entries) {
      await walk(path.join(current, name), relative === "." ? name : `${relative}/${name}`);
    }
  };
  await walk(root, ".");
  return snapshot;
};

const sameSnapshot = (left: TreeSnapshot, right: TreeSnapshot): boolean => {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
};

const watchTree = (root: string, onEvent: () => void): FSWatcher | undefined => {
  try {
    const watcher = watch(root, { recursive: true, persistent: false }, onEvent);
    watcher.on("error", onEvent);
    return watcher;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitUntil = async (
  stage: "process roles" | "shutdown cleanup",
  timeoutMs: number,
  check: () => boolean | Promise<boolean>,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`packaged runtime smoke timed out during ${stage}`);
};

const pathExists = async (targetPath: string): Promise<boolean> =>
  lstat(targetPath).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

const drainBounded = (
  io: Pick<AppChildIo, "stdout" | "stderr">,
): {
  readonly overflowed: () => boolean;
  readonly startupMarker: () => "browser-security" | "initialization" | "none";
} => {
  let bytes = 0;
  let tail = "";
  let marker: "browser-security" | "initialization" | "none" = "none";
  const consume = (chunk: Buffer | string): void => {
    bytes += Buffer.byteLength(chunk);
    tail = `${tail}${String(chunk)}`.slice(-1_024);
    if (tail.includes("browser security initialization failed; browser startup blocked")) {
      marker = "browser-security";
    } else if (tail.includes("[startup] initialization failed")) {
      marker = "initialization";
    }
  };
  io.stdout.on("data", consume);
  io.stderr.on("data", consume);
  return {
    overflowed: () => bytes > CHILD_OUTPUT_LIMIT_BYTES,
    startupMarker: () => marker,
  };
};

export interface SpawnedRuntimeTerminal {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error: Error | undefined;
}

export interface SpawnedRuntimeLifecycle {
  readonly error: () => Error | undefined;
  readonly terminal: () => SpawnedRuntimeTerminal | undefined;
  readonly waitForClose: (timeoutMs: number) => Promise<SpawnedRuntimeTerminal>;
}

/** Install immediately after spawn. An `error` is diagnostic, not proof that
 * the process is gone: only `close` proves the child and its stdio are done. */
export const observeSpawnedRuntimeLease = (
  lease: AppProcessLease,
): SpawnedRuntimeLifecycle => {
  let recordedError: Error | undefined;
  let observedTerminal: SpawnedRuntimeTerminal | undefined;
  const onError = (error: Error): void => {
    recordedError = error;
  };
  const removeErrorListener = lease.io.onError(onError);
  lease.io.onClose(({ code, signal }) => {
    observedTerminal = { code, signal, error: recordedError };
    removeErrorListener();
  });

  const waitForClose = (timeoutMs: number): Promise<SpawnedRuntimeTerminal> => {
    if (observedTerminal !== undefined) return Promise.resolve(observedTerminal);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("packaged Vellum Command did not close inside the shutdown bound"));
      }, timeoutMs);
      void lease.io.closed.then(({ code, signal }) => {
        clearTimeout(timer);
        const terminal = observedTerminal ?? { code, signal, error: recordedError };
        observedTerminal = terminal;
        removeErrorListener();
        resolve(terminal);
      });
    });
  };

  return {
    error: () => recordedError,
    terminal: () => observedTerminal,
    waitForClose,
  };
};

export const terminateSpawnedRuntime = async (
  processPlane: AppProcessPlane,
  lifecycle: SpawnedRuntimeLifecycle,
  lease: AppProcessLease,
  shutdownTimeoutMs: number = SHUTDOWN_TIMEOUT_MS,
): Promise<void> => {
  if (lifecycle.terminal() === undefined) {
    const graceful = processPlane.terminate(lease, "packaged-smoke-normal-shutdown");
    if (!graceful.attempted) {
      try {
        await lifecycle.waitForClose(shutdownTimeoutMs);
        return;
      } catch {
        throw new Error("packaged Vellum Command cleanup could not signal its owned process");
      }
    }
  }
  try {
    await lifecycle.waitForClose(shutdownTimeoutMs);
  } catch {
    const forced = processPlane.forceTerminate(lease, "packaged-smoke-shutdown-timeout");
    const expectedVia = lease.mode === "group" ? "process.kill-group" : "child.kill";
    if (!forced.attempted || forced.via !== expectedVia) {
      throw new Error(
        lease.mode === "group"
          ? "packaged Vellum Command cleanup refused an unverified forced group signal"
          : "packaged Vellum Command cleanup could not force its exact child handle",
      );
    }
    await lifecycle.waitForClose(shutdownTimeoutMs);
  }
};

export type PackagedRuntimeSandboxProof =
  | {
      readonly clean: true;
      readonly groupAdmission: "verified";
      readonly descendants: "proven-gone";
    }
  | {
      readonly clean: false;
      readonly reason: "group-admission-refused";
      readonly groupAdmission: "refused";
      readonly descendants: "unproven";
    }
  | {
      readonly clean: false;
      readonly reason: "descendants-unproven";
      readonly groupAdmission: "verified";
      readonly descendants: "unproven";
    };

export interface PackagedRuntimeSandboxFinalization {
  readonly proof: PackagedRuntimeSandboxProof;
  readonly drain: AppProcessDrainResult;
  readonly tempRootRemoved: boolean;
}

const uncleanSandboxProof = (
  groupAdmissionVerified: boolean,
): Exclude<PackagedRuntimeSandboxProof, { readonly clean: true }> =>
  groupAdmissionVerified
    ? {
        clean: false,
        reason: "descendants-unproven",
        groupAdmission: "verified",
        descendants: "unproven",
      }
    : {
        clean: false,
        reason: "group-admission-refused",
        groupAdmission: "refused",
        descendants: "unproven",
      };

const closeSmokeIo = (lease: AppProcessLease | undefined): void => {
  if (lease === undefined) return;
  // An unclean receipt deliberately retains the sandbox and the central
  // straggler. Closing only this CLI's pipe endpoints prevents inherited stdio
  // from pinning the smoke runner forever; it does not retire or signal the
  // process-plane record.
  for (const stream of [lease.io.stdin, lease.io.stdout, lease.io.stderr]) {
    try {
      stream.destroy();
    } catch {
      // Cleanup remains fail-closed even when a stream wrapper misbehaves.
    }
  }
};

export const finalizePackagedRuntimeSandbox = async (
  processPlane: AppProcessPlane,
  lease: AppProcessLease | undefined,
  tempRoot: string,
): Promise<PackagedRuntimeSandboxFinalization> => {
  // A child-mode fallback can prove that the Electron root closed, but it
  // cannot prove that helpers which escaped the root are gone. Keep admission
  // proof independent from the central drain receipt so root closure alone can
  // never authorize sandbox deletion.
  const groupAdmissionVerified = lease?.mode === "group";
  processPlane.beginShutdown();
  let drain: AppProcessDrainResult;
  try {
    drain = await processPlane.drainOnQuit();
  } catch (error) {
    closeSmokeIo(lease);
    throw new Error(
      `packaged runtime process drain failed; isolated sandbox retained at ${tempRoot}`,
      { cause: error },
    );
  }
  if (!drain.clean) {
    closeSmokeIo(lease);
    return {
      proof: uncleanSandboxProof(groupAdmissionVerified),
      drain,
      tempRootRemoved: false,
    };
  }
  if (!groupAdmissionVerified) {
    closeSmokeIo(lease);
    return {
      proof: uncleanSandboxProof(false),
      drain,
      tempRootRemoved: false,
    };
  }
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 2 });
  const tempRootRemoved = await lstat(tempRoot).then(
    () => false,
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  return {
    proof: {
      clean: true,
      groupAdmission: "verified",
      descendants: "proven-gone",
    },
    drain,
    tempRootRemoved,
  };
};

const ensureDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
};

export interface PackagedRuntimeSmokeReceipt {
  readonly ok: true;
  readonly admission: "license-required";
  readonly bundledClis: "present";
  readonly protectedControls: "absent";
  readonly processRoles: ReadonlyArray<string>;
  readonly tcpListeners: 0;
  readonly debugAuthority: false;
  readonly exitCode: 0;
  readonly realRootsUntouched: true;
  readonly tempRootRemoved: true;
}

export const smokePackagedRuntime = async (
  requestedAppPath: string,
): Promise<PackagedRuntimeSmokeReceipt> => {
  if (process.platform !== "darwin") {
    throw new Error("packaged runtime smoke is supported only on macOS");
  }
  const appPath = await realpath(path.resolve(requestedAppPath));
  if (path.basename(appPath) !== "Vellum Command.app") {
    throw new Error("packaged runtime smoke requires Vellum Command.app");
  }
  preflightRuntime(appPath);
  const executable = path.join(appPath, "Contents", "MacOS", "Vellum Command");
  const packagedCli = path.join(appPath, "Contents", "Resources", "bin", "vellum");
  await Promise.all([stat(executable), stat(packagedCli)]);

  const realHome = homedir();
  const realRoots = [
    path.join(realHome, ".vellum", "browser"),
    path.join(realHome, ".vellum", "canvases"),
  ];
  const beforeSnapshots = await Promise.all(realRoots.map(snapshotTree));
  let realRootEvents = 0;
  const watchers = realRoots
    .map((root) => watchTree(root, () => {
      realRootEvents += 1;
    }))
    .filter((watcher): watcher is FSWatcher => watcher !== undefined);

  // `os.tmpdir()` expands to a long /var/folders/... path on macOS and can
  // overflow sockaddr_un before the browser control server binds. Canonical
  // /private/tmp keeps the isolated, random root well inside the kernel limit.
  const shortTempParent = await realpath("/tmp");
  const tempRoot = await mkdtemp(path.join(shortTempParent, "vellum-smoke-"));
  await chmod(tempRoot, 0o700);
  const isolatedHome = path.join(tempRoot, "home");
  const userData = path.join(tempRoot, "user-data");
  const canvases = path.join(tempRoot, "canvases");
  const isolatedTmp = path.join(tempRoot, "tmp");
  const cache = path.join(tempRoot, "cache");
  assertDarwinUnixSocketPathFits(controlSocketPath(isolatedHome));
  await Promise.all(
    [isolatedHome, userData, canvases, isolatedTmp, cache].map(ensureDirectory),
  );

  const childEnvironment: NodeJS.ProcessEnv = {
    HOME: isolatedHome,
    USER: process.env.USER ?? "vellum-smoke",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "vellum-smoke",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: isolatedTmp,
    LANG: "en_US.UTF-8",
    XDG_CACHE_HOME: cache,
    VELLUM_BROWSER_HOME: isolatedHome,
    VELLUM_CANVASES_DIR: canvases,
  };

  const processPlane = createAppProcessPlane();
  let runtimeLease: AppProcessLease | undefined;
  let knownRows: ReadonlyArray<ProcessRow> = [];
  let success: Omit<PackagedRuntimeSmokeReceipt, "tempRootRemoved"> | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  let watchdogFailure: string | undefined;
  let primaryFailure: unknown;
  let failed = false;
  let finalization: PackagedRuntimeSandboxFinalization | undefined;

  try {
    const launched = processPlane.spawnGroup({
      source: "packaged-runtime-smoke",
      purpose: "verify packaged Vellum Command runtime",
      command: executable,
      args: [`--user-data-dir=${userData}`],
      cwd: tempRoot,
      env: childEnvironment,
      shell: false,
      gracefulSignalScope: "leader",
    });
    runtimeLease = launched;
    const lifecycle = observeSpawnedRuntimeLease(launched);
    launched.io.stdin.end();
    if (launched.mode !== "group") {
      const childError = lifecycle.error();
      throw new Error(
        `packaged runtime smoke requires a verified detached process-group capability${childError === undefined ? "" : ` (${childError.message})`}`,
      );
    }
    watchdog = setTimeout(() => {
      if (lifecycle.terminal() !== undefined) return;
      const forced = processPlane.forceTerminate(
        launched,
        "packaged-smoke-global-timeout",
      );
      watchdogFailure =
        forced.attempted && forced.via === "process.kill-group"
          ? "packaged runtime smoke exceeded its global timeout"
          : "packaged runtime smoke global timeout refused an unverified group signal";
    }, SMOKE_TIMEOUT_MS);
    const output = drainBounded(launched.io);
    const rootPid = launched.io.pidForDiagnostics;
    if (rootPid === undefined) throw new Error("packaged Vellum Command did not produce a process id");
    const controlHome = isolatedHome;

    let runtimeRows: ReadonlyArray<ProcessRow> = [];
    await waitUntil("process roles", STARTUP_TIMEOUT_MS, () => {
      const terminal = lifecycle.terminal();
      if (terminal !== undefined) {
        throw new Error(
          `packaged Vellum Command closed before process roles (code=${String(terminal.code)}, signal=${String(terminal.signal)}, error=${terminal.error?.message ?? "none"})`,
        );
      }
      runtimeRows = descendantRows(rootPid, currentProcessRows());
      const roles = processRoles(rootPid, runtimeRows);
      return REQUIRED_PROCESS_ROLES.every((role) => roles.includes(role));
    });

    await delay(250);
    const protectedControlPaths = [
      controlTokenPath(controlHome),
      controlSocketPath(controlHome),
      stationControlSocketPath(stationControlDir(controlHome)),
    ];
    const exposedProtectedControls = (
      await Promise.all(protectedControlPaths.map(pathExists))
    ).some(Boolean);
    if (exposedProtectedControls) {
      throw new Error(
        "fresh unlicensed Vellum Command exposed protected product controls",
      );
    }
    const terminalAfterAdmission = lifecycle.terminal();
    if (terminalAfterAdmission !== undefined) {
      throw new Error(
        `packaged Vellum Command closed at the license boundary (code=${String(terminalAfterAdmission.code)}, signal=${String(terminalAfterAdmission.signal)}, error=${terminalAfterAdmission.error?.message ?? "none"}, phase=${output.startupMarker()})`,
      );
    }
    if (hasDebugAuthority(runtimeRows)) {
      throw new Error("packaged Vellum Command descendants exposed debugger authority");
    }
    knownRows = runtimeRows;
    const knownPids = knownRows.map((row) => row.pid);

    const listeners = runFixed("/usr/sbin/lsof", [
      "-nP",
      "-a",
      "-p",
      knownPids.join(","),
      "-iTCP",
      "-sTCP:LISTEN",
    ]);
    assertNoTcpListeners(listeners.status, listeners.stdout);
    if (output.overflowed()) {
      throw new Error("packaged Vellum Command exceeded the bounded smoke output budget");
    }

    if (watchdogFailure !== undefined) throw new Error(watchdogFailure);
    const shutdownSignal = processPlane.terminate(
      launched,
      "packaged-smoke-normal-shutdown",
    );
    if (!shutdownSignal.attempted || shutdownSignal.via !== "child.kill") {
      throw new Error("packaged Vellum Command normal shutdown lost exact leader authority");
    }
    const exited = await lifecycle.waitForClose(SHUTDOWN_TIMEOUT_MS);
    if (exited.error !== undefined) {
      throw new Error(`packaged Vellum Command reported a child lifecycle error: ${exited.error.message}`);
    }
    if (exited.code !== 0 || exited.signal !== null) {
      throw new Error(
        `packaged Vellum Command did not complete its normal SIGTERM contract (code=${String(exited.code)}, signal=${String(exited.signal)})`,
      );
    }
    let shutdownSocketGone = false;
    let shutdownAliveCount = knownRows.length;
    let shutdownSurvivorKinds: ReadonlyArray<string> = [];
    try {
      await waitUntil("shutdown cleanup", SHUTDOWN_TIMEOUT_MS, async () => {
        shutdownSocketGone = (
          await Promise.all([
            controlSocketPath(controlHome),
            stationControlSocketPath(stationControlDir(controlHome)),
          ].map((socketPath) =>
            lstat(socketPath).then(
              () => false,
              (error: NodeJS.ErrnoException) => error.code === "ENOENT",
            )
          ))
        ).every(Boolean);
        const survivors = survivingProcessRows(
          knownRows,
          currentProcessRows(),
        );
        shutdownAliveCount = survivors.length;
        shutdownSurvivorKinds = survivors.map((row) =>
          row.pid === rootPid
            ? "main"
            : processRole(row, rootPid) ??
              (row.command.includes("chrome_crashpad_handler")
                ? "crashpad"
                : boundedProcessKind(row.command)),
        );
        return shutdownSocketGone && shutdownAliveCount === 0;
      });
    } catch {
      throw new Error(
        `packaged runtime shutdown cleanup failed (socketGone=${String(shutdownSocketGone)}, aliveDescendants=${shutdownAliveCount}, survivorKinds=${shutdownSurvivorKinds.join(",") || "none"})`,
      );
    }

    await delay(150);
    const afterSnapshots = await Promise.all(realRoots.map(snapshotTree));
    if (
      realRootEvents !== 0 ||
      beforeSnapshots.some((snapshot, index) => !sameSnapshot(snapshot, afterSnapshots[index]))
    ) {
      throw new Error("packaged runtime smoke changed a real Vellum Command root");
    }

    success = {
      ok: true,
      admission: "license-required",
      bundledClis: "present",
      protectedControls: "absent",
      processRoles: processRoles(rootPid, runtimeRows),
      tcpListeners: 0,
      debugAuthority: false,
      exitCode: 0,
      realRootsUntouched: true,
    };
  } catch (error) {
    failed = true;
    primaryFailure = error;
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
    for (const watcher of watchers) watcher.close();
    finalization = await finalizePackagedRuntimeSandbox(
      processPlane,
      runtimeLease,
      tempRoot,
    );
  }

  if (finalization.proof.clean === false) {
    const summary = finalization.drain.clean
      ? "root-clean-descendants-unproven"
      : finalization.drain.stragglers
          .map((straggler) => `${straggler.purpose}:${straggler.state}`)
          .join(",");
    throw new Error(
      `packaged runtime cleanup remained unclean (${finalization.proof.reason}/descendants-${finalization.proof.descendants}; ${summary || "unknown"}); isolated sandbox retained at ${tempRoot}`,
      { cause: failed ? primaryFailure : undefined },
    );
  }
  if (!finalization.tempRootRemoved) {
    throw new Error("packaged runtime smoke temp root survived verified cleanup");
  }
  if (failed) throw primaryFailure;
  if (success === undefined) throw new Error("packaged runtime smoke did not complete");
  return { ...success, tempRootRemoved: true };
};

const modulePath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invokedPath === modulePath) {
  const requestedPath = process.argv[2];
  if (requestedPath === undefined || process.argv.length !== 3) {
    console.error("usage: bun scripts/packaged-runtime-smoke.ts /path/to/Vellum Command.app");
    process.exitCode = 2;
  } else {
    smokePackagedRuntime(requestedPath)
      .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
      .catch((error: unknown) => {
        const rawMessage = error instanceof Error ? error.message : String(error);
        const sanitized = rawMessage
          .replaceAll(homedir(), "<real-home>")
          .slice(0, 1_000);
        // An unclean detached runtime intentionally remains registered and its
        // sandbox remains on disk. Its process handle must not turn this
        // bounded verifier into an indefinitely hanging CLI, so synchronously
        // publish the receipt and terminate only this smoke-runner process.
        try {
          writeSync(
            process.stderr.fd,
            `vellum packaged runtime smoke failed: ${sanitized}\n`,
          );
        } finally {
          process.exit(1);
        }
      });
  }
}
