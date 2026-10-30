import { installCoreReads } from "../core-runner";
import { CoreCallError, type CoreClient } from "./client";

/**
 * Main's one handle on the core (Wave 3). Every call in `index.ts`,
 * `junto/ipc.ts`, `term/ipc.ts` and their neighbours goes through
 * `core.call(name, input)`; boot installs the core process's client
 * (`useCoreClient(startCoreProcess(...))`). Electron main runs no operation
 * body itself, so a call with no client installed is a bug, and says so.
 */
let current: CoreClient | undefined;

export const core: CoreClient = {
  call: (name, input) => {
    const client = current;
    return client === undefined
      ? Promise.reject(new CoreCallError(name, "CoreClientMissing", "no core client is installed in this process"))
      : client.call(name, input);
  },
};

/**
 * Boot only: route every call to the core process. Main then has no core
 * runtime, so the shared reads (`coreReads`) ask the core by name too.
 */
export const useCoreClient = (client: CoreClient): void => {
  current = client;
  installCoreReads({
    canvas: (canvasName) => core.call("core.canvas", { canvasName }),
    machineName: () => core.call("core.machineName", {}),
    vaultScope: () => core.call("core.vaultScope", {}),
    // A spawn in main asks each time: a read held from boot would go stale.
    spawnEnv: () => core.call("ipc.shellEnvironment.env", {}),
  });
};
