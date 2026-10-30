/**
 * The runtime half of `seat.control` / `seat.control.settled` (0.11, 05 S4).
 *
 * On the seat's machine an admitted control is judged on this machine's own
 * fold — `judgeSeatControl`, the one judge the local path runs too: the
 * automation folded and on its named node, the seat inside its reach, the
 * canvas playing here, the seat's settle rate bounded, the control young on
 * both clocks. It acts at most once per (firing, action) — the durable
 * `seat_controls` row — and settles with a `seat.control.settled` row, which
 * waits for a path to the automation's machine as mail waits. A control whose
 * automation is not folded here yet stays pending: the sweep and each fold
 * look at it again, and its age bound settles it `stale`.
 *
 * On the automation's machine a settled row resolves the firing's held action
 * (`queued` to `applied` or `refused`). Every other machine keeps both rows
 * and does nothing.
 */
import { Cause, Context, Effect, Layer } from "effect";
import type { SeatControlResult, SeatControlSettledResult, SeatControlRefusal } from "@shared/seat-control-row";
import {
  heldControlVerdict,
  judgeSeatControl,
  SEAT_CONTROL_RATE_WINDOW_MS,
  SEAT_CONTROL_REFUSAL_TO_RULING,
} from "@shared/seat-control-row";
import type { ActorSeatId } from "@shared/actor-seat";
import type { InstallationId } from "@shared/installation-id";
import { asCanvasName, type NodeId } from "@shared/model";
import { asNodeId } from "@shared/physics/schema";
import type { FiringId } from "@shared/automation";
import type { ReachCanvas } from "@shared/region-reach";
import type { Automation } from "@shared/automation";
import { AutomationRepository } from "../../automation/repository";
import { MachineRepository } from "../../machines/repository";
import { ModelRecords } from "../../model/records";
import { ModelService } from "../../model/service";
import { PausePlane } from "../../pause-plane";
import { ActorSeatOccupy } from "../../term/actor-seat-occupy";
import { startSeat, stopSeat, SeatNotFound, NotASeat } from "../../term/seat-control";
import { canvasPlacement } from "../canvas-placement";

/** A control row this machine took: its body, its writer, the id its item carried, and its two clocks. */
export type ArrivedSeatControl = {
  readonly controlId: string;
  readonly writer: InstallationId;
  readonly body: SeatControlResult;
  /** The fact's own originAt, epoch ms; NaN when unparseable, which judges as ancient. */
  readonly originAtEpochMs: number;
  /** This machine's first sight of it, epoch ms. */
  readonly firstSeenEpochMs: number;
};

/** A settled row this machine took. */
export type ArrivedSeatSettled = {
  readonly writer: InstallationId;
  readonly body: SeatControlSettledResult;
};

/** The durable outcome of one control, as `seat_controls` recorded it. */
export type SeatControlOutcome = {
  readonly outcome: "applied" | "refused";
  readonly reason?: SeatControlRefusal;
};

/**
 * The work-log access the pair needs, implemented inside the work repository
 * where `commitLocalFact` lives: `settle` writes the `seat_controls` record
 * and the settled fact in one transaction; `record` writes the record alone,
 * for the same-machine path that crosses no wire.
 */
export interface SeatControlRows {
  /** The outcome this machine recorded for one (firing, action), when it settled before. */
  readonly outcome: (
    canvasName: string,
    firingId: FiringId,
    actionIndex: number,
  ) => Effect.Effect<SeatControlOutcome | undefined, unknown>;
  /** Settles this machine already recorded for a seat since `sinceEpochMs`: the rate count. */
  readonly recentForSeat: (
    canvasName: string,
    nodeId: string,
    sinceEpochMs: number,
  ) => Effect.Effect<number, unknown>;
  /** Record the verdict only — the same-machine path, or a seat no row can answer for. */
  readonly record: (input: SeatControlRecord) => Effect.Effect<void, unknown>;
  /** Record the verdict and write the `seat.control.settled` row, once. */
  readonly settle: (input: SeatControlSettle) => Effect.Effect<void, unknown>;
  /** Controls this machine took whose (firing, action) it never settled, newest first. */
  readonly pending: (canvasName: string) => Effect.Effect<ReadonlyArray<ArrivedSeatControl>, unknown>;
  /**
   * A control this machine wrote, by firing and action — the held action's own
   * copy of its seat and its clock, so a firing it left queued ends itself
   * when no seat can ever answer.
   */
  readonly control: (
    canvasName: string,
    firingId: FiringId,
    actionIndex: number,
  ) => Effect.Effect<{ readonly seat: string; readonly originAtEpochMs: number } | undefined, unknown>;
}

