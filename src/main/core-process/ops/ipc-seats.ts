/**
 * The window's seat calls (junto/ipc.ts): which running seats in a region are
 * on an older resolution, the pause plane's state and set, the operator's
 * prompt to a managed seat, and the seat onboarding nudge. Every answer is
 * plain data.
 *
 * What needs the terminal plane — whether the seat is running, the nudge's
 * interject into its input, the cadence that remembers it — is bound here by
 * whoever holds the plane (term/ipc.ts), as term-ipc.ts binds seat start and
 * stop. The op bodies never reach for main's state themselves.
 */
import { Effect } from "effect";
import type { FactoryPauseSetResult, RegionEnvStaleSeatsResult } from "@shared/ipc";
import type { CanvasPauseState } from "@shared/pause";
import { buildOnboardNudge } from "@shared/managed-terminal-injection";
import type { SeatOnboardNudgeResult } from "@shared/seat-onboarding-status";
import { coreRunner } from "../../core-runner";
import { PausePlane } from "../../junto/pause-plane";
import { regionEnvStaleSeats } from "../../junto/region-env/report-ipc";
import { appendSeatPrompt, type SeatPromptInput, type SeatPromptResult } from "../../junto/work/seat-prompt";
import { coreOps, type CoreOp } from "../ops";
import type { SeatSessions } from "../../junto/seat-sessions/start-seat-sessions";
import { composeOffboardAsk, OFFBOARD_MODES, type OffboardMode, type SeatOffboardAskResult, type SeatOffboardProgress } from "@shared/seat-sessions";
import { isSeatGuidanceSeatId } from "@shared/seat-guidance";

