#!/usr/bin/env bun
// Deterministic backstop for headless kernel delivery (kernel-design.md §7,
// consumed by the "headless-launchd-verify" batch).
//
// Spawns an ISOLATED instance of the app with one pre-seeded SQLite database
// and its own sidecar-output directory, so nothing here ever touches the
// operator's real Vellum state. The seeding connection is closed before the
// app starts; the app remains the database's sole live owner. Two passes:
//
//   1. ARMED   — pre-seeds the fixture region's normalized SQLite arming row,
//      boots the app in its explicit no-window mode (the app + kernel keep
//      running with zero windows, exactly the packaged/launchd shape), and
//      waits for a TIMER pulse routed over a human-authored timer → agent edge
//      to deliver: a real ChatService.chatOpen + chatPrompt against a local
//      hermes agent, landing a PulseRecord with delivered.length > 0.
//   2. DISARMED — same fixture, armed:false from boot. Asserts the resulting
//      PulseRecord is dry (delivered: [], dry: true) — no agent turn spent.
//
// A TIMER (not a stat_threshold watcher) is the deterministic trigger on
// purpose: it needs no live hermes snapshot, so this probe proves headless
// delivery with zero windows through the same executable entity + human-edge
// router used by watcher fire. Region membership supplies arming and
// instruction context only.
//
// Observation is the child process's bounded stdout stream. The probe never
// reopens the live database, and no document file participates in authority.
//
// Exit 0 if both passes hold; exit 2 with a diagnosis otherwise.

import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KERNEL_OBSERVATION_PREFIX,
} from "../src/main/vellum/kernel/service";
import {
  startRendererServer,
  type RendererServer,
} from "../e2e/harness/renderer-server";
import {
  createProbeSandbox,
  createProbeProcessSupervisor,
  removeProbeSandboxIfClean,
  type ProbeProcessHandle,
  type ProbeSandbox,
} from "./probe-process-supervisor";
import {
  installProbeSignalDrain,
  type ProbeShutdownSignal,
} from "./probe-signal-drain";
import { createProbeResourceLifecycle } from "./probe-resource-lifecycle";
import {
  KERNEL_PROBE_CANVAS,
  KERNEL_PROBE_REGION_ID,
  KERNEL_PROBE_TIMER_EVERY_MINUTES,
  makeKernelHeadlessFixture,
} from "./kernel-headless-fixture";

// Scripts in this repo are always invoked from the repo root (`bun run
// scripts/...` / `bun scripts/...`), matching every other script here — no
// bun-specific import.meta.dir needed.
const REPO_ROOT = process.cwd();
const ELECTRON_BIN = join(REPO_ROOT, "node_modules", ".bin", "electron");
const MAIN_ENTRY = join(REPO_ROOT, "out", "main", "index.js");
const RENDERER_DIR = join(REPO_ROOT, "out", "renderer");
const RENDERER_ENTRY = join(RENDERER_DIR, "index.html");
const SEED_ENTRY = join(REPO_ROOT, "scripts", "kernel-headless-seed.ts");
const PROBE_ENTRY = join(REPO_ROOT, "scripts", "kernel-headless-probe.ts");
const ELECTRON_GUARDIAN_FLAG = "--electron-guardian";
const ELECTRON_GUARDIAN =
  process.argv.indexOf(ELECTRON_GUARDIAN_FLAG) >= 0;
const STARTUP_SMOKE = process.argv.includes("--startup-smoke");

const BOOT_POLL_MS = 500;
const ARMED_DELIVERY_TIMEOUT_MS = 90_000; // headroom for a real model turn
// A newly discovered timer is scheduled one interval ahead, but the production
// kernel's safety evaluation cadence is 30s. Keep this beyond one full cadence
// while still failing well inside the global watchdog.
const DRY_PULSE_TIMEOUT_MS = 45_000;
const PROBE_RUNTIME_TIMEOUT_MS = 130_000;
const PROBE_LOG_BYTES = 256 * 1024;
const SEED_TIMEOUT_MS = 30_000;
// Darwin's sockaddr_un limit is 104 bytes and its reported tmpdir is already
// deeply nested. mkdtemp still mints the exact deletion capability, but the
// short system alias keeps isolated UDS paths representable.
const PROBE_TEMP_PREFIX = process.platform === "darwin"
  ? "/tmp/vkh-"
  : join(tmpdir(), "vellum-kernel-probe-");
