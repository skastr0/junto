/**
 * `seat.control` and `seat.control.settled`: the closed row pair by which an
 * automation starts or stops a seat on another machine (plan 0.11/05, S4;
 * machines.md Rule 6).
 *
 * The automation's machine writes the control under the automation's own
 * identity; it is held and delivered as mail is. The seat's machine admits it
 * only from the automation's machine at the canvas count the row states, acts
 * at most once per (firing, action), and writes the settled row, which waits
 * for a path to the automation's machine the same way. A seat on the
 * automation's own machine is controlled there, with no row.
 *
 * This is a closed verb on a seat the operator drew, never general execution:
 * the row carries no text, no command and no content, only the verb and the
 * firing it answers for.
 */
import { Schema } from "effect";
import { AUTOMATION_STEPS_MAX, FiringId, type Action } from "./automation";
import { AUTOMATION_SEAT_ID, AutomationNodeId } from "./mail-author";
import type { InstallationId } from "./installation-id";
import type { NodeId } from "./model/base";
import type { AutomationAuthor } from "./region-reach";
import { automationTargets, type ReachCanvas } from "./region-reach";
import type { RefusalReason } from "./resource-command";
import { ActorRef, OPERATOR_SEAT_ID, WorkNodeId } from "./work-reference";
import { ItemId } from "./work-ids";

/** The only two things a control row may ask for. */
export const SeatControlOp = Schema.Literals(["start", "stop"]);
export type SeatControlOp = typeof SeatControlOp.Type;

/**
 * Why a control was refused, in six closed words (security review, S4): the
 * command-domain `RefusalReason` is not reused, so no command reason leaks
 * across, and a spawn's words never ride the row. `not_permitted` covers an
 * archived or moved automation, a node that is no seat, and a seat outside
 * reach; `failed` covers every act-level failure, whose classification lives
 * under Failures and logs only.
 */
export const SeatControlRefusal = Schema.Literals([
  "not_permitted",
  "not_found",
  "paused",
  "stale",
  "rate",
  "failed",
]);
export type SeatControlRefusal = typeof SeatControlRefusal.Type;

/** The firing's action ruling reads a command `RefusalReason`; the row's own word maps here. */
export const SEAT_CONTROL_REFUSAL_TO_RULING: { readonly [R in SeatControlRefusal]: RefusalReason } = {
  not_permitted: "not_permitted",
  not_found: "unknown_target",
  paused: "not_available",
  stale: "stale",
  rate: "queue_full",
  failed: "not_available",
};

/**
 * A pending control's age bound: a day on either clock — the row's own
 * `originAt` (unparseable counts as ancient) and the machine's first sight of
 * it — settles it refused `stale`, so a machine asleep a week never starts a
 * seat from last week.
 */
export const SEAT_CONTROL_PENDING_MAX_MS = 24 * 60 * 60 * 1000;
/** At most this many settles per seat per rolling minute, counted on the seat's machine. */
export const SEAT_CONTROL_RATE_LIMIT = 6;
export const SEAT_CONTROL_RATE_WINDOW_MS = 60_000;

/** The action step the control answers for, inside its firing's `then`. */
const ActionIndex = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: AUTOMATION_STEPS_MAX - 1 }));

/**
 * What one control and its settlement both name, once: the seat it is for,
 * the automation that asked (by its Automations node and its id, as
 * `automation_placements` keys it), and the firing and action step it came
 * from. The row's item id is derived from the firing and action index, so a
 * retried firing names the same control.
 */
const controlKeyFields = {
  seat: WorkNodeId,
  automationNode: AutomationNodeId,
  automationId: ItemId,
  firingId: FiringId,
  actionIndex: ActionIndex,
} as const;

/**
 * The one thing an automation's machine may write on a seat of another
 * machine. `actor` is the automation's own actor: the automation seat id,
 * its node and its id, never a seat's.
 */
export const SeatControlResult = Schema.Struct({
  operation: Schema.Literal("seat.control"),
  ...controlKeyFields,
  op: SeatControlOp,
  actor: ActorRef,
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (body) =>
        (body.actor.seatId === AUTOMATION_SEAT_ID &&
          body.actor.nodeId === body.automationNode &&
          body.actor.automationId === body.automationId) ||
        "a control's actor is its automation, under its own node and id",
    ),
  ),
);
export type SeatControlResult = typeof SeatControlResult.Type;

/**
 * What the seat's machine writes once it acted, or refused, on a control it
 * admitted. `actor` is the seat's own actor, so the row is written where the
 * seat was, as a receipt is. The reason is a closed token, never words.
 */
export const SeatControlSettledResult = Schema.Struct({
  operation: Schema.Literal("seat.control.settled"),
  ...controlKeyFields,
  op: SeatControlOp,
  actor: ActorRef,
  result: Schema.Literals(["applied", "refused"]),
  reason: Schema.optionalKey(SeatControlRefusal),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (body) =>
        (body.actor.nodeId === body.seat &&
          body.actor.seatId !== AUTOMATION_SEAT_ID &&
          body.actor.seatId !== OPERATOR_SEAT_ID &&
          body.actor.automationId === undefined &&
          (body.result === "refused") === (body.reason !== undefined)) ||
        "a settled row is the seat's own, and a refusal names its closed reason",
    ),
  ),
);
export type SeatControlSettledResult = typeof SeatControlSettledResult.Type;

