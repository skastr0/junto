/**
 * The work socket's seat.* and preamble ops, as one Effect `RpcGroup`: each
 * op's arguments, its answer and its refusal. Owned by cli-identity. The core
 * serves the group (`src/core/work-control/seat-ops.ts`) and the CLI calls it
 * (`src/cli`), so a change to an op's arguments or answer fails the compile
 * of both, and a missing handler fails the core's.
 *
 * Each op's tag is its v1 name, and the wire stays v1: the arguments are the
 * frame's `args`, the answer its `data`, and the refusal its `error`.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { PreambleArgs } from "../../shared/work-control";
import { SeatReadBriefView, SeatReadRequest, SeatReadView, SeatWaitRequest, SeatWaitView } from "../../shared/seat-control";
import { PreambleEventSchema } from "../../shared/preamble";
import { WorkFailure } from "./failure";

const { preambleId, canvasName, nodeId, text, expiresAt } = PreambleEventSchema.fields;

/** The seat's own preamble as it was shown: the event the canvas paints, applied here. */
export const PreambleAnswer = Schema.Struct({
  preambleId,
  canvasName,
  nodeId,
  text,
  expiresAt,
  disposition: Schema.Literal("applied"),
});

/**
 * `seat read` on one seat, with its screen, or `--brief` on every peer, without one.
 * Both answer collaboration state only; process and PTY internals ride
 * `internals`, for an overseer that asks.
 */
export const SeatReadAnswer = Schema.Union([SeatReadView, SeatReadBriefView]);

export const Preamble = Rpc.make("preamble", { payload: PreambleArgs, success: PreambleAnswer, error: WorkFailure });
export const SeatWait = Rpc.make("seat.wait", { payload: SeatWaitRequest, success: SeatWaitView, error: WorkFailure });
export const SeatRead = Rpc.make("seat.read", { payload: SeatReadRequest, success: SeatReadAnswer, error: WorkFailure });

/** Decoded strictly where the core serves it: an argument or an answer field the contract does not name is refused. */
export const SeatRpcs = RpcGroup.make(Preamble, SeatWait, SeatRead).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });
