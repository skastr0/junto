/**
 * What the core and the terminal process say to each other besides their
 * calls. The calls (spawn, adopt, fence) are Effect RPC, typed and decoded at
 * both ends (`rpcs.ts`). Everything here is one-way and plain structured
 * clone, posted as `{ kind: "push", channel, payload }` on the same port and
 * never answered: output, keys, acknowledgements and the core's commands.
 *
 * A terminal is named by the id its spawn gave it; every other message for
 * it carries that id. A message for a terminal whose spawn has not reached
 * the terminal process yet is held there until it does.
 */
import type { RpcPortMessage } from "../../shared/rpc-port";
import type { TerminalExitStatus } from "./rpcs";

/**
 * Main to the terminal process, with a port moved beside it: serve a core on
 * it (the core in its own process). A port that closes leaves its PTYs
 * running, detached, for the next core to adopt: a core crash kills no agent.
 */
export const TERMINAL_CONNECT = "pty.connect";

/** Handled output kept per PTY so a new core can seed the screen it lost (the core's MAX_JOURNAL_BYTES). */
export const TERMINAL_HISTORY_CHARS = 512 * 1024;

/** The core to the terminal process: input, size and signals, never answered. */
export const TerminalInbound = {
  write: "pty.write",
  resize: "pty.resize",
  kill: "pty.kill",
  /** The core has handled this many more output characters of the terminal. */
  ack: "pty.ack",
  /**
   * Orderly quit: hang up every PTY. A port closing does not. The core asks
   * this when it drains; the parent asks it when the core is gone.
   */
  hangupAll: "pty.hangupAll",
  /**
   * The parent's orderly quit: hang up every PTY, then leave. Answered by no
   * one: the process's exit is the answer, and main waits on it.
   */
  shutdown: "pty.shutdown",
  /**
   * The core heard this terminal's `pty.exit`. Only then does the terminal
   * process forget it; until then a new core's `TerminalAdopt` still names it.
   */
  exitAck: "pty.exitAck",
} as const;

export type TerminalWrite = { readonly id: number; readonly data: string };
export type TerminalResize = { readonly id: number; readonly cols: number; readonly rows: number };
export type TerminalKill = { readonly id: number; readonly signal?: NodeJS.Signals };
export type TerminalAck = { readonly id: number; readonly chars: number };
export type TerminalExitAck = { readonly id: number };

/**
 * Backpressure: a PTY whose output the core has not handled past the high
 * mark stops being read, so its child blocks on a full terminal as it would
 * if the core read it in process; it is read again below the low mark. Output
 * not yet handled is kept, so a core that dies loses none of it: with no core
 * a PTY reads to the high mark and its child blocks until one adopts it.
 * Characters, as the output strings count them.
 */
export const TERMINAL_UNACKED_HIGH = 1024 * 1024;
export const TERMINAL_UNACKED_LOW = 256 * 1024;

/** The terminal process to the core: output, the exit witness, and I/O failures. */
export const TerminalOutbound = {
  data: "pty.data",
  exit: "pty.exit",
  error: "pty.error",
} as const;

export type TerminalData = { readonly id: number; readonly data: string; readonly seq: number };
export type TerminalExitEvent = { readonly id: number } & TerminalExitStatus;
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
export type SurfaceLease = { readonly leaseId: string; readonly epoch: string };

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
  /** The chunks from `fromSeq` are gone from the ring: read the screen again. The port closes. */
  | { readonly t: "gap" }
  /**
   * One key arrived here, in order. A key the view posted that never got this
   * was lost with the port (it closed under it), and the view sends it again
   * over IPC.
   */
  | { readonly t: "took" }
  | { readonly t: "end" };

/** On a surface port: the renderer to the terminal process. */
export type SurfaceIn = { readonly t: "in"; readonly data: string };

/** One one-way message on the terminal link, either way. */
export type TerminalPush = { readonly kind: "push"; readonly channel: string; readonly payload: unknown };

/**
 * The terminal link's own envelope: RPC's frames for the calls, and the
 * one-way pushes. None of the core port's host calls ride it.
 */
export type TerminalLinkMessage = RpcPortMessage | TerminalPush;

/** One end of a terminal link: a node `MessagePort`, Electron's `MessagePortMain`, or the parent port. */
export type TerminalLinkPort = {
  readonly post: (message: TerminalLinkMessage) => void;
  readonly listen: (handler: (message: TerminalLinkMessage) => void) => () => void;
};
