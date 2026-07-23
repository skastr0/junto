/**
 * Linux packaged-product PTY smoke.
 *
 * Usage:
 *   bun scripts/linux-packaged-pty-smoke.ts /path/to/resources /path/to/vellum
 *
 * The verifier launches the ordinary packaged executable in headless mode,
 * authenticates to its terminal control socket, and drives the production
 * TermPlane -> LocalSessionHost -> AppProcessPlane -> OwnedProcess path. It
 * never asks Electron to become Node; the packaged RunAsNode fuse stays off.
 * LX-005 invokes this integration point under the target Ubuntu/Xvfb runtime.
 */
import {
  accessSync,
  constants,
  statSync,
  writeSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  termControlSocketPath,
  termControlTokenPath,
} from "../src/shared/term-control";
import type { LocalHostEvent } from "../src/main/vellum/term/local-host";
import { TermControlClient } from "../src/main/vellum/term/control-client";
import {
  createAppProcessPlane,
  type AppProcessLease,
} from "../src/main/vellum/app-process-plane";
import {
  finalizePackagedRuntimeSandbox,
  observeSpawnedRuntimeLease,
  terminateSpawnedRuntime,
  type PackagedRuntimeSandboxFinalization,
  type SpawnedRuntimeLifecycle,
} from "./packaged-runtime-smoke";

const STARTUP_TIMEOUT_MS = 25_000;
const PTY_TIMEOUT_MS = 8_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const CHILD_OUTPUT_LIMIT_BYTES = 64 * 1024;
const PTY_OUTPUT_LIMIT_BYTES = 32 * 1024;
const PROBE_BINDING_ID = "linux-packaged-pty-smoke";

const nodePtyRoot = (resources: string): string =>
  path.join(resources, "app.asar.unpacked", "node_modules", "node-pty");

