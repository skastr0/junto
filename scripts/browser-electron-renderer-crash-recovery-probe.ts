#!/usr/bin/env bun
import { access, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createProbeSandbox,
  createProbeProcessSupervisor,
  removeProbeSandboxIfClean,
  type ProbeProcessClose,
  type ProbeSandbox,
} from "./probe-process-supervisor";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureEntry = join(
  repoRoot,
  "tests/fixtures/browser/electron-renderer-crash-recovery-main.ts",
);
const electronPath = join(repoRoot, "node_modules/.bin/electron");
const MAX_LOG_BYTES = 128 * 1024;
const BUILD_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 30_000;
const PROBE_RUNTIME_TIMEOUT_MS = 50_000;
const PROBE_TEMP_PREFIX = "/tmp/vbrc-";
const probeSupervisor = createProbeProcessSupervisor({ maxLogBytes: MAX_LOG_BYTES });
let activeSandbox: ProbeSandbox | undefined;
let watchdogExitRequested = false;
let normalCleanupCompleted = false;
let successfulProbeOutput: string | undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeReport = (value: unknown): Record<string, unknown> => {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.ok !== true ||
    value.oldSessionRemoved !== true ||
    value.sameRefFreshGeneration !== true ||
    value.siblingUsable !== true ||
    value.replacementUsable !== true ||
    value.implicitRetryCount !== 0 ||
    value.explicitReplacementCount !== 1 ||
    value.liveManagedWebContents !== 2 ||
    !isRecord(value.operationFailure) ||
    value.operationFailure.ok !== false ||
    value.operationFailure.code !== "failed" ||
    value.operationFailure.message !== "browser renderer terminated unexpectedly"
  ) {
    throw new Error("renderer crash qualification emitted a failing or malformed report");
  }
  return value;
};

const buildFixture = async (root: string): Promise<string> => {
  const output = join(root, "electron-renderer-crash-recovery-main.mjs");
  const child = probeSupervisor.spawnGroup({
    source: "browser-electron-renderer-crash-recovery-probe",
    purpose: "build renderer crash recovery fixture",
    command: process.execPath,
    args: [
      "build",
      fixtureEntry,
      "--target=node",
      "--format=esm",
      "--external=electron",
      `--outfile=${output}`,
      "--sourcemap=none",
    ],
    cwd: repoRoot,
    env: process.env,
  });
  const close = await probeSupervisor.waitForClose(
    child,
    BUILD_TIMEOUT_MS,
    "renderer crash fixture build timed out",
  );
  if (close.exitCode !== 0 || close.signal !== null) {
    throw new Error(
      `renderer crash fixture build failed (${String(close.exitCode ?? close.signal)}): ${close.stderr || close.stdout || close.diagnostics.join("; ")}`,
    );
  }
  await access(output);
  return output;
};

const run = async (): Promise<void> => {
  const sandbox = await createProbeSandbox(PROBE_TEMP_PREFIX);
  const root = sandbox.root;
  activeSandbox = sandbox;
  try {
    const entry = await buildFixture(root);
    const browserRoot = join(root, "browser");
    const downloadPath = join(root, "downloads");
    const reportPath = join(root, "report.json");
    const stateDatabasePath = join(root, "state", "vellum-command.db");
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    await mkdir(join(root, "state"), { recursive: true });
    const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...electronEnv } = process.env;
    const child = probeSupervisor.spawnGroup({
      source: "browser-electron-renderer-crash-recovery-probe",
      purpose: "run renderer crash recovery fixture",
      command: electronPath,
      args: [
        entry,
        `--browser-root=${browserRoot}`,
        `--download-path=${downloadPath}`,
        `--report-path=${reportPath}`,
        `--state-db-path=${stateDatabasePath}`,
      ],
      cwd: repoRoot,
      env: { ...electronEnv, HOME: home },
    });
    let close: ProbeProcessClose;
    try {
      close = await probeSupervisor.waitForClose(
        child,
        PROBE_TIMEOUT_MS,
        "renderer crash qualification timed out",
      );
    } catch (error) {
      await probeSupervisor.stop(child, "renderer-crash-probe-timeout");
      throw error;
    }
    let reportValue: unknown;
    try {
      reportValue = JSON.parse(await readFile(reportPath, "utf8"));
    } catch (error) {
      throw new Error(
        `renderer crash qualification produced no readable report (${String(close.exitCode ?? close.signal)}): ${close.stderr || close.stdout || close.diagnostics.join("; ") || String(error)}`,
      );
    }
    if (close.exitCode !== 0 || close.signal !== null) {
      const detail = isRecord(reportValue) && typeof reportValue.error === "string"
        ? reportValue.error
        : close.stderr || close.stdout || close.diagnostics.join("; ");
      throw new Error(
        `renderer crash qualification failed (${String(close.exitCode ?? close.signal)}): ${detail}`,
      );
    }
    const report = decodeReport(reportValue);
    successfulProbeOutput = JSON.stringify({
      ok: true,
      assertions: 10,
      implicitRetryCount: report.implicitRetryCount,
      explicitReplacementCount: report.explicitReplacementCount,
    });
  } finally {
    const drainReceipt = await probeSupervisor.shutdown(
      "renderer-crash-probe-finalize",
    );
    const removed = await removeProbeSandboxIfClean({
      sandbox,
      receipt: drainReceipt,
      label: "Electron renderer crash recovery probe",
    });
    if (removed && activeSandbox === sandbox) activeSandbox = undefined;
    if (!drainReceipt.clean && !watchdogExitRequested && (process.exitCode ?? 0) === 0) {
      process.exitCode = 1;
    }
    normalCleanupCompleted = true;
  }
};

const watchdog = setTimeout(() => {
  watchdogExitRequested = true;
  process.stderr.write("renderer crash qualification global watchdog expired\n");
  void (async () => {
    const drainReceipt = await probeSupervisor.shutdown(
      "renderer-crash-probe-watchdog",
    );
    if (activeSandbox !== undefined) {
      await removeProbeSandboxIfClean({
        sandbox: activeSandbox,
        receipt: drainReceipt,
        label: "Electron renderer crash recovery watchdog",
      }).catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return false;
      });
    }
    process.exitCode = 124;
  })();
}, PROBE_RUNTIME_TIMEOUT_MS);
watchdog.unref();

try {
  await run();
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  if (!watchdogExitRequested) process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  const finalReceipt = await probeSupervisor.shutdown(
    "renderer-crash-probe-top-level-finalize",
  );
  if (!normalCleanupCompleted && activeSandbox !== undefined) {
    const removed = await removeProbeSandboxIfClean({
      sandbox: activeSandbox,
      receipt: finalReceipt,
      label: "Electron renderer crash recovery top-level cleanup",
    });
    if (removed) activeSandbox = undefined;
  }
  if (!finalReceipt.clean && !watchdogExitRequested && (process.exitCode ?? 0) === 0) {
    process.exitCode = 1;
  }
  if (
    successfulProbeOutput !== undefined &&
    finalReceipt.clean &&
    !watchdogExitRequested &&
    (process.exitCode ?? 0) === 0
  ) {
    process.stdout.write(`${successfulProbeOutput}\n`);
  }
}
