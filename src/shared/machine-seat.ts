import { Schema } from "effect";
import { CanvasName } from "./model/base";
import { NodeId } from "./physics/schema";
import { TerminalSessionStatus } from "./terminal";

/** A seat named the way the canvas names it: by canvas and node id. */
export const MachineSeatId = NodeId.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,128}$/u)));
export const MachineSeatInput = Schema.Struct({ canvas: CanvasName, seatId: MachineSeatId });
export type MachineSeatInput = typeof MachineSeatInput.Type;
/** `resume` false starts a fresh session where one could be resumed. */
export const MachineSeatStartInput = Schema.Struct({ canvas: CanvasName, seatId: MachineSeatId, resume: Schema.optionalKey(Schema.Boolean) });
export type MachineSeatStartInput = typeof MachineSeatStartInput.Type;

const Text = Schema.String.pipe(Schema.check(Schema.isMaxLength(1024)));

/**
 * What the start produced. A refused spawn is an answer, not a failure: the
 * status is exited, with the exit reason and the scrubbed exit message.
 */
export const MachineSeatStarted = Schema.Struct({
  canvas: CanvasName,
  seatId: MachineSeatId,
  hostId: Text,
  bindingId: Text,
  status: TerminalSessionStatus,
  stopping: Schema.optionalKey(Schema.Literal(true)),
  resuming: Schema.optionalKey(Schema.Literal(true)),
  exitReason: Schema.optionalKey(Schema.Literals(["cli-missing", "spawn_failed"])),
  exitMessage: Schema.optionalKey(Text),
});
export type MachineSeatStarted = typeof MachineSeatStarted.Type;

/** Read a seat's settled terminal grid: its last lines (default 40, at most 2000). */
export const MachineSeatReadInput = Schema.Struct({
  canvas: CanvasName, seatId: MachineSeatId,
  lines: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isBetween({ minimum: 1, maximum: 2000 })))),
});
export type MachineSeatReadInput = typeof MachineSeatReadInput.Type;
const Count = (max: number) => Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isBetween({ minimum: 0, maximum: max })));

/**
 * What the seat's terminal shows, read on the machine that runs it. text is
 * terminal output for the owner who asked, at most 256 KiB, and only here:
 * vacant seats answer without it.
 */
export const MachineSeatRead = Schema.Struct({
  canvas: CanvasName,
  seatId: MachineSeatId,
  hostId: Text,
  vacant: Schema.Boolean,
  generation: Schema.optionalKey(Text),
  text: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(256 * 1024)))),
  lines: Schema.optionalKey(Count(2000)),
  cols: Schema.optionalKey(Count(1000)),
  rows: Schema.optionalKey(Count(500)),
  truncated: Schema.optionalKey(Schema.Boolean),
});
export type MachineSeatRead = typeof MachineSeatRead.Type;

export const MachineSeatStopped = Schema.Struct({ canvas: CanvasName, seatId: MachineSeatId, outcome: Schema.Literals(["stopping", "vacant"]) });
export type MachineSeatStopped = typeof MachineSeatStopped.Type;
