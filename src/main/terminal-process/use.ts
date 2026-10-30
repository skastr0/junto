import type { TerminalClient } from "./client";

/**
 * Where new PTYs spawn (protect the main thread, phase 1). Undefined means in
 * this process (tests, the windowless core); the app installs the terminal
 * process's client. A PTY already spawned stays where it started.
 */
let current: TerminalClient | undefined;

export const terminalProcess = (): TerminalClient | undefined => current;

export const useTerminalProcess = (client: TerminalClient | undefined): void => {
  current = client;
};
