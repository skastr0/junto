import type { TerminalClient } from "./client";

/**
 * Where new PTYs spawn (protect the main thread, phase 1). With no client
 * installed a PTY runs in this process, which is right for the terminal
 * process itself, a windowless core and tests. Electron main is not one of
 * those: it holds no PTY, so a call there with nothing installed fails loudly
 * instead of spawning on the main thread and answering as if all were well.
 * A PTY already spawned stays where it started.
 */
let current: TerminalClient | undefined;

export const terminalProcess = (): TerminalClient | undefined => {
  if (current !== undefined) return current;
  // process.type is "browser" in Electron main only; a utility process and
  // node leave it undefined.
  if ((process as { readonly type?: string }).type === "browser") {
    throw new Error(
      "Electron main has no terminal process: a PTY must run in the Junto terminal process or the core, never on main",
    );
  }
  return undefined;
};

export const useTerminalProcess = (client: TerminalClient | undefined): void => {
  current = client;
};
