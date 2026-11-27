/**
 * Open one throwaway home with the packaged Linux app under the display in
 * DISPLAY, wait for the database to reach the expected schema version and the
 * work socket to exist, let boot settle, then quit through the process plane
 * (the packaged smoke's own SIGTERM path) and wait for the whole tree to go.
 *
 *   bun scripts/upgrade-proof-open.ts <home-root> <package-dir> <expected-user-version> <label>
 *
 * <home-root> holds home/ (HOME) and user-data/ (--user-data-dir). The home must
 * already carry populated sqlite_stat1, as an installed one does
 * (`bun scripts/upgrade-proof-analyze.ts prepare <junto.db>`, app closed): the
 * open is refused otherwise, because 0.12.0 passed a proof on stat-less homes
 * and shipped a SQLITE_AUTH crash on every real one. The home is left in place
 * for the next open and for evidence. Prints one JSON receipt of counts and
 * names, never row text. No signal is sent except through the process plane.
 */
import { constants as fsConstants, createWriteStream } from "node:fs";
import { access, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { workControlDir, workControlSocketPath } from "../src/shared/work-control";
import { createAppProcessPlane, type AppProcessLease } from "../src/node/app-process-plane";
import { requireXvfbDisplay } from "./linux-ci-packaged-smoke";
import {
  descendantRows,
  observeSpawnedRuntimeLease,
  parseProcessRows,
  processRoles,
  survivingProcessRows,
  terminateSpawnedRuntime,
  type ProcessRow,
} from "./packaged-runtime-smoke";
import { proofHomeUserVersion, requireProofHomeStats } from "./upgrade-proof-analyze";
import { spawnSync } from "node:child_process";

const REACH_TIMEOUT_MS = 180_000;
const SETTLE_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 60_000;

export interface UpgradeProofOpenReceipt {
  readonly ok: true;
  readonly label: string;
  readonly userVersionBefore: number;
  readonly userVersionAfter: number;
  readonly statRowsBefore: number;
  readonly reachedAfterMs: number;
  readonly processRoles: ReadonlyArray<string>;
  readonly exitCode: 0;
  readonly leftoverProcesses: 0;
  readonly backups: ReadonlyArray<string>;
}

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const pathExists = (candidate: string): Promise<boolean> =>
  lstat(candidate).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

const currentProcessRows = (): ReadonlyArray<ProcessRow> => {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("ps failed during the upgrade proof open");
  return parseProcessRows(result.stdout);
};

const logTo = (lease: AppProcessLease, directory: string): void => {
  lease.io.stdout.pipe(createWriteStream(path.join(directory, "stdout.log"), { mode: 0o600 }));
  lease.io.stderr.pipe(createWriteStream(path.join(directory, "stderr.log"), { mode: 0o600 }));
};

export const openUpgradeProofHome = async (
  homeRoot: string,
  packageDir: string,
  expectedUserVersion: number,
  label: string,
): Promise<UpgradeProofOpenReceipt> => {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("the upgrade proof opens the packaged Linux x64 app");
  if (!/^[A-Za-z0-9._-]+$/u.test(label)) throw new Error("label must be a plain name");
  const root = await realpath(homeRoot);
  const home = path.join(root, "home");
  const database = path.join(home, ".junto", "state", "junto.db");
  // Refuses, by throwing, a home that never ran ANALYZE, before anything launches.
  const before = requireProofHomeStats(database);
  const display = requireXvfbDisplay(process.env.DISPLAY);
  const executable = path.join(await realpath(packageDir), "junto");
  await access(executable, fsConstants.X_OK);
  const logs = path.join(root, `open-${label}`);
  const [cache, browser, tmp, userData] = ["cache", "browser", "tmp", "user-data"].map((name) => path.join(root, name));
  await Promise.all([logs, cache!, browser!, tmp!, userData!].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));

  const environment: NodeJS.ProcessEnv = {
    DISPLAY: display,
    ...(process.env.XAUTHORITY === undefined ? {} : { XAUTHORITY: process.env.XAUTHORITY }),
    HOME: home,
    USER: process.env.USER ?? "junto-proof",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "junto-proof",
    PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    SHELL: "/bin/bash",
    TMPDIR: tmp!,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    XDG_CACHE_HOME: cache!,
    JUNTO_SECRET_STORE: "file",
    JUNTO_BROWSER_DIR: browser!,
    JUNTO_BROWSER_HOME: home,
    JUNTO_WORK_HOME: path.join(home, ".junto", "work"),
  };

  const processPlane = createAppProcessPlane();
  const lease = processPlane.spawnGroup({
    source: "upgrade-proof-open",
    purpose: "open a prepared home with the packaged Linux runtime",
    command: executable,
    // The VM has no sandbox profile and no speakers; the proof reads the database, not the renderer.
    args: ["--no-sandbox", `--user-data-dir=${userData}`, "--mute-audio", "--use-angle=swiftshader-webgl", "--enable-unsafe-swiftshader"],
    cwd: root,
    env: environment,
    shell: false,
    gracefulSignalScope: "leader",
  });
  const lifecycle = observeSpawnedRuntimeLease(lease);
  lease.io.stdin.end();
  logTo(lease, logs);
  let primary: unknown;
  let rows: ReadonlyArray<ProcessRow> = [];
  let reachedAfterMs = -1;
  let userVersionAfter = -1;
  let exitCode: number | null = null;
  try {
    if (lease.mode !== "group") throw new Error("the upgrade proof needs verified process-group ownership");
    const rootPid = lease.io.pidForDiagnostics;
    if (rootPid === undefined) throw new Error("packaged Junto did not produce a diagnostic pid");
    const socket = workControlSocketPath(workControlDir(home));
    const started = Date.now();
    for (;;) {
      const terminal = lifecycle.terminal();
      if (terminal !== undefined) throw new Error(`packaged Junto exited early (code=${String(terminal.code)}, signal=${String(terminal.signal)})`);
      if (Date.now() - started > REACH_TIMEOUT_MS) throw new Error(`database never reached user_version ${expectedUserVersion} with the work socket up`);
      let version = -1;
      try { version = proofHomeUserVersion(database); } catch { /* mid-write; read again */ }
      if (version === expectedUserVersion && (await pathExists(socket))) { userVersionAfter = version; break; }
      await delay(1000);
    }
    reachedAfterMs = Date.now() - started;
    await delay(SETTLE_MS);
    rows = descendantRows(rootPid, currentProcessRows());
  } catch (error) {
    primary = error;
  } finally {
    await terminateSpawnedRuntime(processPlane, lifecycle, lease, SHUTDOWN_TIMEOUT_MS).catch((error) => {
      primary ??= error;
    });
    exitCode = lifecycle.terminal()?.code ?? null;
  }
  if (primary !== undefined) throw primary;
  const leftover = survivingProcessRows(rows, currentProcessRows()).length;
  if (exitCode !== 0) throw new Error(`packaged Junto did not exit cleanly on shutdown (code=${String(exitCode)})`);
  if (leftover !== 0) throw new Error(`${leftover} packaged Junto processes outlived shutdown`);
  const backupDir = path.join(home, ".junto", "state", "backups");
  return {
    ok: true,
    label,
    userVersionBefore: before.userVersion,
    userVersionAfter,
    statRowsBefore: before.statRows,
    reachedAfterMs,
    processRoles: processRoles(rows[0]?.pid ?? 0, rows),
    exitCode: 0,
    leftoverProcesses: 0,
    backups: (await readdir(backupDir).catch(() => [])).sort(),
  };
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [homeRoot, packageDir, version, label] = process.argv.slice(2);
  if (homeRoot === undefined || packageDir === undefined || version === undefined || label === undefined || process.argv.length !== 6 || !/^[0-9]+$/u.test(version)) {
    console.error("usage: bun scripts/upgrade-proof-open.ts <home-root> <package-dir> <expected-user-version> <label>");
    process.exitCode = 2;
  } else {
    openUpgradeProofHome(homeRoot, packageDir, Number(version), label)
      .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
      .catch((error: unknown) => {
        console.error(`upgrade proof open failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      });
  }
}
