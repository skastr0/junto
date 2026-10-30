import { installCoreReads } from "../core-runner";
import { AppRuntime } from "../runtime";
import { inProcessCore, type CoreClient } from "./client";
import "./ops/index";

/**
 * Main's one handle on the core (Wave 3). Call sites in `index.ts`,
 * `junto/ipc.ts` and `term/ipc.ts` move from `AppRuntime.run*` to
 * `core.call(name, input)`, with each operation's body in a group under
 * `./ops`. Boot installs the core process's client
 * (`useCoreClient(startCoreProcess(...))`); outside the app (tests) calls run in process.
 */
let current: CoreClient = inProcessCore(AppRuntime);

export const core: CoreClient = { call: (name, input) => current.call(name, input) };

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
  });
};
