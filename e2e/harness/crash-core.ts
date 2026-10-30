/**
 * The one place an e2e proof may end the core.
 *
 * A crash proof has to take the core down under a live window, and no product
 * seam exists for that on purpose: the core is stopped through its own child
 * handle. A test that reached for `process.kill(pid)` with a pid read from a log
 * would be the exact shape the machine-safety doctrine forbids, so the power
 * lives here, once, behind four checks, and every spec asks for a crash instead
 * of handling a pid:
 *
 * 1. the pid comes from the core's own line (`[core] pid <n>`), never a guess;
 * 2. that pid is alive (signal 0 is admitted);
 * 3. walking `ps -o ppid=` up from it reaches the main process of the app this
 *    harness launched, within DESCENT_LIMIT steps, so a recycled or unrelated
 *    pid is refused rather than signalled;
 * 4. every refusal is a typed CoreCrashRefused, never a throw, and says which
 *    check failed.
 *
 * Operator approval, 2026-10-30: the exception is this file and nothing else,
 * and tests/tooling-process-safety-architecture.test.ts holds it that way.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import type { ElectronApplication } from "playwright-core";

/** The launched app, or the Playwright handle that owns its main process. */
export type LaunchedApp = { readonly app: Pick<ElectronApplication, "process"> };

export class CoreCrashRefused extends Schema.TaggedError<CoreCrashRefused>()("CoreCrashRefused", {
  reason: Schema.Literals(["no-core-pid", "core-not-live", "not-a-descendant"]),
  detail: Schema.String,
}) {}

const DESCENT_LIMIT = 8;
const CORE_PID_LINE = /\[core\] pid (\d+)/gu;

/** Every core pid the app printed, oldest line first, read from the core's own log. */
export const corePidsIn = (logDir: string): ReadonlyArray<number> => {
  const roots = ((): ReadonlyArray<string> => {
    try {
      return readdirSync(logDir);
    } catch {
      return [];
    }
  })();
  return [...roots]
    .sort()
    .flatMap((name: string) => {
      try {
        return [...readFileSync(join(logDir, name), "utf8").matchAll(CORE_PID_LINE)].map((match) =>
          Number(match[1]),
        );
      } catch {
        return [];
      }
    });
};

/** The parent of a live pid, or undefined when it is gone or ps cannot answer. */
const parentOf = (pid: number): number | undefined => {
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const parent = Number(out);
    return Number.isInteger(parent) && parent > 0 ? parent : undefined;
  } catch {
    return undefined;
  }
};

/** True when `pid` is a live descendant of `ancestor`, within DESCENT_LIMIT steps. */
export const isDescendantOf = (pid: number, ancestor: number): boolean => {
  let cursor = pid;
  for (let step = 0; step < DESCENT_LIMIT; step += 1) {
    const parent = parentOf(cursor);
    if (parent === undefined) return false;
    if (parent === ancestor) return true;
    cursor = parent;
  }
  return false;
};

/** Is a live process there? Signal 0 is admitted, and nothing is signalled. */
const isLive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Kill the core the launched app reported, after proving it is that app's own
 * descendant. Returns the pid that was signalled.
 */
export const crashCore = (
  junto: LaunchedApp,
  logDir: string,
): Effect.Effect<number, CoreCrashRefused> =>
  Effect.gen(function* () {
    const pids = corePidsIn(logDir);
    const corePid = pids.at(-1);
    if (corePid === undefined) {
      return yield* CoreCrashRefused.make({
        reason: "no-core-pid",
        detail: `no core pid line under ${logDir}`,
      });
    }
    if (!isLive(corePid)) {
      return yield* CoreCrashRefused.make({
        reason: "core-not-live",
        detail: `core pid ${String(corePid)} is gone; the proof needs a live core to kill`,
      });
    }
    const appPid = junto.app.process().pid;
    if (appPid === undefined || !isDescendantOf(corePid, appPid)) {
      return yield* CoreCrashRefused.make({
        reason: "not-a-descendant",
        detail: `pid ${String(corePid)} is not a live descendant of the launched app ${String(appPid ?? "without a pid")}`,
      });
    }
    process.kill(corePid, "SIGKILL");
    return corePid;
  });

/** The same, at the promise edge a Playwright spec calls from. */
export const crashCoreNow = async (junto: LaunchedApp, logDir: string): Promise<number> =>
  Effect.runPromise(crashCore(junto, logDir));
