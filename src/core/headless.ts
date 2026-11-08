import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveJuntoHome } from "@shared/junto-home";
import { runningBuildIdentity } from "../node/build-identity";
import { startCore } from "./core";
import { closeCoreProcess } from "./core-stop";
import { HostClientsNoWindow } from "./host-clients";
import { enforceBootRefusal } from "../node/boot-guard";
import { declareMachineCoreOwnsSessions } from "./term/managed-spawn-plan";
import { armMainThreadBudget } from "../node/observability/main-thread-budget";
import { createLogger } from "../node/observability/logger";
import { registeredSecretValues } from "./credentials/known-secrets";
import { observabilityRing } from "./observability/ring";
import { machineLogDir } from "../node/observability/log-file";
import { LinkUnavailable } from "./link/types";

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
  const log = createLogger({
    process: "core",
    echo: false,
    sink: (row) => observabilityRing.append(row),
    knownSecrets: registeredSecretValues,
  });
  log.openFile({ home });
  log.installConsoleHook({ echo: false });
  // The 4ms assertion is a development instrument. Bun's bundler inlines
  // NODE_ENV as "development", so without this every installed core reports
  // each kernel pass to stderr. JUNTO_BUDGET still arms it by hand.
  armMainThreadBudget({ enabled: false });
  const entry = resolve(process.argv[1] ?? process.execPath);
  const packageRoot = dirname(dirname(entry));
  const nativeTarget = `${process.platform}-${process.arch}`;
  const bundles = existsSync(join(packageRoot, "manifest.json")) && (nativeTarget === "darwin-arm64" || nativeTarget === "linux-x64")
    ? { [nativeTarget]: packageRoot } : {};
  const core = await startCore({
    home,
    build: runningBuildIdentity(),
    bundles,
    log,
    host: HostClientsNoWindow,
  });
  let closing = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    // The service manager stopping this core is the first fact a reader of either log needs.
    console.info(`[core] Junto core is stopping: it received ${signal}`);
    void closeCoreProcess(() => core.close(new LinkUnavailable({ reason: "shutting-down", message: `This machine's Junto core is stopping: it received ${signal}` }))).then(() => { process.exitCode = 0; }, (cause: unknown) => {
      console.error("[core] Junto could not stop cleanly", cause);
      process.stderr.write(`Junto could not stop cleanly; the reason is in ${machineLogDir(home)}\n`);
      process.exitCode = 1;
    });
  };
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