/** What one record writes. A settle adds the seat's own identity, which authors its row. */
export type SeatControlRecord = {
  readonly canvasName: string;
  readonly controlId: string;
  readonly seat: string;
  readonly op: SeatControlResult["op"];
  readonly automationNode: SeatControlResult["automationNode"];
  readonly automationId: SeatControlResult["automationId"];
  readonly firingId: FiringId;
  readonly actionIndex: number;
  readonly result: "applied" | "refused";
  readonly reason?: SeatControlRefusal;
};

/** What one settle writes: the record, and the seat's identity that authors the settled row. */
export type SeatControlSettle = SeatControlRecord & { readonly seatId: ActorSeatId };

export class HeldSeatControls extends Context.Service<
  HeldSeatControls,
  {
    /** Judge and act on control rows just taken, and on any still pending. */
    readonly controlsArrived: (
      canvasName: string,
      controls: ReadonlyArray<ArrivedSeatControl>,
    ) => Effect.Effect<void, unknown>;
    /** Resolve held actions on this machine's firings from settled rows just taken. */
    readonly settledArrived: (
      canvasName: string,
      settled: ReadonlyArray<ArrivedSeatSettled>,
    ) => Effect.Effect<void, unknown>;
    /** Judge every control this machine took and never settled (a crash, a lagging fold). */
    readonly sweepPending: (canvasName: string) => Effect.Effect<void, unknown>;
  }
>()("@junto/HeldSeatControls") {}

/** An act's failure is one closed word on the row: its classification lives under Failures and logs. */
const actRefusal = (error: unknown): SeatControlRefusal =>
  error instanceof SeatNotFound ? "not_found" : error instanceof NotASeat ? "not_permitted" : "failed";

/** The fields one judge call needs beyond the row: gathered on this machine, whichever path calls it. */
export type SeatControlJudgeInput = {
  readonly canvas: ReachCanvas;
  readonly automation: { readonly nodeId: Automation["nodeId"]; readonly author: Automation["author"]; readonly archived: boolean } | undefined;
  readonly playing: boolean;
  readonly recentForSeat: number;
  readonly recordedOutcome: SeatControlOutcome | undefined;
  readonly originAtEpochMs: number;
  readonly firstSeenEpochMs: number;
  readonly nowEpochMs: number;
};

/**
 * Judge one control and act on it once (`runSeatControl`), then record the
 * outcome (`commit`). `recordedOutcome` makes a second pass a no-op: the
 * at-most-once record speaks first. Returns what it settled, or `pending`.
 */
export const runSeatControl = (input: {
  readonly judge: SeatControlJudgeInput;
  readonly control: Pick<SeatControlResult, "seat" | "automationNode" | "automationId">;
  readonly act: Effect.Effect<unknown, unknown>;
  readonly commit: (settled: { readonly result: "applied" | "refused"; readonly reason?: SeatControlRefusal }) => Effect.Effect<void, unknown>;
}): Effect.Effect<SeatControlOutcome | "pending", unknown> =>
  Effect.gen(function* () {
    if (input.judge.recordedOutcome !== undefined) return input.judge.recordedOutcome;
    const judgment = judgeSeatControl({
      canvas: input.judge.canvas,
      control: input.control,
      automation: input.judge.automation,
      playing: input.judge.playing,
      recentForSeat: input.judge.recentForSeat,
      originAtEpochMs: input.judge.originAtEpochMs,
      firstSeenEpochMs: input.judge.firstSeenEpochMs,
      nowEpochMs: input.judge.nowEpochMs,
    });
    if (judgment.kind === "pending") return "pending";
    const settled =
      judgment.kind === "refused"
        ? ({ result: "refused", reason: judgment.reason } as const)
        : yield* Effect.match(input.act, {
            onFailure: (error) => ({ result: "refused", reason: actRefusal(error) }) as const,
            onSuccess: () => ({ result: "applied" }) as const,
          });
    yield* input.commit(settled);
    return {
      outcome: settled.result,
      ...(settled.result === "refused" ? { reason: settled.reason } : {}),
    };
  });