const isExecutable = (candidate: string): boolean => {
  try {
    const metadata = statSync(candidate);
    if (!metadata.isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const auditLinuxPtyPlacement = (resources: string): {
  readonly nodePtyRoot: string;
  readonly nativeModule: string;
} => {
  const root = path.resolve(nodePtyRoot(resources));
  if (!root.includes("app.asar.unpacked")) {
    throw new Error("node-pty must be unpacked outside app.asar");
  }
  const nativeCandidates = [
    path.join(root, "prebuilds", "linux-x64", "pty.node"),
    path.join(root, "build", "Release", "pty.node"),
  ];
  const nativeModule = nativeCandidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!nativeModule) throw new Error("packaged Linux node-pty binary is missing");
  return { nodePtyRoot: root, nativeModule };
};

export const LINUX_PTY_PROBE_COMMAND =
  "printf '\\nPTY-ECHO:ok\\nUTF8:✓\\nTERM:%s\\nCOLORTERM:%s\\n' \"$TERM\" \"$COLORTERM\"; " +
  "printf 'SIZE:'; stty size | awk '{print $2, $1}'; printf '\\n'; " +
  "if shopt -q login_shell; then printf 'LOGIN:yes\\n'; else printf 'LOGIN:no\\n'; fi; " +
  "exit 23\r";

const EXPECTED_PTY_LINES = [
  "PTY-ECHO:ok",
  "UTF8:✓",
  "TERM:xterm-256color",
  "COLORTERM:truecolor",
  "SIZE:101 41",
  "LOGIN:yes",
] as const;

const normalizePtyLines = (output: string): readonly string[] =>
  output
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replaceAll("\r", "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

export const verifyLinuxPtyProbe = (input: {
  readonly output: string;
  readonly exitCode: number | undefined;
  readonly signal: number | undefined;
}): void => {
  // node-pty reports signal=0 for an ordinary Unix exit.
  if (
    input.exitCode !== 23 ||
    (input.signal !== undefined && input.signal !== 0)
  ) {
    throw new Error(
      `packaged PTY exited code=${String(input.exitCode)} signal=${String(input.signal)}`,
    );
  }
  const lines = normalizePtyLines(input.output);
  const missing = EXPECTED_PTY_LINES.filter((expected) => !lines.includes(expected));
  if (missing.length > 0) {
    throw new Error(`packaged PTY probe missing: ${missing.join(", ")}`);
  }
};

export interface LinuxPtySmokeControl {
  readonly create: TermControlClient["create"];
  readonly attach: TermControlClient["attach"];
  readonly write: TermControlClient["write"];
  readonly resize: TermControlClient["resize"];
  readonly release: TermControlClient["release"];
  readonly kill: TermControlClient["kill"];
  readonly on: (event: "event", listener: (event: LocalHostEvent) => void) => unknown;
  readonly off: (event: "event", listener: (event: LocalHostEvent) => void) => unknown;
}

export interface LinuxPtyInteractionReceipt {
  readonly backend: "pty";
  readonly interactiveEcho: true;
  readonly utf8: true;
  readonly resized: { readonly cols: 101; readonly rows: 41 };
  readonly term: "xterm-256color";
  readonly colorterm: "truecolor";
  readonly loginShell: true;
  readonly exitCode: 23;
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

export const exerciseLinuxPackagedPty = async (
  control: LinuxPtySmokeControl,
  options: {
    readonly timeoutMs?: number;
    readonly settleEchoDisabled?: () => Promise<void>;
  } = {},
): Promise<LinuxPtyInteractionReceipt> => {
  const timeoutMs = options.timeoutMs ?? PTY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > PTY_TIMEOUT_MS) {
    throw new RangeError("packaged PTY timeout must be a bounded positive integer");
  }

  const created = await control.create({
    bindingId: PROBE_BINDING_ID,
    launch: { kind: "shell", argv: ["/bin/bash", "-l"] },
    cols: 80,
    rows: 24,
    label: "Linux packaged PTY smoke",
  });
  if (created.backend !== "pty" || created.status !== "running") {
    throw new Error("packaged terminal did not start on the native PTY backend");
  }

  const attached = await control.attach({
    bindingId: PROBE_BINDING_ID,
    mode: "control",
  });
  if (!attached.ok) throw new Error(`packaged PTY attach failed: ${attached.message}`);

  let output = attached.journal
    .filter((entry) => entry.type === "output")
    .map((entry) => entry.type === "output" ? entry.data : "")
    .join("");
  let outputBytes = Buffer.byteLength(output);
  let outputOverflow = outputBytes > PTY_OUTPUT_LIMIT_BYTES;
  let settleExit!: (exit: { code: number | undefined; signal: number | undefined }) => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<{ code: number | undefined; signal: number | undefined }>(
    (resolveExit, reject) => {
      settleExit = resolveExit;
      timer = setTimeout(
        () => reject(new Error("packaged PTY interaction timed out")),
        timeoutMs,
      );
    },
  );
  const onEvent = (event: LocalHostEvent): void => {
    if (
      event.bindingId !== PROBE_BINDING_ID ||
      event.epoch !== attached.lease.epoch
    ) return;
    if (event.type === "output") {
      outputBytes += Buffer.byteLength(event.data);
      if (outputBytes > PTY_OUTPUT_LIMIT_BYTES) {
        outputOverflow = true;
        return;
      }
      output += event.data;
    } else if (event.type === "exit") {
      settleExit({ code: event.code, signal: event.signal });
    }
  };
  control.on("event", onEvent);

  try {
    if (!(await control.resize(attached.lease.leaseId, 101, 41))) {
      throw new Error("packaged PTY resize was refused");
    }
    // Disable terminal echo before sending marker-bearing input. Verification
    // then matches complete output lines, so the typed command cannot satisfy
    // its own assertions.
    if (!(await control.write(attached.lease.leaseId, "stty -echo\r"))) {
      throw new Error("packaged PTY write was refused");
    }
    await (options.settleEchoDisabled?.() ?? delay(100));
    if (!(await control.write(attached.lease.leaseId, LINUX_PTY_PROBE_COMMAND))) {
      throw new Error("packaged PTY probe write was refused");
    }
    const exit = await exited;
    if (outputOverflow) throw new Error("packaged PTY exceeded its output budget");
    verifyLinuxPtyProbe({ output, exitCode: exit.code, signal: exit.signal });
    return {
      backend: "pty",
      interactiveEcho: true,
      utf8: true,
      resized: { cols: 101, rows: 41 },
      term: "xterm-256color",
      colorterm: "truecolor",
      loginShell: true,
      exitCode: 23,
    };
  } catch (error) {
    await control.kill(PROBE_BINDING_ID).catch(() => false);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    control.off("event", onEvent);
    await control.release(attached.lease.leaseId).catch(() => undefined);
  }
};

const waitUntil = async (
  stage: string,
  timeoutMs: number,
  check: () => boolean | Promise<boolean>,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Linux packaged PTY smoke timed out during ${stage}`);
};

const pathExists = (candidate: string): Promise<boolean> =>
  lstat(candidate).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

const ensureDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
};

const boundedChildOutput = (lease: AppProcessLease): {
  readonly overflowed: () => boolean;
  readonly tail: () => string;
} => {
  let bytes = 0;
  let tail = "";
  const consume = (chunk: Buffer | string): void => {
    bytes += Buffer.byteLength(chunk);
    tail = `${tail}${String(chunk)}`.slice(-4_096);
  };
  lease.io.stdout.on("data", consume);
  lease.io.stderr.on("data", consume);
  return {
    overflowed: () => bytes > CHILD_OUTPUT_LIMIT_BYTES,
    tail: () => tail,
  };
};

const inheritedDisplayEnvironment = (): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "DISPLAY",
    "XAUTHORITY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
};

export interface LinuxPackagedPtySmokeReceipt extends LinuxPtyInteractionReceipt {
  readonly ok: true;
  readonly packagedPlacement: true;
  readonly appExitCode: 0;
  readonly socketRemoved: true;
  readonly cleanShutdown: true;
  readonly tempRootRemoved: true;
}

/** LX-005 integration point for the target-native installed/package lane. */
export const smokeLinuxPackagedPty = async (
  requestedResources: string,
  requestedExecutable: string,
): Promise<LinuxPackagedPtySmokeReceipt> => {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Linux packaged PTY smoke requires native Linux x64");
  }
  const resources = await realpath(path.resolve(requestedResources));
  const executable = await realpath(path.resolve(requestedExecutable));
  if (path.basename(executable) !== "vellum" || !isExecutable(executable)) {
    throw new Error("Linux packaged PTY smoke requires the packaged vellum executable");
  }
  const siblingResources = await realpath(path.join(path.dirname(executable), "resources"));
  if (siblingResources !== resources) {
    throw new Error("resources must belong to the packaged vellum executable");
  }
  auditLinuxPtyPlacement(resources);

  const tempParent = await realpath("/tmp");
  const tempRoot = await mkdtemp(path.join(tempParent, "vellum-linux-pty-smoke-"));
  await chmod(tempRoot, 0o700);
  const isolatedHome = path.join(tempRoot, "home");
  const userData = path.join(tempRoot, "user-data");
  const canvases = path.join(tempRoot, "canvases");
  const cache = path.join(tempRoot, "cache");
  const browser = path.join(tempRoot, "browser");
  const isolatedTmp = path.join(tempRoot, "tmp");
  await Promise.all(
    [isolatedHome, userData, canvases, cache, browser, isolatedTmp].map(ensureDirectory),
  );

  const environment: NodeJS.ProcessEnv = {
    ...inheritedDisplayEnvironment(),
    HOME: isolatedHome,
    USER: process.env.USER ?? "vellum-smoke",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "vellum-smoke",
    PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    SHELL: "/bin/bash",
    TMPDIR: isolatedTmp,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    XDG_CACHE_HOME: cache,
    VELLUM_BROWSER_DIR: browser,
    VELLUM_BROWSER_HOME: isolatedHome,
    VELLUM_CANVASES_DIR: canvases,
    VELLUM_WORK_HOME: path.join(isolatedHome, ".vellum", "work"),
  };

  const processPlane = createAppProcessPlane();
  let runtimeLease: AppProcessLease | undefined;
  let lifecycle: SpawnedRuntimeLifecycle | undefined;
  let control: TermControlClient | undefined;
  let success: Omit<LinuxPackagedPtySmokeReceipt, "tempRootRemoved"> | undefined;
  let primaryFailure: unknown;
  let finalization: PackagedRuntimeSandboxFinalization | undefined;

  try {
    runtimeLease = processPlane.spawnGroup({
      source: "linux-packaged-pty-smoke",
      purpose: "verify packaged Vellum terminal runtime",
      command: executable,
      args: ["--vellum-headless", `--user-data-dir=${userData}`],
      cwd: tempRoot,
      env: environment,
      shell: false,
    });
    lifecycle = observeSpawnedRuntimeLease(runtimeLease);
    runtimeLease.io.stdin.end();
    if (runtimeLease.mode !== "group") {
      throw new Error("Linux packaged PTY smoke requires verified process-group ownership");
    }
    const output = boundedChildOutput(runtimeLease);
    const socketPath = termControlSocketPath(isolatedHome);
    const tokenPath = termControlTokenPath(isolatedHome);

    await waitUntil("terminal control startup", STARTUP_TIMEOUT_MS, async () => {
      const terminal = lifecycle?.terminal();
      if (terminal !== undefined) {
        throw new Error(
          `packaged Vellum closed before terminal control startup (code=${String(terminal.code)}, signal=${String(terminal.signal)}, output=${output.tail()})`,
        );
      }
      return (await pathExists(socketPath)) && (await pathExists(tokenPath));
    });
    const token = (await readFile(tokenPath, "utf8")).trim();
    if (!/^[0-9a-f]{64}$/u.test(token)) {
      throw new Error("packaged terminal token has the wrong opaque format");
    }
    control = await TermControlClient.connect({ socketPath, token, timeoutMs: 8_000 });
    const interaction = await exerciseLinuxPackagedPty(control);
    const controlDrain = await control.drainOnQuit();
    control = undefined;
    if (!controlDrain.clean) {
      throw new Error("packaged terminal control client did not close cleanly");
    }
    if (output.overflowed()) {
      throw new Error("packaged Vellum exceeded the bounded smoke output budget");
    }

    const shutdown = processPlane.terminate(
      runtimeLease,
      "linux-packaged-pty-smoke-normal-shutdown",
    );
    if (!shutdown.attempted || shutdown.via !== "process.kill-group") {
      throw new Error("packaged Vellum shutdown lost verified process-group authority");
    }
    const terminal = await lifecycle.waitForClose(SHUTDOWN_TIMEOUT_MS);
    if (terminal.error !== undefined) {
      throw new Error(`packaged Vellum lifecycle error: ${terminal.error.message}`);
    }
    if (terminal.code !== 0 || terminal.signal !== null) {
      throw new Error("packaged Vellum did not complete its normal SIGTERM contract");
    }
    await waitUntil("terminal control cleanup", SHUTDOWN_TIMEOUT_MS, async () =>
      !(await pathExists(socketPath))
    );

    success = {
      ok: true,
      packagedPlacement: true,
      ...interaction,
      appExitCode: 0,
      socketRemoved: true,
      cleanShutdown: true,
    };
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (control !== undefined) {
      const receipt = await control.drainOnQuit().catch(() => undefined);
      if (receipt?.clean !== true && primaryFailure === undefined) {
        primaryFailure = new Error("packaged terminal control cleanup remained unclean");
      }
    }
    if (runtimeLease !== undefined && lifecycle !== undefined) {
      await terminateSpawnedRuntime(
        processPlane,
        lifecycle,
        runtimeLease,
        SHUTDOWN_TIMEOUT_MS,
      ).catch((error) => {
        primaryFailure ??= error;
      });
    }
    finalization = await finalizePackagedRuntimeSandbox(
      processPlane,
      runtimeLease,
      tempRoot,
    );
  }

  if (!finalization.proof.clean) {
    throw new Error(
      `Linux packaged PTY cleanup remained unclean (${finalization.proof.reason}); isolated sandbox retained at ${tempRoot}`,
      { cause: primaryFailure },
    );
  }
  if (!finalization.tempRootRemoved) {
    throw new Error("Linux packaged PTY smoke temp root survived verified cleanup");
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (success === undefined) throw new Error("Linux packaged PTY smoke did not complete");
  return { ...success, tempRootRemoved: true };
};

const modulePath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invokedPath === modulePath) {
  const [resources, executable] = process.argv.slice(2);
  if (!resources || !executable || process.argv.length !== 4) {
    console.error(
      "usage: bun scripts/linux-packaged-pty-smoke.ts /path/to/resources /path/to/vellum",
    );
    process.exitCode = 2;
  } else {
    smokeLinuxPackagedPty(resources, executable)
      .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
      .catch((error: unknown) => {
        const message = (error instanceof Error ? error.message : String(error))
          .replaceAll(homedir(), "<real-home>")
          .slice(0, 1_000);
        // An unclean verified-group failure intentionally retains its sandbox
        // and exact process handle. Publish failure without force-exiting this
        // verifier: the owned handle remains a lifetime witness until the
        // packaged process actually closes.
        writeSync(process.stderr.fd, `vellum Linux packaged PTY smoke failed: ${message}\n`);
        process.exitCode = 1;
      });
  }
}
