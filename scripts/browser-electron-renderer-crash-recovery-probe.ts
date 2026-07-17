#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureEntry = join(
  repoRoot,
  "tests/fixtures/browser/electron-renderer-crash-recovery-main.ts",
);
const electronPath = join(repoRoot, "node_modules/.bin/electron");
const MAX_LOG_BYTES = 128 * 1024;
const PROBE_TIMEOUT_MS = 30_000;

const appendBounded = (current: string, chunk: Buffer): string =>
  (current + chunk.toString("utf8")).slice(-MAX_LOG_BYTES);

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
  const child = spawn(process.execPath, [
    "build",
    fixtureEntry,
    "--target=node",
    "--format=esm",
    "--external=electron",
    `--outfile=${output}`,
    "--sourcemap=none",
  ], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = appendBounded(stderr, chunk);
  });
  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  if (code !== 0) {
    throw new Error(
      `renderer crash fixture build failed (${String(code ?? signal)}): ${stderr || stdout}`,
    );
  }
  await access(output);
  return output;
};

const run = async (): Promise<void> => {
  const root = await mkdtemp("/tmp/vbrc-");
  try {
    const entry = await buildFixture(root);
    const browserRoot = join(root, "browser");
    const downloadPath = join(root, "downloads");
    const reportPath = join(root, "report.json");
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...electronEnv } = process.env;
    const child = spawn(electronPath, [
      entry,
      `--browser-root=${browserRoot}`,
      `--download-path=${downloadPath}`,
      `--report-path=${reportPath}`,
    ], {
      cwd: repoRoot,
      env: { ...electronEnv, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);
    const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    clearTimeout(timeout);
    let reportValue: unknown;
    try {
      reportValue = JSON.parse(await readFile(reportPath, "utf8"));
    } catch (error) {
      throw new Error(
        `renderer crash qualification produced no readable report (${String(code ?? signal)}): ${stderr || stdout || String(error)}`,
      );
    }
    if (code !== 0) {
      const detail = isRecord(reportValue) && typeof reportValue.error === "string"
        ? reportValue.error
        : stderr || stdout;
      throw new Error(
        `renderer crash qualification failed (${String(code ?? signal)}): ${detail}`,
      );
    }
    const report = decodeReport(reportValue);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      assertions: 10,
      implicitRetryCount: report.implicitRetryCount,
      explicitReplacementCount: report.explicitReplacementCount,
    })}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