/** What the core asks of whoever holds the terminal plane, for a seat nudge. */
export type SeatIpcBindings = {
  /** The managed seat a canvas node names on this installation, if it is one. */
  readonly seatOn: (target: {
    readonly canvasName: string;
    readonly seatId: string;
  }) => Promise<{ readonly bindingId: string; readonly local: boolean } | undefined>;
  /** The seat's terminal is running. */
  readonly seatRunning: (bindingId: string) => boolean;
  /** Type the nudge into the running seat's input; a refusal says why, in the operator's words. */
  readonly interjectNudge: (
    bindingId: string,
    text: string,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
  /** The nudge was typed: the cadence does not repeat what the operator just sent. */
  readonly noteNudged: (bindingId: string) => void;
};

let bindings: SeatIpcBindings | undefined;

/** Bound once by the terminal plane's own wiring (term/ipc.ts). */
export const bindSeatIpc = (next: SeatIpcBindings): void => {
  bindings = next;
};

const boundSeatIpc = (): SeatIpcBindings => {
  if (bindings === undefined) throw new Error("the seat nudge is not bound to a terminal plane");
  return bindings;
};

/** The core's own seat sessions (core.ts): the seat a node names, and the offboard closer. */
let coreSessions: Pick<SeatSessions, "seatOn" | "closer"> | undefined;

/** Core boot only, once its seat sessions start. */
export const bindCoreSeatSessions = (sessions: Pick<SeatSessions, "seatOn" | "closer"> | undefined): void => {
  coreSessions = sessions;
};

/** The managed seat a canvas node names, from the core's own seat sessions. */
export const seatOnOfCore = async (target: { readonly canvasName: string; readonly seatId: string }) =>
  coreSessions === undefined ? undefined : coreSessions.seatOn(target);

declare module "../ops" {
  interface CoreOps {
    "ipc.seats.offboardProgress": CoreOp<Record<string, never>, ReadonlyArray<SeatOffboardProgress>>;
    "ipc.seats.offboardAsk": CoreOp<
      { readonly canvasName: unknown; readonly seatId: unknown; readonly mode: unknown },
      SeatOffboardAskResult
    >;
    "ipc.seats.regionEnvStaleSeats": CoreOp<
      { readonly canvasName: unknown; readonly regionId: unknown },
      RegionEnvStaleSeatsResult
    >;
    "ipc.seats.factoryPauseState": CoreOp<{ readonly canvas: string }, CanvasPauseState>;
    "ipc.seats.factoryPauseSet": CoreOp<
      { readonly canvas: string; readonly paused: boolean },
      FactoryPauseSetResult
    >;
    "ipc.seats.managedPrompt": CoreOp<
      { readonly input: SeatPromptInput; readonly senderName?: string },
      SeatPromptResult
    >;
    "ipc.seats.onboardNudge": CoreOp<
      { readonly canvasName: unknown; readonly seatId: unknown },
      SeatOnboardNudgeResult
    >;
  }
}

coreOps({
  "ipc.seats.offboardProgress": () => Effect.sync(() => coreSessions?.closer.current() ?? []),
  // The operator asks from the seat; the agent writes its notes with `junto
  // offboard`, and the closer ends the session once it is idle, in its mode.
  "ipc.seats.offboardAsk": ({ canvasName, seatId, mode }) =>
    Effect.promise(async (): Promise<SeatOffboardAskResult> => {
      if (typeof canvasName !== "string" || !canvasName || !isSeatGuidanceSeatId(seatId)) {
        return { ok: false, message: "Junto could not find that seat." };
      }
      if (!(OFFBOARD_MODES as ReadonlyArray<unknown>).includes(mode)) return { ok: false, message: "Offboard to rest or to continue." };
      const offboardMode = mode as OffboardMode;
      const seat = await seatOnOfCore({ canvasName, seatId });
      if (seat === undefined) return { ok: false, message: "Junto could not find that seat." };
      if (!seat.local) return { ok: false, message: "This seat runs on another installation." };
      const sent = await appendSeatPrompt(coreRunner.runPromise, {
        bindingId: seat.bindingId,
        text: composeOffboardAsk(offboardMode),
        canvasName,
        nodeId: seatId,
      });
      if (!sent.ok) return { ok: false, message: sent.error ?? "Junto could not send the offboard prompt." };
      coreSessions?.closer.asked({ seatId, canvasName }, offboardMode);
      return { ok: true };
    }),
  "ipc.seats.regionEnvStaleSeats": ({ canvasName, regionId }) =>
    Effect.promise(() => regionEnvStaleSeats(canvasName, regionId)),
  "ipc.seats.factoryPauseState": ({ canvas }) =>
    Effect.gen(function* () {
      const pause = yield* PausePlane;
      yield* pause.start;
      return pause.stateFor(canvas);
    }),
  "ipc.seats.factoryPauseSet": ({ canvas, paused }) =>
    Effect.gen(function* () {
      const pause = yield* PausePlane;
      yield* pause.start;
      const written = yield* Effect.result(pause.setPlaying(canvas, !paused));
      if (written._tag === "Failure") return { ok: false as const, error: written.failure.message };
      return { ok: true as const, state: pause.stateFor(canvas) };
    }),
  // The operator's prompt is mail from the operator (work), written and
  // delivered by the seat prompt path the offboard ask already uses.
  "ipc.seats.managedPrompt": ({ input, senderName }) =>
    Effect.promise(() =>
      senderName === undefined
        ? appendSeatPrompt(coreRunner.runPromise, input)
        : appendSeatPrompt(coreRunner.runPromise, input, senderName),
    ),
  "ipc.seats.onboardNudge": ({ canvasName, seatId }) =>
    Effect.promise(async (): Promise<SeatOnboardNudgeResult> => {
      if (typeof canvasName !== "string" || !canvasName || typeof seatId !== "string" || !seatId) {
        return { ok: false, message: "Junto could not find that seat." };
      }
      const seats = boundSeatIpc();
      const seat = await seats.seatOn({ canvasName, seatId });
      if (seat === undefined) return { ok: false, message: "Junto could not find that seat." };
      if (!seat.local) return { ok: false, message: "This seat runs on another installation." };
      if (!seats.seatRunning(seat.bindingId)) return { ok: false, message: "This seat is not running." };
      const written = await seats.interjectNudge(seat.bindingId, buildOnboardNudge());
      if (!written.ok) return { ok: false, message: written.message };
      seats.noteNudged(seat.bindingId);
      return { ok: true };
    }),
});
