/**
 * The terminal link's one-way messages, never answered: the core's commands
 * to the terminal process, main's commands to it, and the terminal process's
 * events to the core. Each direction is one union of tagged structs, and each
 * side serves a record with a handler for every tag, so a message added here
 * fails the compile of the side that must handle it, and a changed field
 * fails the side that posts it.
 *
 * No correctness rests on the order messages arrive in. Every command for a
 * terminal carries `n`, that terminal's control number (its spawn is 1), and
 * the terminal process applies a terminal's commands in `n` order. Output
 * carries `seq`, an exit `afterSeq`, an acknowledgement `throughSeq`, and a
 * key event `k`, so each is placed by its number and a repeat is dropped.
 *
 * Every count is a `TerminalCount`, a whole number from 0. At each edge the
 * control tags are decoded closed, so a drifted count there is refused; the
 * hot tags (`write`, `ack`, `data`, `typing`, `input`) pass typed with no
 * decode (`edge.ts`), so theirs is held by the compiler alone.
 */
import { Schema } from "effect";
import { TerminalCount, TerminalExitStatus } from "./rpcs";

/** A control lease as the gate names it: the lease and the generation it controls. */
export const SurfaceLease = Schema.Struct({ leaseId: Schema.String, epoch: Schema.String });
export type SurfaceLease = typeof SurfaceLease.Type;

/** A signal the core may ask the terminal process to send a PTY. */
export const KillSignal = Schema.Literals([
  "SIGABRT", "SIGALRM", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT", "SIGIO",
  "SIGIOT", "SIGKILL", "SIGPIPE", "SIGPOLL", "SIGPROF", "SIGPWR", "SIGQUIT", "SIGSEGV", "SIGSTKFLT",
  "SIGSTOP", "SIGSYS", "SIGTERM", "SIGTRAP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGUNUSED", "SIGURG",
  "SIGUSR1", "SIGUSR2", "SIGVTALRM", "SIGWINCH", "SIGXCPU", "SIGXFSZ", "SIGBREAK", "SIGLOST", "SIGINFO",
]);
export type KillSignal = typeof KillSignal.Type;

/** Every command for one terminal: its id, and its control number, the spawn being 1. */
const forTerminal = { id: Schema.Number, n: TerminalCount };

// The core to the terminal process.

/** Input for the PTY, as the core decided it. Hot: typed, never decoded. */
export const TerminalWrite = Schema.TaggedStruct("write", { ...forTerminal, data: Schema.String });
export type TerminalWrite = typeof TerminalWrite.Type;

export const TerminalResize = Schema.TaggedStruct("resize", { ...forTerminal, cols: Schema.Number, rows: Schema.Number });
export type TerminalResize = typeof TerminalResize.Type;

/** Signal the PTY, guarded by its epoch; with no signal, node-pty's default. */
export const TerminalKill = Schema.TaggedStruct("kill", { ...forTerminal, signal: Schema.optionalKey(KillSignal) });
export type TerminalKill = typeof TerminalKill.Type;

/**
 * The core has handled the terminal's output through chunk `throughSeq`.
 * Cumulative, so a late or repeated one changes nothing. Hot: typed, never
 * decoded.
 */
export const TerminalAck = Schema.TaggedStruct("ack", { ...forTerminal, throughSeq: TerminalCount });
export type TerminalAck = typeof TerminalAck.Type;

/** The one lease whose keys may reach the PTY, or none. */
export const TerminalGate = Schema.TaggedStruct("gate", { ...forTerminal, lease: Schema.NullOr(SurfaceLease) });
export type TerminalGate = typeof TerminalGate.Type;

/** A managed submission span holds keys; they replay, checked again, at release. */
export const TerminalHold = Schema.TaggedStruct("hold", { ...forTerminal, held: Schema.Boolean });
export type TerminalHold = typeof TerminalHold.Type;

/**
 * Serve the surface port moved beside this message, from chunk `fromSeq`.
 * Carries a port: its handler is given it.
 */
export const TerminalSurfaceOpen = Schema.TaggedStruct("surfaceOpen", {
  ...forTerminal,
  ...SurfaceLease.fields,
  fromSeq: TerminalCount,
});
export type TerminalSurfaceOpen = typeof TerminalSurfaceOpen.Type;

/** The lease ended; close its surface port. */
export const TerminalSurfaceEnd = Schema.TaggedStruct("surfaceEnd", { ...forTerminal, leaseId: Schema.String });
export type TerminalSurfaceEnd = typeof TerminalSurfaceEnd.Type;

/** The core heard this terminal's exit; only now does the terminal process forget it. */
export const TerminalExitAck = Schema.TaggedStruct("exitAck", forTerminal);
export type TerminalExitAck = typeof TerminalExitAck.Type;

/** Orderly quit of the core: hang up every PTY. A port closing does not. Safe to repeat. */
export const TerminalHangupAll = Schema.TaggedStruct("hangupAll", {});
export type TerminalHangupAll = typeof TerminalHangupAll.Type;

export const Command = Schema.Union([
  TerminalWrite,
  TerminalResize,
  TerminalKill,
  TerminalAck,
  TerminalGate,
  TerminalHold,
  TerminalSurfaceOpen,
  TerminalSurfaceEnd,
  TerminalExitAck,
  TerminalHangupAll,
]);
export type Command = typeof Command.Type;

