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

export type TerminalData = { readonly id: number; readonly data: string; readonly seq: number };
export type TerminalExitEvent = { readonly id: number; readonly code: number | undefined; readonly signal: number | undefined };
export type TerminalError = { readonly id: number; readonly message: string };

/**
 * Phase 3: a surface port, one MessagePort per renderer control lease, joins
 * the renderer to one PTY in the terminal process with nothing between them.
 * Keys go in and output comes out on it; the core still holds every gate and
 * tells the terminal process what they say.
 *
 * Every output chunk carries `seq`, the PTY's own count of chunks from 1, on
 * the surface port and on the core's `pty.data` alike, so a renderer that
 * also saw a chunk over IPC drops it the second time.
 */
export const TerminalSurface = {
  /** Core to terminal process, with the port transferred: start serving it from `fromSeq`. */
  open: "pty.surface",
  /** Core to terminal process: the lease ended; close its port. */
  close: "pty.surfaceEnd",
  /** Core to terminal process: the one lease whose keys may reach the PTY, or none. */
  gate: "pty.gate",
  /** Core to terminal process: a managed submission span holds keys; they replay at release. */
  hold: "pty.hold",
  /** Terminal process to core: a key arrived from a surface, before any gate decided it. */
  typing: "pty.typing",
  /** Terminal process to core: a key reached the PTY from a surface. */
  input: "pty.input",
} as const;

/** A control lease as the gate names it: the lease and the generation it controls. */
export type SurfaceLease = { readonly leaseId: string; readonly epoch: number };

export type TerminalSurfaceOpen = SurfaceLease & { readonly id: number; readonly fromSeq: number };
export type TerminalSurfaceClose = { readonly id: number; readonly leaseId: string };
/**
 * Each key is checked against the controlling lease, as the in-process write
 * is (local-host.ts write): a takeover is one gate push, and a stale or second
 * surface writes nothing even before its port is closed.
 */
export type TerminalGate = { readonly id: number; readonly lease: SurfaceLease | null };
export type TerminalHold = { readonly id: number; readonly held: boolean };
/** `pty.typing` and `pty.input` alike: which lease sent what. */
export type TerminalInput = { readonly id: number; readonly leaseId: string; readonly data: string };

/** On a surface port: the terminal process to the renderer. */
export type SurfaceOut =
  | { readonly t: "out"; readonly seq: number; readonly data: string }
  /** The chunks from `fromSeq` are gone from the ring: read the screen again. */
  | { readonly t: "gap" }
  | { readonly t: "end" };

/** On a surface port: the renderer to the terminal process. */
export type SurfaceIn = { readonly t: "in"; readonly data: string };