export type SeatControlRowBody = SeatControlResult | SeatControlSettledResult;

export const isSeatControlBody = (body: { readonly operation: string }): body is SeatControlRowBody =>
  body.operation === "seat.control" || body.operation === "seat.control.settled";

/** The part of a canvas's placement the pair's entitlement reads. */
export type SeatControlPlacement = {
  readonly seatOf: (nodeId: string) => { readonly machine: InstallationId } | undefined;
  readonly automationOf?: (nodeId: string, automationId: string) => InstallationId | undefined;
};

/** A control is for the seat's machine; the machine that rules the canvas gets it as it gets every row. */
export const seatControlEntitled = (
  machine: InstallationId,
  body: SeatControlResult,
  placement: SeatControlPlacement,
): boolean => placement.seatOf(body.seat)?.machine === machine;

/** A settled row goes to the automation's machine, where its firing waits. */
export const seatControlSettledEntitled = (
  machine: InstallationId,
  body: SeatControlSettledResult,
  placement: SeatControlPlacement,
): boolean => placement.automationOf?.(body.automationNode, body.automationId) === machine;

/** The id a control's item carries: derived, so one firing writes it once. */
export type SeatControlKey = {
  readonly canvasName: string;
  readonly firingId: string;
  readonly actionIndex: number;
};

// The seat-control action's `op` is exactly these two (automation.ts keeps its
// own literal so neither module imports the other).
const sameOp = (op: Extract<Action, { readonly kind: "seat-control" }>["op"]): SeatControlOp => op;
void sameOp;

export const seatControlKeyOf = (body: {
  readonly firingId: string;
  readonly actionIndex: number;
}): Omit<SeatControlKey, "canvasName"> => ({ firingId: body.firingId, actionIndex: body.actionIndex });

/** A control's item id derives from its firing and action: a retried firing names the same control. */
export const seatControlItemId = (body: {
  readonly firingId: string;
  readonly actionIndex: number;
}): string => `seat-control:${body.firingId}:${body.actionIndex}`;

/** A settlement's item id derives the same way: one (firing, action) settles once. */
export const seatControlSettledItemId = (body: {
  readonly firingId: string;
  readonly actionIndex: number;
}): string => `seat-settled:${body.firingId}:${body.actionIndex}`;

/**
 * The one judge of a control, wherever it runs (security review, S4): the
 * admitted-row path and the same-machine path both call it, and only the
 * transport differs. Everything is judged on the judging machine's own fold —
 * the automation as this machine holds it, the seat where this copy puts it,
 * `automationTargets` from the stored author, this machine's pause, its
 * `seat_controls` count for the seat, and the control's age on both clocks.
 *
 * Order is part of the contract: an ancient control dies `stale` before it
 * can linger pending; an unfolded automation holds `pending` until it folds,
 * is archived or moved (`not_permitted`), or ages out; a seat gone, no seat,
 * or out of reach is `not_permitted`/`not_found`; a paused canvas refuses
 * `paused` at once — nothing held outlives the operator's pause; the seat's
 * settle rate is bounded `rate` last, so a doomed control spends no budget.
 */
export type SeatControlJudgment =
  | { readonly kind: "act" }
  | { readonly kind: "refused"; readonly reason: SeatControlRefusal }
  | { readonly kind: "pending" };

export const judgeSeatControl = (input: {
  readonly canvas: ReachCanvas;
  readonly control: Pick<SeatControlResult, "seat" | "automationNode" | "automationId">;
  /** The automation as this machine folds it; absent when not folded yet. */
  readonly automation:
    | { readonly nodeId: NodeId; readonly author: AutomationAuthor; readonly archived: boolean }
    | undefined;
  /** Is the canvas playing on this machine. */
  readonly playing: boolean;
  /** Settles this machine already recorded for the seat inside the rate window. */
  readonly recentForSeat: number;
  /** The fact's own originAt, epoch ms; NaN is treated as ancient. */
  readonly originAtEpochMs: number;
  /** This machine's first sight of the control, epoch ms. */
  readonly firstSeenEpochMs: number;
  readonly nowEpochMs: number;
}): SeatControlJudgment => {
  const { canvas, control, automation } = input;
  const oldest = Math.min(
    Number.isNaN(input.originAtEpochMs) ? 0 : input.originAtEpochMs,
    Number.isNaN(input.firstSeenEpochMs) ? 0 : input.firstSeenEpochMs,
  );
  if (input.nowEpochMs - oldest > SEAT_CONTROL_PENDING_MAX_MS) return { kind: "refused", reason: "stale" };
  if (automation === undefined) return { kind: "pending" };
  if (automation.archived || automation.nodeId !== (control.automationNode as string)) {
    return { kind: "refused", reason: "not_permitted" };
  }
  const seat = canvas.nodes.get(control.seat as NodeId);
  if (seat === undefined) return { kind: "refused", reason: "not_found" };
  if (seat.kind !== "agent") return { kind: "refused", reason: "not_permitted" };
  if (!automationTargets(canvas, automation.nodeId, automation.author).some((node) => node.id === control.seat)) {
    return { kind: "refused", reason: "not_permitted" };
  }
  if (!input.playing) return { kind: "refused", reason: "paused" };
  if (input.recentForSeat >= SEAT_CONTROL_RATE_LIMIT) return { kind: "refused", reason: "rate" };
  return { kind: "act" };
};
