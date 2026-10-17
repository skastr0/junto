import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveJuntoHome } from "@shared/junto-home";
import { runningBuildIdentity } from "./junto/build-identity";
import { startCore } from "./junto/core";
import { armMainThreadBudget } from "./junto/observability/main-thread-budget";

const main = async (): Promise<void> => {
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
    home: resolveJuntoHome(),
    build: runningBuildIdentity(),
    bundles,
  });
  let closing = false;
  const stop = (): void => {
    if (closing) return;
    closing = true;
    void core.close().then(() => { process.exitCode = 0; }, (cause) => {
      console.error(cause instanceof Error ? cause.message : "Junto could not stop cleanly");
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  console.error("Junto core is ready");
};

void main().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : "Junto core failed to start");
  process.exitCode = 1;
});