/** The service value: built wherever the layer is provided (core-runtime holds it for the boot sweep). */
export const makeHeldSeatControls = (rows: SeatControlRows) =>
  Effect.gen(function* () {
      const model = yield* ModelService;
      const records = yield* ModelRecords;
      const machines = yield* MachineRepository;
      const automations = yield* AutomationRepository;
      const pause = yield* PausePlane;
      const occupy = yield* ActorSeatOccupy;

      const self = yield* machines.installationId;
      const placement = (canvasName: string) =>
        canvasPlacement(canvasName).pipe(
          Effect.provideService(MachineRepository, machines),
          Effect.provideService(ModelRecords, records),
          Effect.provideService(AutomationRepository, automations),
        );

      /** Judge and act on one admitted control, then settle it; pending stays for the next fold or sweep. */
      const actOn = (canvasName: string, arrived: ArrivedSeatControl): Effect.Effect<void, unknown> =>
        Effect.gen(function* () {
          const { body } = arrived;
          const home = (yield* placement(canvasName))?.seatOf(body.seat);
          if (home === undefined) {
            // The seat is gone from this copy: no machine answers for it —
            // a settled row could not be authored anywhere. The refusal is
            // recorded so it acts never and is judged no more.
            yield* rows.record({
              canvasName,
              controlId: arrived.controlId,
              seat: body.seat,
              op: body.op,
              automationNode: body.automationNode,
              automationId: body.automationId,
              firingId: body.firingId,
              actionIndex: body.actionIndex,
              result: "refused",
              reason: "not_found",
            });
            return;
          }
          // On another machine now: it is that machine's to answer, not this one's.
          if (home.machine !== self) return;
          const recordedOutcome = yield* rows.outcome(canvasName, body.firingId, body.actionIndex);
          const nowEpochMs = Date.now();
          const state = yield* automations.loadState(canvasName);
          const entry = state.get(body.automationId);
          const canvas = yield* model.canvas(canvasName);
          const where = { canvas: asCanvasName(canvasName), seatId: asNodeId(body.seat), operationId: arrived.controlId };
          const act: Effect.Effect<unknown, unknown> =
            body.op === "start"
              ? startSeat(where).pipe(Effect.provideService(ModelService, model), Effect.provideService(ActorSeatOccupy, occupy))
              : stopSeat(where).pipe(Effect.provideService(ModelService, model), Effect.provideService(ActorSeatOccupy, occupy));
          yield* runSeatControl({
            judge: {
              canvas,
              automation:
                entry === undefined
                  ? undefined
                  : { nodeId: entry.automation.nodeId, author: entry.automation.author, archived: entry.archived },
              playing: pause.stateFor(canvasName).playing,
              recentForSeat: yield* rows.recentForSeat(canvasName, body.seat, nowEpochMs - SEAT_CONTROL_RATE_WINDOW_MS),
              recordedOutcome,
              originAtEpochMs: arrived.originAtEpochMs,
              firstSeenEpochMs: arrived.firstSeenEpochMs,
              nowEpochMs,
            },
            control: body,
            act,
            commit: (settled) =>
              rows.settle({
                canvasName,
                controlId: arrived.controlId,
                seat: body.seat,
                seatId: home.seatId,
                op: body.op,
                automationNode: body.automationNode,
                automationId: body.automationId,
                firingId: body.firingId,
                actionIndex: body.actionIndex,
                ...settled,
              }),
          });
        }).pipe(
          // One bad control never keeps the others waiting: it is logged and stays unsettled for the sweep.
          Effect.catchCause((cause) =>
            Effect.logWarning("a seat.control could not be settled").pipe(
              Effect.annotateLogs({
                area: "exchange",
                canvas: canvasName,
                control: arrived.controlId,
                error: Cause.pretty(cause),
              }),
            ),
          ),
        );

      /** A held action of one firing resolves: the firing's own machine rewrites it applied or refused. */
      const resolveFiring = (canvasName: string, arrived: ArrivedSeatSettled): Effect.Effect<void, unknown> =>
        Effect.gen(function* () {
          const { body } = arrived;
          const firing = yield* automations.firing(canvasName, body.firingId);
          if (firing === undefined || firing.automationId !== body.automationId) return;
          if (firing.outcome.kind !== "fired") return;
          let touched = false;
          const actions = firing.outcome.actions.map((action) => {
            if (action.index !== body.actionIndex || action.ruling !== "queued") return action;
            touched = true;
            // The wait stays visible beside how it ended (S3).
            const held = {
              ...(action.waitingOn === undefined ? {} : { heldSince: action.waitingOn.since }),
              heldUntil: Date.now(),
            } as const;
            return body.result === "applied"
              ? ({ index: action.index, ruling: "applied", ...held } as const)
              : ({
                  index: action.index,
                  ruling: "refused",
                  reason: body.reason === undefined ? "not_available" : SEAT_CONTROL_REFUSAL_TO_RULING[body.reason],
                  ...held,
                } as const);
          });
          if (!touched) return;
          yield* automations.settleFiring(canvasName, firing, { kind: "fired", actions });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("a seat.control.settled resolved no firing").pipe(
              Effect.annotateLogs({
                area: "exchange",
                canvas: canvasName,
                firing: String(arrived.body.firingId),
                error: Cause.pretty(cause),
              }),
            ),
          ),
        );

      /**
       * A held action on this machine's own firings (remote-security, S4
       * close-out): a seat this machine's own copy no longer has can never
       * answer — no machine authors a settled row for a seat that is gone —
       * so the firing ends the action `not_found` itself; a control a day
       * old on its own clock ends `stale`. The settled row that does land
       * later resolves only what is still queued.
       */
      const settleHeldActions = (canvasName: string): Effect.Effect<void, unknown> =>
        Effect.gen(function* () {
          const queued = yield* automations.queuedFirings(canvasName);
          if (queued.length === 0) return;
          const canvas = yield* model.canvas(canvasName);
          const nowEpochMs = Date.now();
          for (const firing of queued) {
            const outcome = firing.outcome;
            if (outcome.kind !== "fired") continue;
            const actions = yield* Effect.forEach(
              outcome.actions,
              (action) =>
                Effect.gen(function* () {
                  if (action.ruling !== "queued") return action;
                  // The row itself says what was asked: a definition edited
                  // after the firing cannot misname the action it waited on.
                  const held = yield* rows.control(canvasName, firing.firingId, action.index);
                  if (held === undefined) return action;
                  const refusal = heldControlVerdict({
                    seatOnCanvas: canvas.nodes.get(held.seat as NodeId) !== undefined,
                    controlAtEpochMs: held.originAtEpochMs,
                    nowEpochMs,
                  });
                  return refusal === undefined
                    ? action
                    : ({
                        index: action.index,
                        ruling: "refused",
                        reason: SEAT_CONTROL_REFUSAL_TO_RULING[refusal],
                        // The wait stays visible beside how it ended (S3).
                        ...(action.waitingOn === undefined ? {} : { heldSince: action.waitingOn.since }),
                        heldUntil: nowEpochMs,
                      } as const);
                }),
              { concurrency: 1 },
            );
            const changed = actions.some((action, index) => action !== outcome.actions[index]);
            if (changed) yield* automations.settleFiring(canvasName, firing, { kind: "fired", actions });
          }
        });

      return HeldSeatControls.of({
        controlsArrived: (canvasName, controls) =>
          Effect.forEach(controls, (control) => actOn(canvasName, control), { discard: true }),
        settledArrived: (canvasName, settled) =>
          Effect.forEach(settled, (row) => resolveFiring(canvasName, row), { discard: true }),
        sweepPending: (canvasName) =>
          Effect.flatMap(
            Effect.flatMap(rows.pending(canvasName), (pending) =>
              pending.length === 0
                ? Effect.void
                : Effect.forEach(pending, (control) => actOn(canvasName, control), { discard: true }),
            ),
            () => settleHeldActions(canvasName),
          ),
      });
  });

export const HeldSeatControlsLive = (rows: SeatControlRows) =>
  Layer.effect(HeldSeatControls, makeHeldSeatControls(rows));
