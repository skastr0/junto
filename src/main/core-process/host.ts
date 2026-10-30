import { utilityProcess, type UtilityProcess } from "electron";
import coreEntryPath from "./entry?modulePath";
import type { CoreBoot } from "./entry";
import { portCore, type CoreMessage, type PortCoreClient } from "./port";

/**
 * Main's side of the core process (Wave 3). It forks `entry.ts` as an
 * Electron utilityProcess, hands it what only `app` knows, and gives main a
 * `PortCoreClient` whose calls survive a restart: a call in flight when the
 * core stops is rejected, and the next call waits for the new core. A core
 * that keeps stopping is started again after 1 s, doubling to 30 s. A core
 * that has not said `core.ready` 120 s after its fork is killed, so a boot that
 * neither finishes nor exits fails its waiting calls and starts again.
 *
 * Off until every `AppRuntime.run*` site in main calls the core by name (two
 * runtimes would mean two business writers on junto.db) and the terminal
 * process owns the PTYs (`JUNTO_TERMINAL_PROCESS`): until then seat start
 * would run on the core's plane while attach and write stay on main's.
 */
export const CORE_PROCESS_ENABLED = process.env.JUNTO_CORE_PROCESS === "1";

const RESTART_FIRST_MS = 1_000;
const RESTART_MAX_MS = 30_000;
const RESTART_SETTLED_MS = 60_000;
const BOOT_DEADLINE_MS = 120_000;

export const startCoreProcess = (boot: CoreBoot): PortCoreClient & { readonly stop: () => void } => {
  let child: UtilityProcess | undefined;
  let stopping = false;
  let stops = 0;
  let startedAt = 0;
  const handlers = new Set<(message: CoreMessage) => void>();
  // Between a core's exit and its restart, messages wait here for the next one;
  // after stop there is no next one, so a call fails at once.
  const held: CoreMessage[] = [];
  const client = portCore({
    post: (message) => {
      if (child !== undefined) return child.postMessage(message);
      if (!stopping) return void held.push(message);
      queueMicrotask(() => client.fail("the Junto core process has stopped"));
    },
    listen: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  });

  let booting: ReturnType<typeof setTimeout> | undefined;
  client.onPush("core.ready", () => {
    clearTimeout(booting);
    booting = undefined;
  });

  const start = (): void => {
    if (stopping) return;
    const forked = utilityProcess.fork(coreEntryPath, [JSON.stringify(boot)], { serviceName: "Junto Core", stdio: "inherit" });
    child = forked;
    startedAt = Date.now();
    for (const message of held.splice(0)) forked.postMessage(message);
    booting = setTimeout(() => {
      if (child === forked) forked.kill();
    }, BOOT_DEADLINE_MS);
    booting.unref();
    forked.on("message", (message: CoreMessage) => {
      for (const handler of handlers) handler(message);
    });
    forked.once("exit", (code) => {
      if (child !== forked) return;
      clearTimeout(booting);
      booting = undefined;
      child = undefined;
      client.fail(`the Junto core process exited with code ${code}`);
      if (stopping) return;
      if (Date.now() - startedAt > RESTART_SETTLED_MS) stops = 0;
      setTimeout(start, Math.min(RESTART_MAX_MS, RESTART_FIRST_MS * 2 ** stops)).unref();
      stops += 1;
    });
  };

  start();
  return {
    ...client,
    stop: () => {
      stopping = true;
      held.length = 0;
      child?.kill();
      if (child === undefined) client.fail("the Junto core process has stopped");
    },
  };
};
