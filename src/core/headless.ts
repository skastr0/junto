import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveJuntoHome } from "@shared/junto-home";
import { runningBuildIdentity } from "../node/build-identity";
import { installServiceCrashLog, readServiceFileTail, recordServiceBoot, serviceInstallRoot } from "../node/hosts/service-runtime";
import { startHeapLog } from "../node/observability/heap-log";
import { startCore } from "./core";
import { closeCoreProcess } from "./core-stop";
import { HostClientsNoWindow } from "./host-clients";
import { enforceBootRefusal } from "../node/boot-guard";
import { declareMachineCoreOwnsSessions } from "./term/managed-spawn-plan";
import { armMainThreadBudget } from "../node/observability/main-thread-budget";
import { openCoreLog } from "./core-log";
import { machineLogDir } from "../node/observability/log-file";
import { LinkUnavailable } from "./link/types";
import { runRestoreFinish } from "../node/hosts/restore-finish";
import { buildRelease } from "../node/build-release";

const home = resolveJuntoHome();
// A machine core's service always sets JUNTO_HOME, and every session pinned
// in that home was pinned by this core. Without saying so, the core took the
// dev build's isolation: it launched a fresh, unrecorded id instead of the
// one it pinned, and never resumed a session.
declareMachineCoreOwnsSessions(process.env);

const main = async (): Promise<void> => {
  // A machine core is a process entry too: one started from a seat's shell
  // carries the seat's identity, and refuses here before it opens the
  // database, its log or a socket (src/shared/e2e-sandbox.ts).
  enforceBootRefusal({ juntoHome: home });
  // The log file is this core's record, and every row lands in its ring, as
  // the app core's do. Its service stdio is an unbounded file, so nothing is
  // echoed there but the fixed lines below.
  const log = openCoreLog({ home, echo: false });
  installServiceCrashLog(log);
  // One `[metrics] core heap` row a minute, as the app's core writes in
  // entry.ts: a windowless core is the one that grew under fleet work, and no
  // other process can read its heap (#650).
  const stopHeapLog = startHeapLog({ label: "core", write: (level, message) => log.writeLog({ level, source: "core", message }) });
  // The 4ms assertion is a development instrument. Bun's bundler inlines
  // NODE_ENV as "development", so without this every installed core reports
  // each kernel pass to stderr. JUNTO_BUDGET still arms it by hand.
  armMainThreadBudget({ enabled: false });
  const entry = resolve(process.argv[1] ?? process.execPath);
  const installRoot = serviceInstallRoot(entry);
  const stderrLog = installRoot === undefined ? undefined : join(installRoot, "logs", "stderr.log");
  const previousStderr = stderrLog === undefined ? undefined : readServiceFileTail(stderrLog, 8192);
  const packageRoot = dirname(dirname(entry));
  const nativeTarget = `${process.platform}-${process.arch}`;
  const bundles = existsSync(join(packageRoot, "manifest.json")) && (nativeTarget === "darwin-arm64" || nativeTarget === "linux-x64")
    ? { [nativeTarget]: packageRoot } : {};
  // A home moved under this core stops it as SIGTERM does (socket-path-watch.ts).
  let stopForHomeMoved: ((message: string) => void) | undefined;
  const core = await startCore({
    home,
    onHomeMoved: (message) => stopForHomeMoved?.(message),
    // An installed core finishes a restore its install left owed, under its
    // home lock, before it reads the database. Both roots are this core's own.
    ...(installRoot === undefined ? {} : {
      finishRestore: () => runRestoreFinish({ junto: join(packageRoot, "bin", "junto"), home, installRoot }),
    }),
    build: runningBuildIdentity(),
    release: buildRelease(typeof __JUNTO_APP_VERSION__ === "string" ? __JUNTO_APP_VERSION__ : undefined),
    bundles,
    log,
    host: HostClientsNoWindow,
  });
  // The lease is held: this core owns the home, so the service files are its
  // to bound. The previous boot's stderr was read before the lease and goes
  // to the rotated log now, while its credentials are registered for the scrub.
  if (installRoot !== undefined) recordServiceBoot(log, installRoot, previousStderr);
  let closing = false;
  // `cleanCode` is the exit after a clean stop: 0 for a signal; nonzero for a
  // home moved under the core, so the service manager starts a core on the
  // home as it is now (Restart=on-failure, launchd KeepAlive).
  const stopFor = (message: string, cleanCode = 0): void => {
    if (closing) return;
    closing = true;
    // The service manager stopping this core is the first fact a reader of either log needs.
    console.info(`[core] ${message}`);
    void closeCoreProcess(() => core.close(new LinkUnavailable({ reason: "shutting-down", message }))).then(() => { stopHeapLog(); process.exitCode = cleanCode; }, (cause: unknown) => {
      stopHeapLog();
      console.error("[core] Junto could not stop cleanly", cause);
      process.stderr.write(`Junto could not stop cleanly; the reason is in ${machineLogDir(home)}\n`);
      process.exitCode = 1;
    });
  };
  const stop = (signal: NodeJS.Signals): void => stopFor(`This machine's Junto core is stopping: it received ${signal}`);
  stopForHomeMoved = (message) => stopFor(message, 75);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  console.info("[core] Junto core is ready");
  // scripts/machine-bundle-boot.ts waits for this exact line.
  process.stderr.write("Junto core is ready\n");
};

void main().catch((cause: unknown) => {
  console.error("[core] Junto core failed to start", cause);
  process.stderr.write(`Junto core failed to start; the reason is in ${machineLogDir(home)}\n`);
  process.exitCode = 1;
});
