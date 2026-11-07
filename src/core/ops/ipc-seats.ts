/**
 * The core's handlers of the seats group (src/contract/core/seats.ts): which
 * running seats in a region are on an older resolution, the region's secrets,
 * the pause plane's state and set, the operator's prompt to a managed seat,
 * the operator's offboard ask and where each offboard stands, and the seat
 * onboarding nudge. Every answer is plain data; main decoded every payload
 * at its own edge.
 *
 * The seat sessions are the ones this core started (`CoreSeatSessions`, which
 * its entry provides); the nudge is interjected through this core's mail
 * gate, the way the onboarding supervisor's own nudges are.
 */
import { Context, Effect } from "effect";
import { buildOnboardNudge } from "@shared/managed-terminal-injection";
import { onboardNudgeRefusal, type SeatOnboardNudgeResult } from "@shared/seat-onboarding-status";
import { composeOffboardAsk, type SeatOffboardAskResult } from "@shared/seat-sessions";
import { SeatsRpcs } from "../../contract/core/seats";
import { MachineCoreMail } from "../core-runtime";
import type { ModelService } from "../model/service";
import { PausePlane } from "../pause-plane";
import { regionEnvReport, regionEnvStaleSeats } from "../region-env/report-ipc";
import { removeRegionSecret, saveRegionSecret } from "../region-env/secret-ipc";
import type { SeatSessions } from "../seat-sessions/start-seat-sessions";
import { closingFence } from "../term/closing-fence";
import { injectionSupervisor } from "../term/injection-supervisor";
import { makeOnboardNudgeInterject } from "../term/onboard-nudge-interject";
import { termPlane } from "../term/plane";
import { appendSeatPrompt, type SeatPromptRun } from "../work/seat-prompt";
import type { WorkService } from "../work/service";

/** The seat sessions this core started: the seat a canvas node names, and the offboard closer. */
export class CoreSeatSessions extends Context.Service<CoreSeatSessions, Pick<SeatSessions, "seatOn" | "closer">>()(
  "@junto/core/CoreSeatSessions",
) {}

const NOT_FOUND = "Junto could not find that seat.";
const ELSEWHERE = "This seat runs on another installation.";

export const SeatsHandlers = SeatsRpcs.toLayer(
  Effect.gen(function* () {
    const sessions = yield* CoreSeatSessions;
    const pause = yield* PausePlane;
    const { seats } = yield* MachineCoreMail;
    // The operator's prompt and the offboard ask write mail on this core's own services.
    const run: SeatPromptRun = Effect.runPromiseWith(yield* Effect.context<ModelService | WorkService>());

    // The operator's nudge is interjected: typed whatever the seat is doing,
    // never into a dialog, held back for a draft, and never once the core
    // suspended product automation.
    let suspended = false;
    const stopSuspendWatch = seats.onSuspend(() => {
      suspended = true;
    });
    yield* Effect.addFinalizer(() => Effect.sync(stopSuspendWatch));
    const interject = makeOnboardNudgeInterject({
      suspended: () => suspended,
      sealed: (bindingId) => closingFence.sealed(bindingId),
      mailReady: seats.mailReadyNow,
      writeMail: (bindingId, text) => seats.drive.writeMail(bindingId, text),
    });

    return {
      // The region screen's reads: the environment a region resolves to, from the service that holds it here.
      SeatsRegionEnvReport: ({ canvasName, regionId }) => Effect.promise(() => regionEnvReport(canvasName, regionId)),
      SeatsRegionEnvStaleSeats: ({ canvasName, regionId }) => Effect.promise(() => regionEnvStaleSeats(canvasName, regionId)),
      SeatsRegionEnvSaveSecret: ({ value, secretId }) =>
        Effect.sync(() => saveRegionSecret({ value, ...(secretId === undefined ? {} : { secretId }) })),
      SeatsRegionEnvRemoveSecret: ({ secretId }) => Effect.sync(() => removeRegionSecret(secretId)),
      SeatsFactoryPauseState: ({ canvas }) => pause.start.pipe(Effect.map(() => pause.stateFor(canvas))),
      SeatsFactoryPauseSet: ({ canvas, paused }) =>
        Effect.gen(function* () {
          yield* pause.start;
          const written = yield* Effect.result(pause.setPlaying(canvas, !paused));
          if (written._tag === "Failure") return { ok: false as const, error: written.failure.message };
          return { ok: true as const, state: pause.stateFor(canvas) };
        }),
      // The operator's prompt is mail from the operator (work), written and
      // delivered by the seat prompt path the offboard ask also uses.
      SeatsManagedPrompt: ({ input }) => Effect.promise(() => appendSeatPrompt(run, input)),
      SeatsOffboardProgress: () => Effect.sync(() => sessions.closer.current()),
      // The operator asks from the seat; the agent writes its notes with `junto
      // offboard`, and the closer ends the session once it is idle, in its mode.
      SeatsOffboardAsk: ({ canvasName, seatId, mode }) =>
        Effect.promise(async (): Promise<SeatOffboardAskResult> => {
          const seat = await sessions.seatOn({ canvasName, seatId });
          if (seat === undefined) return { ok: false, message: NOT_FOUND };
          if (!seat.local) return { ok: false, message: ELSEWHERE };
          const sent = await appendSeatPrompt(run, { bindingId: seat.bindingId, text: composeOffboardAsk(mode), canvasName, nodeId: seatId });
          if (!sent.ok) return { ok: false, message: sent.error ?? "Junto could not send the offboard prompt." };
          sessions.closer.asked({ seatId, canvasName }, mode);
          return { ok: true };
        }),
      SeatsOnboardNudge: ({ canvasName, seatId }) =>
        Effect.promise(async (): Promise<SeatOnboardNudgeResult> => {
          const seat = await sessions.seatOn({ canvasName, seatId });
          if (seat === undefined) return { ok: false, message: NOT_FOUND };
          if (!seat.local) return { ok: false, message: ELSEWHERE };
          if (termPlane.host.get(seat.bindingId)?.status !== "running") return { ok: false, message: "This seat is not running." };
          const outcome = await interject(seat.bindingId, buildOnboardNudge());
          if (outcome !== "written") return { ok: false, message: onboardNudgeRefusal(outcome) };
          // The cadence does not repeat what the operator just sent.
          injectionSupervisor.noteNudgeDelivered(seat.bindingId);
          return { ok: true };
        }),
    };
  }),
);
