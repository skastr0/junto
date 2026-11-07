/**
 * The seats channel's contract: one Rpc per request tag — the tag crosses
 * beside the payload, not in it — each answered by its own success schema,
 * with SeatsEvent as the channel's one event schema. Every refusal is the
 * closed SeatsFailure set.
 *
 * This module is a leaf: schemas and the contract only, no runtime. The
 * handlers live in seats-link.ts; the window's planes import the contract
 * from here so their module graph never reaches the link's host.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { CanvasName, NodeId } from "@shared/model";
import { MachineName } from "@shared/machine-control";
import { linkContract } from "../link/contract";
import {
  SeatsAttach, SeatsAttachEvent, SeatsAttached, SeatsCacheAnswer, SeatsCacheAnswered, SeatsDetach,
  SeatsDetached, SeatsHeld, SeatsHold, SeatsInput, SeatsResized, SeatsResize, SeatsWritten,
} from "./seat-attach";
import { SeatsRead, SeatsReadWindow } from "./seat-read-window";
import { SeatsLaunchState } from "./seats-launch";
import { SeatsFailure } from "./seats-failure";
import { SeatsStatus } from "./seats-status";

const Generation = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(256)));

export const SeatsStart = Schema.Struct({ canvas: CanvasName, seatId: NodeId });
export const SeatsGet = Schema.Struct({ canvas: CanvasName, seatId: NodeId });
export const SeatsActivate = Schema.Struct({
  canvas: CanvasName, seatId: NodeId,
  generation: Generation,
});
/** Stop the seat's occupant; with a generation, only that one. */
export const SeatsStop = Schema.Struct({
  canvas: CanvasName, seatId: NodeId,
  generation: Schema.optionalKey(Generation),
});
/** The operator viewed the seat's occupant: its finished turn is no longer unseen. */
export const SeatsViewed = Schema.Struct({
  canvas: CanvasName, seatId: NodeId,
  generation: Generation,
});
export const SeatsStarted = Schema.Struct({
  _tag: Schema.Literal("Started"), canvas: CanvasName, seatId: NodeId,
  machine: MachineName, handle: Generation, generation: Generation,
  createdAt: Schema.Number,
  status: Schema.Literals(["starting", "running"]),
});
export const SeatsVacant = Schema.Struct({
  _tag: Schema.Literal("Vacant"), canvas: CanvasName, seatId: NodeId, machine: MachineName,
  /** Get only: what the seat's next start and turn do, decided here (seats-launch.ts). */
  launch: Schema.optionalKey(SeatsLaunchState),
});
export const SeatsStopping = Schema.Struct({
  _tag: Schema.Literal("Stopping"), canvas: CanvasName, seatId: NodeId, machine: MachineName,
  generation: Generation,
});
/** A view landed on that generation; changed when it cleared anything. */
export const SeatsSeen = Schema.Struct({
  _tag: Schema.Literal("Seen"), canvas: CanvasName, seatId: NodeId, machine: MachineName,
  generation: Generation, changed: Schema.Boolean,
});
/** What a seat request (start, get, activate, stop, view) answers. */
export const SeatsSeatResponse = Schema.Union([SeatsStarted, SeatsVacant, SeatsStopping, SeatsSeen]);
/** Get's answer: the occupant, or the seat vacant with what its next start does. */
export const SeatsGetAnswer = Schema.Union([SeatsStarted, SeatsVacant]);
/** Stop's answer: already vacant, or the occupant on its way out. */
export const SeatsStopAnswer = Schema.Union([SeatsVacant, SeatsStopping]);
/** Viewed's answer: already vacant, or the view landed on that generation. */
export const SeatsViewedAnswer = Schema.Union([SeatsVacant, SeatsSeen]);
/** Read's answer: the window, or vacant. */
export const SeatsReadAnswer = Schema.Union([SeatsVacant, SeatsReadWindow]);

/**
 * A seat's state, sent by the machine that runs it to the machine that edits
 * its canvas, so the seat's ring has a producer there. reason is a rule id or
 * the state's own word: free text (a hook's words, an error) stays home.
 */
export const SeatsStateEvent = Schema.Struct({
  _tag: Schema.Literal("SeatState"), canvas: CanvasName, seatId: NodeId, machine: MachineName,
  epoch: Generation,
  state: Schema.Literals(["idle", "working", "attention", "unknown", "gone"]),
  confidence: Schema.Literals(["high", "low"]),
  at: Schema.Number,
  reason: Schema.String.pipe(Schema.check(Schema.isPattern(/^(rule:[A-Za-z0-9_.:-]{1,128}|idle|working|attention|unknown|gone)$/))),
  /**
   * The seat's status (seats-status.ts), already the reduced wire struct: a
   * status that does not read fails this event's decode before its handler runs.
   */
  status: Schema.optionalKey(SeatsStatus),
  /** What the seat's next start and turn do (seats-launch.ts), the same reduced wire struct. */
  launch: Schema.optionalKey(SeatsLaunchState),
});
export type SeatsStateEvent = typeof SeatsStateEvent.Type;
export const SeatsEvent = Schema.Union([SeatsStateEvent, ...SeatsAttachEvent.members]);

export const SeatsLink = linkContract("seats", RpcGroup.make(
  Rpc.make("Start", { payload: SeatsStart, success: SeatsStarted, error: SeatsFailure }),
  Rpc.make("Get", { payload: SeatsGet, success: SeatsGetAnswer, error: SeatsFailure }),
  Rpc.make("Activate", { payload: SeatsActivate, success: SeatsStarted, error: SeatsFailure }),
  Rpc.make("Stop", { payload: SeatsStop, success: SeatsStopAnswer, error: SeatsFailure }),
  Rpc.make("Viewed", { payload: SeatsViewed, success: SeatsViewedAnswer, error: SeatsFailure }),
  Rpc.make("Read", { payload: SeatsRead, success: SeatsReadAnswer, error: SeatsFailure }),
  Rpc.make("Attach", { payload: SeatsAttach, success: SeatsAttached, error: SeatsFailure }),
  Rpc.make("Input", { payload: SeatsInput, success: SeatsWritten, error: SeatsFailure }),
  Rpc.make("Resize", { payload: SeatsResize, success: SeatsResized, error: SeatsFailure }),
  Rpc.make("Detach", { payload: SeatsDetach, success: SeatsDetached, error: SeatsFailure }),
  Rpc.make("Hold", { payload: SeatsHold, success: SeatsHeld, error: SeatsFailure }),
  Rpc.make("CacheAnswer", { payload: SeatsCacheAnswer, success: SeatsCacheAnswered, error: SeatsFailure }),
), { event: SeatsEvent });