// Main to the terminal process, on its parent port.

/**
 * Serve a core on the port moved beside this message. `generation` is
 * main's count of the cores it started: a port is attached only if its
 * generation is higher than the one attached. Carries a port.
 */
export const TerminalConnect = Schema.TaggedStruct("connect", { generation: TerminalCount });
export type TerminalConnect = typeof TerminalConnect.Type;

/** Main's orderly quit: hang up every PTY, then leave. The process's exit is the answer. */
export const TerminalShutdown = Schema.TaggedStruct("shutdown", {});
export type TerminalShutdown = typeof TerminalShutdown.Type;

export const ParentCommand = Schema.Union([TerminalConnect, TerminalShutdown]);
export type ParentCommand = typeof ParentCommand.Type;

// The terminal process to the core.

/** One PTY read, chunk `seq` of that PTY counting from 1. Hot: typed, never decoded. */
export const TerminalData = Schema.TaggedStruct("data", { id: Schema.Number, seq: TerminalCount, data: Schema.String });
export type TerminalData = typeof TerminalData.Type;

/** The PTY ended after chunk `afterSeq`; the core applies it once output through that chunk is applied. */
export const TerminalExit = Schema.TaggedStruct("exit", {
  id: Schema.Number,
  afterSeq: TerminalCount,
  ...TerminalExitStatus.fields,
});
export type TerminalExit = typeof TerminalExit.Type;

/** A write, resize or key failed at the PTY. */
export const TerminalError = Schema.TaggedStruct("error", { id: Schema.Number, message: Schema.String });
export type TerminalError = typeof TerminalError.Type;

/** Fields of a key event: the terminal's event number `k`, and which lease sent what. */
const keyEvent = { id: Schema.Number, k: TerminalCount, leaseId: Schema.String, data: Schema.String };

/** A key arrived from a surface, before any gate decided it. Hot: typed, never decoded. */
export const TerminalTyping = Schema.TaggedStruct("typing", keyEvent);
export type TerminalTyping = typeof TerminalTyping.Type;

/** A key from a surface reached the PTY. Hot: typed, never decoded. */
export const TerminalInput = Schema.TaggedStruct("input", keyEvent);
export type TerminalInput = typeof TerminalInput.Type;

export const Event = Schema.Union([TerminalData, TerminalExit, TerminalError, TerminalTyping, TerminalInput]);
export type Event = typeof Event.Type;

// What the edges know of the tags.

/** The commands posted per keystroke or per output turn: typed, never decoded. */
export const RAW_COMMAND_TAGS = ["write", "ack"] as const satisfies ReadonlyArray<Command["_tag"]>;
export type RawCommandTag = (typeof RAW_COMMAND_TAGS)[number];

/** The events posted per PTY read or keystroke: typed, never decoded. */
export const RAW_EVENT_TAGS = ["data", "typing", "input"] as const satisfies ReadonlyArray<Event["_tag"]>;
export type RawEventTag = (typeof RAW_EVENT_TAGS)[number];

/** The messages a port is moved beside. Their handlers are given that port. */
export const PORT_TAGS = ["surfaceOpen", "connect"] as const satisfies ReadonlyArray<(Command | ParentCommand)["_tag"]>;
export type PortTag = (typeof PORT_TAGS)[number];

/** One message's handler: given the port moved beside it when its tag carries one. */
export type HandlerOf<M extends { readonly _tag: string }, P> = M["_tag"] extends PortTag
  ? (message: M, port: P) => void
  : (message: M) => void;

/** A handler for every tag of a union, required: a tag added to the union fails the record's compile. */
export type HandlersOf<U extends { readonly _tag: string }, P = never> = {
  readonly [M in U as M["_tag"]]: HandlerOf<M, P>;
};

/** What the terminal process serves for its core. `P` is the surface port as that process holds one. */
export type CommandHandlers<P> = HandlersOf<Command, P>;
/** What the terminal process serves for main. `P` is the core's port as that process holds one. */
export type ParentCommandHandlers<P> = HandlersOf<ParentCommand, P>;
/** What the core serves for its terminal process. */
export type EventHandlers = HandlersOf<Event>;

// Frames, as they cross a port. A port rides in postMessage's transfer list, never in the data.

export type CommandFrame<M extends Command = Command> = { readonly kind: "command"; readonly message: M };
export type ParentFrame<M extends ParentCommand = ParentCommand> = { readonly kind: "parent"; readonly message: M };
export type EventFrame = { readonly kind: "event"; readonly message: Event };

/** A command frame posted with no port; a port-carrying one goes through a transfer. */
export type PortlessCommandFrame = CommandFrame<Exclude<Command, { readonly _tag: PortTag }>>;
/** The frames that must be posted with their port, and only with it. */
export type PortCommandFrame = CommandFrame<Extract<Command, { readonly _tag: PortTag }>>;
export type PortParentFrame = ParentFrame<Extract<ParentCommand, { readonly _tag: PortTag }>>;

/** Post a port-carrying frame with its port; the type allows no frame without one, and no port without its frame. */
export type TerminalLinkTransfer<P> = (frame: PortCommandFrame, port: P) => void;