const probeSupervisor = createProbeProcessSupervisor({
  maxLogBytes: PROBE_LOG_BYTES,
  // The guardian owns a second process group and may spend its full bounded
  // TERM→KILL drain before it closes.
  termGraceMs: 5_000,
  killGraceMs: 3_000,
});
const activeSandboxes = new Set<ProbeSandbox>();
let watchdogExitRequested = false;
let externalExitRequested = false;
let mainSucceeded = false;
const rendererLifecycle = createProbeResourceLifecycle<RendererServer>(
  "trusted renderer",
  (error) => {
    console.error(
      `[probe] trusted renderer close failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  },
);

interface PulseRecordLike {
  readonly kind: string;
  readonly dry: boolean;
  readonly delivered: ReadonlyArray<string>;
  readonly canvasName: string;
  readonly regionId?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Fixture {
  readonly root: string;
  readonly userDataDir: string;
  readonly canvasesDir: string;
  readonly stateDatabase: string;
}

const compileSeedHelper = async (root: string): Promise<string> => {
  const outdir = join(root, "seed-helper");
  const result = await Bun.build({
    entrypoints: [SEED_ENTRY],
    outdir,
    target: "node",
    format: "esm",
    splitting: false,
    sourcemap: "inline",
  });
  if (!result.success) {
    const detail = result.logs
      .map((log) => log.message)
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `failed to compile Electron SQLite seed helper${detail ? `:\n${detail}` : ""}`,
    );
  }
  const entry = result.outputs.find((output) => output.kind === "entry-point");
  if (entry === undefined) {
    throw new Error("Electron SQLite seed helper build produced no entry point");
  }
  return entry.path;
};

const seedFixture = async (
  root: string,
  stateDatabase: string,
  canvasesDir: string,
  armed: boolean,
): Promise<void> => {
  const seedHelper = await compileSeedHelper(root);
  const child = probeSupervisor.spawnGroup({
    source: "kernel-headless-seed",
    purpose: "seed isolated SQLite authority under Electron Node",
    command: ELECTRON_BIN,
    args: [seedHelper, stateDatabase, armed ? "armed" : "disarmed"],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      HOME: root,
      VELLUM_CANVASES_DIR: canvasesDir,
    },
  });
  const close = await probeSupervisor.waitForClose(
    child,
    SEED_TIMEOUT_MS,
    `Electron SQLite seed helper exceeded ${SEED_TIMEOUT_MS}ms`,
  );
  if (
    close.exitCode !== 0 ||
    close.signal !== null ||
    !close.stdout.includes("kernel-headless-seed: SQLITE SEEDED")
  ) {
    const diagnostic = `${close.stdout}\n${close.stderr}`.trim().slice(-8_192);
    throw new Error(
      `Electron SQLite seed helper failed (code ${String(close.exitCode)}, signal ${String(close.signal)})${diagnostic ? `\n${diagnostic}` : ""}`,
    );
  }
};

const setUpFixture = async (armed: boolean): Promise<Fixture> => {
  const sandbox = await createProbeSandbox(PROBE_TEMP_PREFIX);
  activeSandboxes.add(sandbox);
  const root = sandbox.root;
  const userDataDir = join(root, "userData");
  const canvasesDir = join(root, "canvases");
  // The app deliberately ignores arbitrary database path overrides. Seed the
  // isolated HOME's canonical authority, close that connection, then let the
  // app become its sole live owner at the same path.
  const stateDatabase = join(root, ".vellum", "state", "vellum.db");
  await mkdir(canvasesDir, { recursive: true });
  await seedFixture(root, stateDatabase, canvasesDir, armed);
  return {
    root,
    userDataDir,
    canvasesDir,
    stateDatabase,
  };
};

const spawnApp = (
  fixture: Fixture,
  rendererUrl: string,
): ProbeProcessHandle => {
  const {
    ELECTRON_RUN_AS_NODE: _electronRunAsNode,
    ...electronEnvironment
  } = process.env;
  const child = probeSupervisor.spawnGroup({
    source: "kernel-headless-probe-guardian",
    purpose: "guard isolated headless Vellum fixture",
    command: process.execPath,
    args: [
      PROBE_ENTRY,
      ELECTRON_GUARDIAN_FLAG,
      MAIN_ENTRY,
      `--user-data-dir=${fixture.userDataDir}`,
      "--vellum-headless",
    ],
    cwd: REPO_ROOT,
    env: {
      ...electronEnvironment,
      // Unpackaged Electron has no vellum-app:// protocol. Give the existing
      // trusted-origin guard an exact loopback root backed by the real built
      // renderer; never weaken or bypass the guard for headless mode.
      ELECTRON_RENDERER_URL: rendererUrl,
      HOME: fixture.root,
      VELLUM_E2E: "1",
      VELLUM_BROWSER_DIR: join(fixture.root, "browser"),
      VELLUM_BROWSER_HOME: fixture.userDataDir,
      VELLUM_CANVASES_DIR: fixture.canvasesDir,
      VELLUM_KERNEL_OBSERVATIONS: "1",
      VELLUM_WORK_HOME: join(fixture.root, "work-control"),
    },
  });
  child.onOutput((source, _snapshot, chunk) => {
    const destination = source === "stdout" ? process.stdout : process.stderr;
    destination.write(`[app] ${chunk}`);
  });
  return child;
};

const observedPulseRecords = (
  child: ProbeProcessHandle,
): ReadonlyArray<PulseRecordLike> => {
  const records: PulseRecordLike[] = [];
  for (const line of child.output().stdout.split(/\r?\n/u)) {
    const marker = line.indexOf(KERNEL_OBSERVATION_PREFIX);
    if (marker < 0) continue;
    try {
      const observation = JSON.parse(
        line.slice(marker + KERNEL_OBSERVATION_PREFIX.length),
      ) as { readonly pulseLog?: ReadonlyArray<PulseRecordLike> };
      if (Array.isArray(observation.pulseLog)) {
        records.push(...observation.pulseLog);
      }
    } catch {
      // A partially buffered final line is retried on the next poll.
    }
  }
  return records;
};

const waitForPulse = async (
  fixture: Fixture,
  child: ProbeProcessHandle,
  predicate: (record: PulseRecordLike) => boolean,
  timeoutMs: number,
): Promise<PulseRecordLike> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (watchdogExitRequested) throw new Error("kernel probe watchdog expired");
    if (child.exited()) {
      const close = await child.closed;
      const diagnostic = `${close.stdout}\n${close.stderr}`.trim().slice(-8_192);
      throw new Error(
        `headless Vellum exited before a PulseRecord (code ${String(close.exitCode)}, signal ${String(close.signal)})${diagnostic ? `\n${diagnostic}` : ""}`,
      );
    }
    const match = observedPulseRecords(child).find(
      (record) =>
        record.canvasName === KERNEL_PROBE_CANVAS && predicate(record),
    );
    if (match) return match;
    await sleep(BOOT_POLL_MS);
  }
  throw new Error(`no matching PulseRecord landed within ${timeoutMs}ms`);
};

const nudgeTimerAfterKernelBaseline = async (
  fixture: Fixture,
  child: ProbeProcessHandle,
): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exited()) {
      const close = await child.closed;
      throw new Error(
        `headless Vellum exited before the kernel baseline (code ${String(close.exitCode)}, signal ${String(close.signal)})`,
      );
    }
    if (child.output().stdout.includes(KERNEL_OBSERVATION_PREFIX)) break;
    await sleep(BOOT_POLL_MS);
  }
  if (!child.output().stdout.includes(KERNEL_OBSERVATION_PREFIX)) {
    throw new Error("kernel did not publish its initial headless baseline");
  }

  // A timer is intentionally not fired on discovery. Wait past its first
  // schedule so the kernel safety evaluation (or due timer path) can fire
  // without an authorial document rewrite — SQLite is the sole durable authority.
  await sleep(KERNEL_PROBE_TIMER_EVERY_MINUTES * 60_000 + 250);
};

const runPass = async (
  label: string,
  armed: boolean,
  rendererUrl: string,
  assert: (
    fixture: Fixture,
    child: ProbeProcessHandle,
  ) => Promise<void>,
): Promise<void> => {
  console.log(`\n=== pass: ${label} ===`);
  const fixture = await setUpFixture(armed);
  const child = spawnApp(fixture, rendererUrl);
  try {
    console.log("[probe] explicit headless mode started with zero renderer windows");
    await Promise.all([
      assert(fixture, child),
      nudgeTimerAfterKernelBaseline(fixture, child),
    ]);
    console.log(`[probe] ${label}: PASS`);
  } finally {
    const receipt = await probeSupervisor.stop(
      child,
      `kernel-headless-pass-finalize:${label}`,
    );
    if (!receipt.closed) {
      throw new Error(
        `headless fixture did not close (${JSON.stringify(receipt)})`,
      );
    }
  }
};

const assertProbeBuildInputs = async (): Promise<void> => {
  try {
    await Promise.all([
      access(ELECTRON_BIN, constants.X_OK),
      access(MAIN_ENTRY, constants.R_OK),
      access(RENDERER_ENTRY, constants.R_OK),
      access(SEED_ENTRY, constants.R_OK),
    ]);
  } catch (error) {
    throw new Error(
      "kernel headless probe requires current Electron artifacts; run `bun x electron-vite build` first",
      { cause: error },
    );
  }
};

const startTrustedRendererRoot = async (): Promise<RendererServer> => {
  const server = await startRendererServer(RENDERER_DIR);
  try {
    const response = await fetch(server.url, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(
        `trusted renderer root returned HTTP ${response.status}`,
      );
    }
    const body = await response.text();
    if (!body.toLowerCase().includes("<!doctype html")) {
      throw new Error("trusted renderer root did not serve the built app shell");
    }
    return server;
  } catch (error) {
    await server.close().catch(() => undefined);
    throw error;
  }
};

const main = async (): Promise<void> => {
  await assertProbeBuildInputs();
  const rendererServer = await rendererLifecycle.acquire(
    startTrustedRendererRoot,
  );
  console.log(`[probe] trusted renderer root: ${rendererServer.url}`);

  if (STARTUP_SMOKE) {
    await runPass(
      "startup wiring reaches a dry kernel pulse",
      false,
      rendererServer.url,
      async (fixture, child) => {
        const record = await waitForPulse(
          fixture,
          child,
          (r) => r.kind === "timer" && r.dry && r.delivered.length === 0,
          DRY_PULSE_TIMEOUT_MS,
        );
        console.log("[probe] startup wiring PulseRecord:", record);
      },
    );
    mainSucceeded = true;
    return;
  }

  await runPass(
    "armed region delivers headlessly",
    true,
    rendererServer.url,
    async (fixture, child) => {
      const record = await waitForPulse(
        fixture,
        child,
        (r) => r.kind === "timer" && !r.dry && r.delivered.length > 0,
        ARMED_DELIVERY_TIMEOUT_MS,
      );
      console.log("[probe] delivered PulseRecord:", record);
    },
  );

  await runPass(
    "disarmed region yields a dry pulse",
    false,
    rendererServer.url,
    async (fixture, child) => {
      const record = await waitForPulse(
        fixture,
        child,
        (r) => r.kind === "timer" && r.dry && r.delivered.length === 0,
        DRY_PULSE_TIMEOUT_MS,
      );
      console.log("[probe] dry PulseRecord:", record);
    },
  );

  mainSucceeded = true;
};

const finalize = async (reason: string): Promise<boolean> => {
  const drainReceipt = await probeSupervisor.shutdown(reason);
  let allRemoved = true;
  for (const sandbox of activeSandboxes) {
    const removed = await removeProbeSandboxIfClean({
      sandbox,
      receipt: drainReceipt,
      label: "kernel headless probe",
    });
    if (removed) activeSandboxes.delete(sandbox);
    else allRemoved = false;
  }
  const rendererClosed = await rendererLifecycle.close();
  return drainReceipt.clean && allRemoved && rendererClosed;
};

const signalExitCode = (signal: ProbeShutdownSignal): number => {
  switch (signal) {
    case "SIGHUP":
      return 129;
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
  }
};

const runElectronGuardian = async (): Promise<void> => {
  const flagIndex = process.argv.indexOf(ELECTRON_GUARDIAN_FLAG);
  const electronArgs = process.argv.slice(flagIndex + 1);
  if (flagIndex < 0 || electronArgs.length === 0) {
    throw new Error("electron guardian requires an Electron entry or argument");
  }

  const supervisor = createProbeProcessSupervisor({
    maxLogBytes: PROBE_LOG_BYTES,
  });
  const child = supervisor.spawnGroup({
    source: "kernel-headless-probe-electron",
    purpose: "run guarded Electron fixture",
    command: ELECTRON_BIN,
    args: electronArgs,
    cwd: REPO_ROOT,
    env: process.env,
  });
  child.onOutput((source, _snapshot, chunk) => {
    const destination = source === "stdout" ? process.stdout : process.stderr;
    destination.write(chunk);
  });

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let stopFlight: Promise<boolean> | undefined;
  const requestStop = (
    reason: string,
    desiredExitCode = process.exitCode ?? 0,
  ): Promise<boolean> => {
    if (stopFlight !== undefined) return stopFlight;
    stopFlight = supervisor.shutdown(reason).then(
      (receipt) => {
        if (!receipt.clean) {
          console.error(
            `kernel-headless-probe guardian drain failed: ${JSON.stringify(receipt)}`,
          );
          process.exitCode = 2;
          return false;
        }
        process.exitCode = desiredExitCode;
        return true;
      },
      (error) => {
        console.error(error instanceof Error ? error.stack ?? error.message : error);
        process.exitCode = 2;
        return false;
      },
    ).finally(resolveDone);
    return stopFlight;
  };

  const signalDrain = installProbeSignalDrain({
    finalize: requestStop,
    beforeDrain: (signal) => {
      process.exitCode = signalExitCode(signal);
    },
  });
  const onParentEnd = (): void => {
    void requestStop("kernel-headless-probe-parent-eof");
  };
  const onParentError = (): void => {
    void requestStop("kernel-headless-probe-parent-input-error", 2);
  };
  process.stdin.once("end", onParentEnd);
  process.stdin.once("error", onParentError);
  process.stdin.resume();
  void child.closed.then((close) => {
    if (stopFlight !== undefined) return;
    const exitCode = close.exitCode ?? (close.signal === null ? 0 : 1);
    void requestStop("kernel-headless-probe-electron-closed", exitCode);
  });

  try {
    await done;
  } finally {
    signalDrain.uninstall();
    process.stdin.off("end", onParentEnd);
    process.stdin.off("error", onParentError);
    process.stdin.pause();
  }
};

const runProbeProgram = async (): Promise<void> => {
  const signalDrain = installProbeSignalDrain({
    finalize,
    beforeDrain: (signal) => {
      externalExitRequested = true;
      process.exitCode = signalExitCode(signal);
      console.error(`\nkernel-headless-probe: ${signal} RECEIVED; DRAINING`);
    },
    onFailure: (_signal, error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
    },
  });

  const watchdog = setTimeout(() => {
    watchdogExitRequested = true;
    console.error("\nkernel-headless-probe: GLOBAL WATCHDOG EXPIRED");
    void (async () => {
      await finalize("kernel-headless-probe-watchdog").catch((error) => {
        console.error(error instanceof Error ? error.stack ?? error.message : error);
        return false;
      });
      process.exitCode = 124;
    })();
  }, PROBE_RUNTIME_TIMEOUT_MS);
  watchdog.unref();

  try {
    await main();
  } catch (err) {
    console.error("\nkernel-headless-probe: FAILED");
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    if (!watchdogExitRequested && !externalExitRequested) process.exitCode = 2;
  } finally {
    const clean = await finalize("kernel-headless-probe-finalize");
    if (!clean && !watchdogExitRequested && (process.exitCode ?? 0) === 0) {
      process.exitCode = 2;
    }
    if (
      mainSucceeded &&
      clean &&
      !watchdogExitRequested &&
      (process.exitCode ?? 0) === 0
    ) {
      console.log(
        STARTUP_SMOKE
          ? "\nkernel-headless-probe: STARTUP SMOKE GREEN"
          : "\nkernel-headless-probe: ALL PASSES GREEN",
      );
    }
    clearTimeout(watchdog);
    signalDrain.uninstall();
  }
};

if (ELECTRON_GUARDIAN) {
  try {
    await runElectronGuardian();
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 2;
  }
} else {
  await runProbeProgram();
}
