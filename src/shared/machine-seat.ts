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

export const MachineSeatStopped = Schema.Struct({ canvas: CanvasName, seatId: MachineSeatId, outcome: Schema.Literals(["stopping", "vacant"]) });
export type MachineSeatStopped = typeof MachineSeatStopped.Type;
