import { utilityProcess, type UtilityProcess } from "electron";
import terminalEntryPath from "./entry?modulePath";
import type { CoreMessage } from "../core-process/port";
import { terminalClient, type TerminalClient } from "./client";

/**
 * Main's side of the terminal process (phase 1). It forks `entry.ts` as an
 * Electron utilityProcess and gives the process plane a `TerminalClient`.
 * When the terminal process exits, every PTY it held is reported exited (its
 * children lost their terminal with it) and the next spawn starts a new one.
 *
 * Off unless `JUNTO_TERMINAL_PROCESS=1`, until keys and echo reach the
 * renderer over their own port (phase 3).
 */
export const TERMINAL_PROCESS_ENABLED = process.env.JUNTO_TERMINAL_PROCESS === "1";

export const startTerminalProcess = (): TerminalClient & { readonly stop: () => void } => {
  let child: UtilityProcess | undefined;
  let stopping = false;
  const handlers = new Set<(message: CoreMessage) => void>();

  const fork = (): UtilityProcess => {
    const forked = utilityProcess.fork(terminalEntryPath, [], { serviceName: "Junto Terminals", stdio: "inherit" });
    forked.on("message", (message: CoreMessage) => {
      for (const handler of handlers) handler(message);
    });
    forked.once("exit", (code) => {
      if (child !== forked) return;
      child = undefined;
      client.fail(`the Junto terminal process exited with code ${code}`);
    });
    return forked;
  };

  const client = terminalClient({
    post: (message) => {
      if (stopping) return;
      child ??= fork();
      child.postMessage(message);
    },
    listen: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  });

  return {
    ...client,
    stop: () => {
      stopping = true;
      child?.kill();
    },
  };
};
