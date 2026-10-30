/**
 * What the core and the terminal process say to each other (protect the main
 * thread, terminal process phase 1). The messages are the core port's own
 * (`core-process/port.ts`): a `call` answered by id, and `push` on a named
 * channel, both ways. One port carries them in order, so a write posted after
 * a spawn reaches the terminal after it.
 *
 * A terminal is named by the id its spawn gave it; every other message for
 * it carries that id. Inputs and payloads are structured-clone data.
 */

/** The one call: start a PTY. Answers its pid, or fails with the spawn's message. */
export const TERMINAL_SPAWN = "pty.spawn";

export type TerminalSpawnInput = {
  readonly id: number;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cols: number;
  readonly rows: number;
};

export type TerminalSpawnOutput = { readonly pid: number | undefined };

/** The core to the terminal process: input, size and signals, never answered. */
export const TerminalInbound = {
  write: "pty.write",
  resize: "pty.resize",
  kill: "pty.kill",
} as const;

export type TerminalWrite = { readonly id: number; readonly data: string };
export type TerminalResize = { readonly id: number; readonly cols: number; readonly rows: number };
export type TerminalKill = { readonly id: number; readonly signal?: NodeJS.Signals };

/** The terminal process to the core: output, the exit witness, and I/O failures. */
export const TerminalOutbound = {
  data: "pty.data",
  exit: "pty.exit",
  error: "pty.error",
} as const;

export type TerminalData = { readonly id: number; readonly data: string };
export type TerminalExitEvent = { readonly id: number; readonly code: number | undefined; readonly signal: number | undefined };
export type TerminalError = { readonly id: number; readonly message: string };
