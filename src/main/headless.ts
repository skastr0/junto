import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveJuntoHome } from "@shared/junto-home";
import { runningBuildIdentity } from "./junto/build-identity";
import { startCore } from "./junto/core";
import { armMainThreadBudget } from "./junto/observability/main-thread-budget";
import { installMachineLog, installObservabilityConsoleHook } from "./junto/observability/logger";
import { machineLogDir } from "./junto/observability/log-file";
import { LinkUnavailable } from "./junto/link/types";

const home = resolveJuntoHome();

const main = async (): Promise<void> => {
  // The log file is this core's record. Its service stdio is an unbounded
  // file, so nothing is echoed there but the fixed lines below.
  installMachineLog({ home, process: "core", echo: false });
  installObservabilityConsoleHook({ echo: false });
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
  });
  let closing = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    // The service manager stopping this core is the first fact a reader of either log needs.
    console.info(`[core] Junto core is stopping: it received ${signal}`);
    void core.close(new LinkUnavailable({ reason: "shutting-down", message: `This machine's Junto core is stopping: it received ${signal}` })).then(() => { process.exitCode = 0; }, (cause: unknown) => {
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
