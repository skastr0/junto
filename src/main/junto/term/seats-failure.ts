/**
 * Why a seat start or read failed, as values that cross a machine whole.
 *
 * Every field is a name, an id, an epoch, a reason class or error text
 * (docs/machines.md "Failures and logs"). No environment value, token or
 * credential is ever placed here.
 */
import { Schema } from "effect";

const Text = Schema.String.pipe(Schema.check(Schema.isMaxLength(2048)));
const Where = { machine: Schema.String, canvas: Schema.String, seatId: Schema.String };

/**
 * The occupant ended before it owned its terminal: the harness could not
 * start. exitMessage is the seat machine's classification of the spawn error
 * (classifySpawnFailure), never terminal output.
 */
export class SeatSpawnFailed extends Schema.TaggedError<SeatSpawnFailed>()("SeatSpawnFailed", {
  ...Where, bindingId: Schema.String, harness: Schema.String,
  exitReason: Schema.Literals(["cli-missing", "spawn_failed"]),
  exitMessage: Text, message: Text,
}) {}

/**
 * The occupant ended right after its start, after it owned its terminal. What
 * it printed is terminal bytes and is read in its terminal, never carried here.
 */
export class SeatExited extends Schema.TaggedError<SeatExited>()("SeatExited", {
  ...Where, bindingId: Schema.String, epoch: Schema.String, message: Text,
}) {}

/** Another generation took the seat between the start and its answer. */
export class SeatEpochChanged extends Schema.TaggedError<SeatEpochChanged>()("SeatEpochChanged", {
  ...Where, expectedEpoch: Schema.String, actualEpoch: Schema.optionalKey(Schema.String), message: Text,
}) {}

/** The live occupant is a different actor than the seat names. */
export class SeatOccupantChanged extends Schema.TaggedError<SeatOccupantChanged>()("SeatOccupantChanged", {
  ...Where, epoch: Schema.String, message: Text,
}) {}

/** The occupant is being stopped and is not a start to answer with. */
export class SeatStopping extends Schema.TaggedError<SeatStopping>()("SeatStopping", {
  ...Where, epoch: Schema.String, message: Text,
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
  ...Where, seatHost: Schema.optionalKey(Schema.String), message: Text,
}) {}

/** The asking machine does not edit this canvas. */
export class SeatCanvasEditorMismatch extends Schema.TaggedError<SeatCanvasEditorMismatch>()(
  "SeatCanvasEditorMismatch", { ...Where, peer: Schema.String, message: Text },
) {}

/** The asking machine is no longer pinned on this one. */
export class SeatPeerNotPinned extends Schema.TaggedError<SeatPeerNotPinned>()("SeatPeerNotPinned", {
  ...Where, peer: Schema.String, message: Text,
}) {}

/** The seat's harness session could not be prepared before the start. */
export class SeatSessionUnavailable extends Schema.TaggedError<SeatSessionUnavailable>()(
  "SeatSessionUnavailable", { ...Where, reason: Text, message: Text },
) {}

/** The start was refused or failed on this machine for a reason with its own type upstream. */
export class SeatStartRefused extends Schema.TaggedError<SeatStartRefused>()("SeatStartRefused", {
  ...Where, causeTag: Schema.String, message: Text,
}) {}

/** The link that asked closed before the answer. */
export class SeatLinkClosed extends Schema.TaggedError<SeatLinkClosed>()("SeatLinkClosed", {
  ...Where, message: Text,
}) {}

/** The closed set the seats channel answers with. */
export const SeatsFailure = Schema.Union([
  SeatSpawnFailed, SeatExited, SeatEpochChanged, SeatOccupantChanged, SeatStopping, SeatMissing,
  SeatChangedWhilePreparing, SeatNotOnThisMachine, SeatCanvasEditorMismatch, SeatPeerNotPinned,
  SeatSessionUnavailable, SeatStartRefused, SeatLinkClosed,
]);
export type SeatsFailure = typeof SeatsFailure.Type;

const isSeatsFailure = Schema.is(SeatsFailure);

/** Keep a seats failure as it is; carry anything else as a refusal with its tag and text. */
export const asSeatsFailure = (where: {
  readonly machine: string; readonly canvas: string; readonly seatId: string;
}, cause: unknown): SeatsFailure => {
  if (isSeatsFailure(cause)) return cause;
  const tagged = typeof cause === "object" && cause !== null && "_tag" in cause && typeof cause._tag === "string"
    ? cause._tag : cause instanceof Error ? cause.name : "Unknown";
  const text = cause instanceof Error ? cause.message : String(cause);
  return new SeatStartRefused({ ...where, causeTag: tagged, message: text.slice(0, 2048) });
};
