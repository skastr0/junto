import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  controlDir,
  controlSocketPath,
  controlTokenPath,
} from "../src/shared/browser-control";

const SMOKE_TIMEOUT_MS = 45_000;
const STARTUP_TIMEOUT_MS = 25_000;
const SHUTDOWN_TIMEOUT_MS = 7_000;
const CHILD_OUTPUT_LIMIT_BYTES = 64 * 1024;
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
    "tower",
    "quasar",
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
    throw new Error("packaged vellum-browser returned non-JSON doctor output");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "data,ok" ||
    (value as { ok?: unknown }).ok !== true
  ) {
    throw new Error("packaged vellum-browser returned the wrong doctor envelope");
  }
  const data = (value as { data?: unknown }).data;
  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    Object.keys(data).join(",") !== "status" ||
    (data as { status?: unknown }).status !== "ok"
  ) {
    throw new Error("packaged vellum-browser returned the wrong doctor payload");
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
    throw new Error("packaged Vellum descendants exposed a TCP listener");
  }
};

const runFixed = (
  executable: string,
  args: ReadonlyArray<string>,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly timeout?: number;
    readonly maxBuffer?: number;
  } = {},
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } => {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    shell: false,
    timeout: options.timeout ?? 10_000,
    maxBuffer: options.maxBuffer ?? 256 * 1024,
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
    `gui/${String(currentUid())}/skastr0.vellum`,
  ]);
  if (launchAgent.status === 0) {
    throw new Error("the Vellum LaunchAgent is loaded; unload it before packaged smoke");
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
  stage: "control startup" | "process roles" | "shutdown cleanup",
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
  child: ChildProcessWithoutNullStreams,
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
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
  return {
    overflowed: () => bytes > CHILD_OUTPUT_LIMIT_BYTES,
    startupMarker: () => marker,
  };
};

const waitForExit = (
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> =>
  new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("packaged Vellum did not exit inside the shutdown bound"));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      resolve({ code, signal });
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });

const terminateSpawnedRuntime = async (
  child: ChildProcessWithoutNullStreams,
  knownRows: ReadonlyArray<ProcessRow>,
): Promise<void> => {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  try {
    await waitForExit(child, SHUTDOWN_TIMEOUT_MS);
  } catch {
    const survivors = survivingProcessRows(knownRows, currentProcessRows());
    for (const row of survivors) {
      try {
        process.kill(row.pid, "SIGKILL");
      } catch {
        // The bounded canary process may have exited between the liveness check and kill.
      }
    }
  }
};

const requireOwnerMode = async (
  targetPath: string,
  expectedMode: "0700" | "0600",
  kind: "directory" | "file" | "socket",
): Promise<void> => {
  const metadata = await lstat(targetPath);
  const matchesKind =
    kind === "directory"
      ? metadata.isDirectory()
      : kind === "file"
        ? metadata.isFile()
        : metadata.isSocket();
  if (
    !matchesKind ||
    metadata.uid !== currentUid() ||
    modeString(metadata.mode) !== expectedMode
  ) {
    throw new Error(`packaged control ${kind} ownership or mode mismatch`);
  }
};

const ensureDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
};

export interface PackagedRuntimeSmokeReceipt {
  readonly ok: true;
  readonly doctor: "ok";
  readonly processRoles: ReadonlyArray<string>;
  readonly tcpListeners: 0;
  readonly debugAuthority: false;
  readonly directoryMode: "0700";
  readonly tokenMode: "0600";
  readonly socketMode: "0600";
  readonly exitCode: 0;
  readonly socketRemoved: true;
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
  const browserCli = path.join(appPath, "Contents", "Resources", "bin", "vellum-browser");
  await Promise.all([stat(executable), stat(browserCli)]);

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

