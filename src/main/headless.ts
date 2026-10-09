import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveJuntoHome } from "@shared/junto-home";
import { runningBuildIdentity } from "./junto/build-identity";
import { startCore } from "./junto/core";

const main = async (): Promise<void> => {
  const entry = resolve(process.argv[1] ?? process.execPath);
  const packageRoot = dirname(dirname(entry));
  const nativeTarget = `${process.platform}-${process.arch}`;
  const bundles = existsSync(join(packageRoot, "manifest.json")) && (nativeTarget === "darwin-arm64" || nativeTarget === "linux-x64")
    ? { [nativeTarget]: packageRoot } : {};
  const core = await startCore({
    home: resolveJuntoHome(),
    build: runningBuildIdentity(),
    bundles,
    peerPidHelperRoots: [join(packageRoot, "bin"), resolve(dirname(entry), "../../scripts")],
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
