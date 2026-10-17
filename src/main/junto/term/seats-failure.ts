/**
 * Why a seat start or read failed, as values that cross a machine whole.
 *
 * Every field is a name, an id, an epoch, a reason class or error text
 * (docs/machines.md "Failures and logs"). No environment value, token or
 * credential is ever placed here.
 */
import { Schema } from "effect";
import { MachineName } from "@shared/machine-control";
import { CanvasName, NodeId } from "@shared/model";

/** Error text is capped at 1 KiB (docs/security-doctrine.md, Failures and logs). */
export const TEXT_MAX = 1024;
const Text = Schema.String.pipe(Schema.check(Schema.isMaxLength(TEXT_MAX)));
const Id = Schema.String.pipe(Schema.check(Schema.isMaxLength(256)));
const Where = { machine: MachineName, canvas: CanvasName, seatId: NodeId };
export type SeatsFailureWhere = {
  readonly machine: string; readonly canvas: CanvasName; readonly seatId: NodeId;
};

export const clipText = (text: string): string => text.slice(0, TEXT_MAX);

/**
 * The occupant ended before it owned its terminal: the harness could not
 * start. exitMessage is the seat machine's classification of the spawn error
 * (classifySpawnFailure), never terminal output.
 */
export class SeatSpawnFailed extends Schema.TaggedError<SeatSpawnFailed>()("SeatSpawnFailed", {
  ...Where, bindingId: Id, harness: Id, epoch: Id,
  exitReason: Schema.Literals(["cli-missing", "spawn_failed"]),
  exitMessage: Text, message: Text,
}) {}

/**
 * The occupant ended right after its start, after it owned its terminal. What
 * it printed is terminal bytes and is read in its terminal, never carried here.
 */
export class SeatExited extends Schema.TaggedError<SeatExited>()("SeatExited", {
  ...Where, bindingId: Id, epoch: Id, message: Text,
}) {}

/** Another generation took the seat between the start and its answer. */
export class SeatEpochChanged extends Schema.TaggedError<SeatEpochChanged>()("SeatEpochChanged", {
  ...Where, expectedEpoch: Id, actualEpoch: Schema.optionalKey(Id), message: Text,
}) {}

/** The live occupant is a different actor than the seat names. */
export class SeatOccupantChanged extends Schema.TaggedError<SeatOccupantChanged>()("SeatOccupantChanged", {
  ...Where, epoch: Id, message: Text,
}) {}

/** The occupant is being stopped and is not a start to answer with. */
export class SeatStopping extends Schema.TaggedError<SeatStopping>()("SeatStopping", {
  ...Where, epoch: Id, message: Text,
}) {}

/** The seat's machine would not stop its occupant. */
export class SeatStopRefused extends Schema.TaggedError<SeatStopRefused>()("SeatStopRefused", {
  ...Where, epoch: Id, message: Text,
}) {}

/** The seat has no occupant: nothing was started, or its state is unknown. */
export class SeatMissing extends Schema.TaggedError<SeatMissing>()("SeatMissing", {
  ...Where, message: Text,
}) {}

/** The canvas copy changed the seat while its start was being prepared. */
export class SeatChangedWhilePreparing extends Schema.TaggedError<SeatChangedWhilePreparing>()(
  "SeatChangedWhilePreparing", { ...Where, message: Text },
) {}

/** The seat is not an agent seat placed on this machine. */
export class SeatNotOnThisMachine extends Schema.TaggedError<SeatNotOnThisMachine>()("SeatNotOnThisMachine", {
  ...Where, seatHost: Schema.optionalKey(Id), message: Text,
}) {}

/** The asking machine does not edit this canvas. */
export class SeatCanvasEditorMismatch extends Schema.TaggedError<SeatCanvasEditorMismatch>()(
  "SeatCanvasEditorMismatch", { ...Where, peer: Id, message: Text },
) {}

/** The asking machine is no longer pinned on this one. */
export class SeatPeerNotPinned extends Schema.TaggedError<SeatPeerNotPinned>()("SeatPeerNotPinned", {
  ...Where, peer: Id, message: Text,
}) {}

/** The seat's harness session could not be prepared before the start. */
export class SeatSessionUnavailable extends Schema.TaggedError<SeatSessionUnavailable>()(
  "SeatSessionUnavailable", { ...Where, reason: Text, message: Text },
) {}

/** The start was refused or failed on this machine for a reason with its own type upstream. */
export class SeatStartRefused extends Schema.TaggedError<SeatStartRefused>()("SeatStartRefused", {
  ...Where, causeTag: Id, message: Text,
}) {}

/** The link that asked closed before the answer. */
export class SeatLinkClosed extends Schema.TaggedError<SeatLinkClosed>()("SeatLinkClosed", {
  ...Where, message: Text,
}) {}

/** A seat state arrived from a machine that does not run that seat. */
export class SeatStateNotFromItsMachine extends Schema.TaggedError<SeatStateNotFromItsMachine>()(
  "SeatStateNotFromItsMachine", { ...Where, peer: Id, message: Text },
) {}

/** The closed set the seats channel answers with. */
export const SeatsFailure = Schema.Union([
  SeatSpawnFailed, SeatExited, SeatEpochChanged, SeatOccupantChanged, SeatStopping, SeatMissing,
  SeatChangedWhilePreparing, SeatNotOnThisMachine, SeatCanvasEditorMismatch, SeatPeerNotPinned,
  SeatSessionUnavailable, SeatStartRefused, SeatLinkClosed, SeatStopRefused, SeatStateNotFromItsMachine,
]);
export type SeatsFailure = typeof SeatsFailure.Type;

export const isSeatsFailure = Schema.is(SeatsFailure);

/**
 * The seats failure a link failure carries as its decoded detail, if any.
 * Anything else is returned as it came.
 */
export const unwrapSeatsFailure = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null && "detail" in cause && isSeatsFailure(cause.detail)
    ? cause.detail : cause;

/** Keep a seats failure as it is; carry anything else as a refusal with its tag and text. */
export const asSeatsFailure = (where: SeatsFailureWhere, cause: unknown): SeatsFailure => {
  if (isSeatsFailure(cause)) return cause;
  const tagged = typeof cause === "object" && cause !== null && "_tag" in cause && typeof cause._tag === "string"
    ? cause._tag : cause instanceof Error ? cause.name : "Unknown";
  const text = cause instanceof Error ? cause.message : String(cause);
  return new SeatStartRefused({ ...where, causeTag: tagged.slice(0, 256), message: clipText(text) });
};