  let child: ChildProcessWithoutNullStreams | undefined;
  let knownRows: ReadonlyArray<ProcessRow> = [];
  let success: Omit<PackagedRuntimeSmokeReceipt, "tempRootRemoved"> | undefined;
  const watchdog = setTimeout(() => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }, SMOKE_TIMEOUT_MS);

  try {
    const spawned = spawn(executable, [`--user-data-dir=${userData}`], {
      cwd: tempRoot,
      env: childEnvironment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    spawned.stdin.end();
    child = spawned;
    const output = drainBounded(spawned);
    if (spawned.pid === undefined) throw new Error("packaged Vellum did not produce a process id");
    const rootPid = spawned.pid;
    const controlHome = isolatedHome;

    await waitUntil("control startup", STARTUP_TIMEOUT_MS, async () => {
      if (spawned.exitCode !== null || spawned.signalCode !== null) {
        const [registryCreated, tokenCreated, socketCreated] = await Promise.all([
          pathExists(path.join(controlDir(controlHome), "config.json")),
          pathExists(controlTokenPath(controlHome)),
          pathExists(controlSocketPath(controlHome)),
        ]);
        throw new Error(
          `packaged Vellum exited before control startup (code=${String(spawned.exitCode)}, signal=${String(spawned.signalCode)}, phase=${output.startupMarker()}, registry=${String(registryCreated)}, token=${String(tokenCreated)}, socket=${String(socketCreated)})`,
        );
      }
      try {
        await Promise.all([
          requireOwnerMode(controlDir(controlHome), "0700", "directory"),
          requireOwnerMode(controlTokenPath(controlHome), "0600", "file"),
          requireOwnerMode(controlSocketPath(controlHome), "0600", "socket"),
        ]);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    });

    const token = (await readFile(controlTokenPath(controlHome), "utf8")).trim();
    if (!/^[0-9a-f]{64}$/u.test(token)) {
      throw new Error("packaged control token has the wrong opaque format");
    }

    const doctor = runFixed(browserCli, ["doctor", "--json"], {
      env: childEnvironment,
      timeout: 15_000,
    });
    if (doctor.status !== 0) {
      throw new Error("packaged vellum-browser doctor failed");
    }
    parseDoctorReceipt(doctor.stdout.trim());

    let runtimeRows: ReadonlyArray<ProcessRow> = [];
    await waitUntil("process roles", STARTUP_TIMEOUT_MS, () => {
      runtimeRows = descendantRows(rootPid, currentProcessRows());
      const roles = processRoles(rootPid, runtimeRows);
      return REQUIRED_PROCESS_ROLES.every((role) => roles.includes(role));
    });
    if (hasDebugAuthority(runtimeRows)) {
      throw new Error("packaged Vellum descendants exposed debugger authority");
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
      throw new Error("packaged Vellum exceeded the bounded smoke output budget");
    }

    spawned.kill("SIGTERM");
    const exited = await waitForExit(spawned, SHUTDOWN_TIMEOUT_MS);
    if (exited.code !== 0 || exited.signal !== null) {
      throw new Error("packaged Vellum did not complete its normal SIGTERM contract");
    }
    let shutdownSocketGone = false;
    let shutdownAliveCount = knownRows.length;
    let shutdownSurvivorKinds: ReadonlyArray<string> = [];
    try {
      await waitUntil("shutdown cleanup", SHUTDOWN_TIMEOUT_MS, async () => {
        shutdownSocketGone = await lstat(controlSocketPath(controlHome)).then(
          () => false,
          (error: NodeJS.ErrnoException) => error.code === "ENOENT",
        );
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
      throw new Error("packaged runtime smoke changed a real Vellum root");
    }

    success = {
      ok: true,
      doctor: "ok",
      processRoles: processRoles(rootPid, runtimeRows),
      tcpListeners: 0,
      debugAuthority: false,
      directoryMode: "0700",
      tokenMode: "0600",
      socketMode: "0600",
      exitCode: 0,
      socketRemoved: true,
      realRootsUntouched: true,
    };
  } finally {
    clearTimeout(watchdog);
    for (const watcher of watchers) watcher.close();
    if (child !== undefined) await terminateSpawnedRuntime(child, knownRows);
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 2 });
  }

  if (success === undefined) throw new Error("packaged runtime smoke did not complete");
  const tempRootRemoved = await lstat(tempRoot).then(
    () => false,
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  if (!tempRootRemoved) throw new Error("packaged runtime smoke temp root survived cleanup");
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
        console.error(`vellum packaged runtime smoke failed: ${sanitized}`);
        process.exitCode = 1;
      });
  }
}
