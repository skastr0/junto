import type { TerminalClient } from "./client";

/**
 * Where new PTYs spawn (protect the main thread, phase 1). Undefined means in
 * this process, as always; boot installs the terminal process's client when
 * `JUNTO_TERMINAL_PROCESS=1`. A PTY already spawned stays where it started.
 */
let current: TerminalClient | undefined;

export const terminalProcess = (): TerminalClient | undefined => current;

export const useTerminalProcess = (client: TerminalClient | undefined): void => {
  current = client;
};
