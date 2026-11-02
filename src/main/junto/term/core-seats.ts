import { Effect } from "effect";
import { coreRunner } from "../../core-runner";
import { resolvedSpawnEnv } from "../adapters/exec";
import { terminalProcess } from "../../terminal-process/use";
import { termPlane, termPlaneBlocksAppExit } from "./plane";

/**
 * A PTY outlives a core that dies: it lives in the terminal process, which main
 * keeps (`terminal-process/host.ts`). So the first thing a core does with its
 * terminal plane is take back the terminals the last one left running: each
 * seat's session is rebuilt from the meta its spawn carried, its credential is
 * published again, and its screen is seeded from the output the old core had
 * handled. The core calls this before anything can spawn, so a new terminal can
 * never take an id a running one holds, and after the plane's events are bound,
 * so the window hears the generations come back.
 *
 * An adoption the terminal process cannot answer is named and boot goes on: a
 * core that cannot reach it has no terminals either way, and a seat never gates
 * the window. The terminal process's refusal is a typed failure, handled here.
 */
export const adoptCoreTerminals = async (): Promise<void> => {
  const terminals = terminalProcess();
  if (terminals === undefined) return;
  try {
    await coreRunner.runPromise(
      terminals.adopt().pipe(
        Effect.flatMap((adopted) =>
          adopted.length === 0
            ? Effect.void
            : Effect.sync(() => {
                termPlane.host.adoptFromTerminalProcess(adopted);
              }),
        ),
        Effect.catchTag("TerminalAdoptFailed", (failure) =>
          Effect.sync(() => {
            console.error(
              `[term] the terminal process did not hand this core its running terminals: ${failure.message}`,
            );
          }),
        ),
      ),
    );
  } catch (error) {
    console.error("[term] adoption of the terminal process's running terminals failed:", error);
  }
};

/** The windowless shell starts the same local terminal plane as the window. */
export const startCoreSeats = async (options: { readonly home: string }) => {
  await resolvedSpawnEnv();
  await termPlane.start({ controlHome: options.home });
  let closeFlight: Promise<void> | undefined;
  return {
    beginShutdown: (reason = "core_quit"): void => termPlane.beginShutdown(reason),
    close: (reason = "core_quit"): Promise<void> => {
      closeFlight ??= (async () => {
        try {
          const receipt = await termPlane.drainOnQuit(reason);
          if (termPlaneBlocksAppExit(receipt)) {
            throw new Error(`Seat processes did not stop: ${receipt.retainedLabels.join(", ")}`);
          }
        } finally {
          // Orderly quit hangs up every PTY: the drain stops what this core
          // owns, and this reaches what it does not — a terminal adopted from
          // the last core whose record this one never rebuilt, or one a stop
          // released while its process was still alive. A crash never does
          // this: a port closing leaves the terminals running.
          terminalProcess()?.hangupAll();
        }
      })();
      return closeFlight;
    },
  };
};
