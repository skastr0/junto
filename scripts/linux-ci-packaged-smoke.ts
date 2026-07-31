import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  controlSocketPath,
  controlTokenPath,
} from "../src/shared/browser-control";
import {
  stationControlDir,
  stationControlSocketPath,
} from "../src/shared/station-ssh-control";
import {
  createAppProcessPlane,
  type AppProcessLease,
} from "../src/main/vellum/app-process-plane";
import {
  assertNoTcpListeners,
  descendantRows,
  finalizePackagedRuntimeSandbox,
  hasDebugAuthority,
  observeSpawnedRuntimeLease,
  parseDoctorReceipt,
  parseProcessRows,
  processRoles,
  survivingProcessRows,
  terminateSpawnedRuntime,
  verifyPackagedStationOwnerLocalHandoff,
  type ProcessRow,
} from "./packaged-runtime-smoke";
import { findSecretBearingOutput } from "./linux-ci-evidence";

const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const OUTPUT_LIMIT_BYTES = 64 * 1024;

interface ProcSandboxStatus {
  readonly noNewPrivs: 1;
  readonly seccomp: 2;
  readonly seccompFilters: number;
}

export type LinuxSandboxCapability = "apparmor" | "userns";

export interface LinuxCiPackagedSmokeReceipt {
  readonly ok: true;
  readonly display: "xvfb";
  readonly workCli: "ok";
  readonly browserCli: "ok";
  readonly stationCli: "ok";
  readonly browserRemoteModes: "absent";
  readonly processRoles: ReadonlyArray<string>;
  readonly rendererSandbox: {
    readonly renderers: number;
    readonly noNewPrivs: true;
    readonly seccomp: true;
  };
  readonly sandboxCapability: LinuxSandboxCapability;
  readonly tcpListeners: 0;
  readonly debugAuthority: false;
  readonly secretBearingOutput: false;
  readonly exitCode: 0;
  readonly cleanShutdown: true;
  readonly tempRootRemoved: true;
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitUntil = async (
  stage: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs: number = STARTUP_TIMEOUT_MS,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Linux packaged runtime smoke timed out during ${stage}`);
};

const isExecutable = async (candidate: string): Promise<boolean> => {
  try {
    const metadata = await stat(candidate);
    if (!metadata.isFile()) return false;
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const requireXvfbDisplay = (
  display: string | undefined,
): string => {
  if (display === undefined || !/^:[0-9]+(?:\.[0-9]+)?$/u.test(display)) {
    throw new Error("Linux packaged runtime smoke requires an Xvfb DISPLAY");
  }
  return display;
};

export const parseProcSandboxStatus = (input: string): ProcSandboxStatus => {
  const fields = new Map<string, string>();
  for (const line of input.split(/\r?\n/u)) {
    const match = line.match(/^([A-Za-z_]+):\s*(.+)$/u);
    if (match !== null) fields.set(match[1], match[2].trim());
  }
  const noNewPrivs = Number(fields.get("NoNewPrivs"));
  const seccomp = Number(fields.get("Seccomp"));
  const seccompFilters = Number(fields.get("Seccomp_filters"));
  if (
    noNewPrivs !== 1 ||
    seccomp !== 2 ||
    !Number.isSafeInteger(seccompFilters) ||
    seccompFilters < 1
  ) {
    throw new Error(
      "packaged renderer is missing Chromium no-new-privileges/seccomp sandboxing",
    );
  }
  return {
    noNewPrivs: 1,
    seccomp: 2,
    seccompFilters,
  };
};

const hasSandboxDisablingSwitch = (command: string): boolean =>
  /(?:^|\s)--(?:no-sandbox|disable-setuid-sandbox)(?:=|\s|$)/u.test(command);

export const auditSandboxedRenderers = async (
  rows: ReadonlyArray<ProcessRow>,
  readStatus: (pid: number) => Promise<string>,
): Promise<{
  readonly renderers: number;
  readonly noNewPrivs: true;
  readonly seccomp: true;
}> => {
  if (rows.some((row) => hasSandboxDisablingSwitch(row.command))) {
    throw new Error("packaged Chromium sandbox was disabled by a process switch");
  }
  const renderers = rows.filter((row) =>
    /(?:^|\s)--type=renderer(?:=|\s|$)/u.test(row.command),
  );
  if (renderers.length === 0) {
    throw new Error("packaged Vellum Command did not start a renderer");
  }
  await Promise.all(
    renderers.map(async (renderer) => {
      parseProcSandboxStatus(await readStatus(renderer.pid));
    }),
  );
  return {
    renderers: renderers.length,
    noNewPrivs: true,
    seccomp: true,
  };
};

export const validateLinuxSandboxCapability = (input: {
  readonly appArmorEnabled: string | undefined;
  readonly appArmorSecurityPresent: boolean;
  readonly appArmorCurrent: string | undefined;
}): LinuxSandboxCapability => {
  if (input.appArmorEnabled !== undefined) {
    if (input.appArmorEnabled.trim().toUpperCase() !== "Y") {
      throw new Error("AppArmor is present but not enabled on the Linux release worker");
    }
    if (
      input.appArmorCurrent === undefined ||
      !/^vellum(?:\s|\(|$)/u.test(input.appArmorCurrent.trim())
    ) {
      throw new Error("packaged Vellum Command did not enter its installed AppArmor profile");
    }
    return "apparmor";
  }
  if (input.appArmorSecurityPresent) {
    throw new Error("AppArmor kernel state is incomplete on the Linux release worker");
  }
  return "userns";
};

export const parseWorkCliSchemaReceipt = (input: string): void => {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("packaged work CLI returned non-JSON output");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { ok?: unknown }).ok !== true
  ) {
    throw new Error("packaged work CLI returned a failed envelope");
  }
  const data = (value as { data?: unknown }).data;
  if (
    typeof data !== "object" ||
    data === null ||
    !Array.isArray((data as { schemas?: unknown }).schemas) ||
    (data as { schemas: unknown[] }).schemas.length === 0
  ) {
    throw new Error("packaged work CLI schema inventory is missing");
  }
};

interface FixedResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const runFixed = (
  executable: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
  input?: string,
): FixedResult => {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    shell: false,
    timeout: 20_000,
    maxBuffer: 512 * 1024,
    ...(input === undefined ? {} : { input }),
    ...(env === undefined ? {} : { env }),
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
  const result = runFixed("/bin/ps", ["-axo", "pid=,ppid=,command="]);
  if (result.status !== 0) {
    throw new Error("ps failed during Linux packaged runtime smoke");
  }
  return parseProcessRows(result.stdout);
};

const ensureDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
};

const pathExists = async (candidate: string): Promise<boolean> =>
  lstat(candidate).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

const readOptionalFile = async (candidate: string): Promise<string | undefined> =>
  readFile(candidate, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });

const boundedOutput = (lease: AppProcessLease): {
  readonly value: () => string;
  readonly overflowed: () => boolean;
} => {
  let bytes = 0;
  let value = "";
  const consume = (chunk: Buffer | string): void => {
    const text = String(chunk);
    bytes += Buffer.byteLength(text);
    if (bytes <= OUTPUT_LIMIT_BYTES) value += text;
  };
  lease.io.stdout.on("data", consume);
  lease.io.stderr.on("data", consume);
  return {
    value: () => value,
    overflowed: () => bytes > OUTPUT_LIMIT_BYTES,
  };
};

const assertNoSecretBearingOutput = (
  outputs: ReadonlyArray<string>,
): void => {
  if (outputs.some(findSecretBearingOutput)) {
    throw new Error("secret-bearing output escaped the packaged runtime smoke");
  }
};

export const smokeLinuxCiPackagedRuntime = async (
  requestedExecutable: string,
): Promise<LinuxCiPackagedSmokeReceipt> => {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Linux packaged runtime smoke requires native Linux x64");
  }
  const display = requireXvfbDisplay(process.env.DISPLAY);
  const executable = await realpath(path.resolve(requestedExecutable));
  if (
    path.basename(executable) !== "vellum" ||
    !(await isExecutable(executable))
  ) {
    throw new Error("Linux packaged runtime smoke requires packaged vellum");
  }
  const installDirectory = path.dirname(executable);
  const resources = await realpath(path.join(installDirectory, "resources"));
  const workCli = path.join(resources, "bin", "vellum");
  const browserCli = path.join(resources, "bin", "vellum-browser");
  const stationCli = path.join(resources, "bin", "vellum-station");
  if (
    !(await isExecutable(workCli)) ||
    !(await isExecutable(browserCli)) ||
    !(await isExecutable(stationCli))
  ) {
    throw new Error("packaged work, browser, or station CLI is missing");
  }

  const tempRoot = await mkdtemp("/tmp/vellum-linux-runtime-smoke-");
  await chmod(tempRoot, 0o700);
  const isolatedHome = path.join(tempRoot, "home");
  const userData = path.join(tempRoot, "user-data");
  const canvases = path.join(tempRoot, "canvases");
  const cache = path.join(tempRoot, "cache");
  const browser = path.join(tempRoot, "browser");
  const isolatedTmp = path.join(tempRoot, "tmp");
  await Promise.all(
    [isolatedHome, userData, canvases, cache, browser, isolatedTmp].map(
      ensureDirectory,
    ),
  );

  const environment: NodeJS.ProcessEnv = {
    DISPLAY: display,
    ...(process.env.XAUTHORITY === undefined
      ? {}
      : { XAUTHORITY: process.env.XAUTHORITY }),
    HOME: isolatedHome,
    USER: process.env.USER ?? "vellum-smoke",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "vellum-smoke",
    PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    SHELL: "/bin/bash",
    TMPDIR: isolatedTmp,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    XDG_CACHE_HOME: cache,
    VELLUM_BROWSER_DIR: browser,
    VELLUM_BROWSER_HOME: isolatedHome,
    VELLUM_CANVASES_DIR: canvases,
    VELLUM_WORK_HOME: path.join(isolatedHome, ".vellum", "work"),
  };

  const processPlane = createAppProcessPlane();
  let runtimeLease: AppProcessLease | undefined;
  let primaryFailure: unknown;
  let success:
    | Omit<LinuxCiPackagedSmokeReceipt, "tempRootRemoved">
    | undefined;

  try {
    runtimeLease = processPlane.spawnGroup({
      source: "linux-ci-packaged-runtime-smoke",
      purpose: "verify installed Linux Vellum Command runtime",
      command: executable,
      args: [`--user-data-dir=${userData}`],
      cwd: tempRoot,
      env: environment,
      shell: false,
      gracefulSignalScope: "leader",
    });
    const lifecycle = observeSpawnedRuntimeLease(runtimeLease);
    runtimeLease.io.stdin.end();
    if (runtimeLease.mode !== "group") {
      throw new Error(
        "Linux packaged runtime smoke requires verified process-group ownership",
      );
    }
    const rootPid = runtimeLease.io.pidForDiagnostics;
    if (rootPid === undefined) {
      throw new Error("packaged Vellum Command did not produce a diagnostic pid");
    }
    const output = boundedOutput(runtimeLease);
    let runtimeRows: ReadonlyArray<ProcessRow> = [];

    await waitUntil("control and renderer startup", async () => {
      const terminal = lifecycle.terminal();
      if (terminal !== undefined) {
        throw new Error(
          `packaged Vellum Command closed during startup (code=${String(terminal.code)}, signal=${String(terminal.signal)})`,
        );
      }
      runtimeRows = descendantRows(rootPid, currentProcessRows());
      const roles = processRoles(rootPid, runtimeRows);
      return (
        (await pathExists(controlSocketPath(isolatedHome))) &&
        (await pathExists(controlTokenPath(isolatedHome))) &&
        (await pathExists(
          stationControlSocketPath(stationControlDir(isolatedHome)),
        )) &&
        roles.includes("renderer")
      );
    });

    if (output.overflowed()) {
      throw new Error("packaged Vellum Command exceeded the smoke output budget");
    }
    if (hasDebugAuthority(runtimeRows)) {
      throw new Error("packaged Vellum Command descendants exposed debug authority");
    }
    const sandbox = await auditSandboxedRenderers(
      runtimeRows,
      (pid) => readFile(`/proc/${String(pid)}/status`, "utf8"),
    );
    const sandboxCapability = validateLinuxSandboxCapability({
      appArmorEnabled: await readOptionalFile(
        "/sys/module/apparmor/parameters/enabled",
      ),
      appArmorSecurityPresent: await pathExists("/sys/kernel/security/apparmor"),
      appArmorCurrent: await readOptionalFile(
        `/proc/${String(rootPid)}/attr/current`,
      ),
    });

    const work = runFixed(workCli, ["schema", "list"], environment);
    if (work.status !== 0) {
      throw new Error("packaged work CLI failed");
    }
    parseWorkCliSchemaReceipt(work.stdout.trim());

    const browserDoctor = runFixed(
      browserCli,
      ["doctor", "--json"],
      environment,
    );
    if (browserDoctor.status !== 0) {
      throw new Error("packaged browser CLI doctor failed");
    }
    parseDoctorReceipt(browserDoctor.stdout.trim());

    for (const argv of [
      ["station"],
      ["station-trust"],
      ["--host", "remote-a", "doctor", "--json"],
    ] as const) {
      const retired = runFixed(browserCli, [...argv], environment);
      if (retired.status !== 2) {
        throw new Error(
          `packaged browser CLI ${argv.join(" ")} did not reject retired remote mode`,
        );
      }
      if (!/remote Station-browser is removed/i.test(retired.stderr)) {
        throw new Error(
          `packaged browser CLI ${argv.join(" ")} missing retirement message`,
        );
      }
    }

    const stationStatus = await verifyPackagedStationOwnerLocalHandoff(
      processPlane,
      stationCli,
      {
        cwd: tempRoot,
        env: environment,
        timeoutMs: 15_000,
      },
    );
    if (
      stationStatus.state !== "unenrolled" ||
      !stationStatus.readiness.database ||
      !stationStatus.readiness.session
    ) {
      throw new Error(
        "packaged station CLI owner-local status was not ready",
      );
    }

    const pids = runtimeRows.map((row) => String(row.pid));
    const listeners = runFixed("/usr/bin/lsof", [
      "-nP",
      "-a",
      "-p",
      pids.join(","),
      "-iTCP",
      "-sTCP:LISTEN",
    ]);
    assertNoTcpListeners(listeners.status, listeners.stdout);
    assertNoSecretBearingOutput([
      output.value(),
      work.stdout,
      work.stderr,
      browserDoctor.stdout,
      browserDoctor.stderr,
      listeners.stdout,
      listeners.stderr,
    ]);

    const shutdown = processPlane.terminate(
      runtimeLease,
      "linux-ci-packaged-runtime-smoke-complete",
    );
    if (!shutdown.attempted || shutdown.via !== "child.kill") {
      throw new Error("packaged Vellum Command shutdown lost exact leader authority");
    }
    const terminal = await lifecycle.waitForClose(SHUTDOWN_TIMEOUT_MS);
    if (
      terminal.error !== undefined ||
      terminal.code !== 0 ||
      terminal.signal !== null
    ) {
      throw new Error(
        `packaged Vellum Command did not complete normal SIGTERM shutdown (code=${String(terminal.code)}, signal=${String(terminal.signal)}, error=${terminal.error?.message ?? "none"})`,
      );
    }
    await waitUntil(
      "descendant and socket cleanup",
      async () =>
        !(await pathExists(controlSocketPath(isolatedHome))) &&
        survivingProcessRows(runtimeRows, currentProcessRows()).length === 0,
      SHUTDOWN_TIMEOUT_MS,
    );

    success = {
      ok: true,
      display: "xvfb",
      workCli: "ok",
      browserCli: "ok",
      stationCli: "ok",
      browserRemoteModes: "absent",
      processRoles: processRoles(rootPid, runtimeRows),
      rendererSandbox: sandbox,
      sandboxCapability,
      tcpListeners: 0,
      debugAuthority: false,
      secretBearingOutput: false,
      exitCode: 0,
      cleanShutdown: true,
    };
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (runtimeLease !== undefined) {
      const lifecycle = observeSpawnedRuntimeLease(runtimeLease);
      await terminateSpawnedRuntime(
        processPlane,
        lifecycle,
        runtimeLease,
        SHUTDOWN_TIMEOUT_MS,
      ).catch((error) => {
        primaryFailure ??= error;
      });
    }
  }

  const finalization = await finalizePackagedRuntimeSandbox(
    processPlane,
    runtimeLease,
    tempRoot,
  );
  if (!finalization.proof.clean || !finalization.tempRootRemoved) {
    throw new Error(
      `Linux packaged runtime cleanup remained unclean (${finalization.proof.clean ? "temp-root-retained" : finalization.proof.reason}); isolated sandbox retained at ${tempRoot}`,
      { cause: primaryFailure },
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (success === undefined) {
    throw new Error("Linux packaged runtime smoke did not complete");
  }
  return { ...success, tempRootRemoved: true };
};

const modulePath = fileURLToPath(import.meta.url);
const invokedPath =
  process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (modulePath === invokedPath) {
  const executable = process.argv[2];
  if (executable === undefined || process.argv.length !== 3) {
    console.error(
      "usage: bun scripts/linux-ci-packaged-smoke.ts /path/to/installed/vellum",
    );
    process.exitCode = 2;
  } else {
    smokeLinuxCiPackagedRuntime(executable)
      .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `vellum Linux packaged runtime smoke failed: ${message.slice(0, 1_000)}`,
        );
        process.exitCode = 1;
      });
  }
}
