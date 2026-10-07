/**
 * Production wiring for the seat wait/observe service.
 *
 * Kept apart from `seat-observation.ts` on purpose: the logic there takes its
 * planes as injected dependencies and can be unit-tested without a terminal
 * plane, while this module is the one place that binds the process singletons
 * (observer grid, seat state runtime, terminal host, work mutation seam).
 */

import { Effect } from "effect";
import type { WorkErrorBody } from "@shared/work-control";
import { WorkService } from "./service";
import { seatStateRuntime } from "../term/agent-state";
import { terminalObserverPlane } from "../term/observer";
import { termPlane } from "../term/plane";
import { onWorkMutation } from "./mutation-seam";
import { makeSeatObservation, type SeatObservation } from "./seat-observation";

/**
 * The live seat observation service reads topology and selected Work rows
 * through WorkService, already in the work-control dispatcher's scope.
 */
export const liveSeatObservation = (): Effect.Effect<
  SeatObservation,
  never,
  WorkService
> =>
  Effect.gen(function* () {
    const work = yield* WorkService;
    return makeSeatObservation({
      readTopology: (canvasName) =>
        work.readTopology(canvasName).pipe(Effect.map((read) => read.canvas),
          Effect.mapError(
            (error): WorkErrorBody => ({
              type: "StaleNodeRef",
              message: error.message,
              details: {
                retryable: false,
                next_step:
                  "the canvas is not open; ask the operator to open it in Junto",
              },
            }),
          ),
        ),
      readTask: (canvasName, nodeId, taskId, kind) => work.readTask(canvasName, nodeId, taskId, kind).pipe(
        Effect.mapError((error): WorkErrorBody => ({ type: "InternalError", message: error.message, details: { retryable: true } })),
      ),
      subscribeCanvasChanges: (listener) =>
        work.subscribeTopologyChanges(listener),
      seatStates: {
        // Live bindings first, then the last published event of each retired
        // generation: a seat that exited before the wait started is absent from
        // the live projection by construction, and `unbind` is the only place
        // its terminal `gone` event exists. The observation layer stamps each
        // event with its generation and ignores a tombstone whose generation is
        // no longer the binding's session, so a replacement is never shadowed.
        current: () => [
          ...seatStateRuntime.machine.currentEvents(),
          ...seatStateRuntime.machine.retiredEvents(),
        ],
        subscribe: (listener) => seatStateRuntime.subscribe(listener),
      },
      subscribeWorkChanges: (listener) =>
        onWorkMutation((canvasName, nodeId) => listener(canvasName, nodeId)),
      sessionOf: (bindingId) => {
        const summary = termPlane.host.get(bindingId);
        return summary === undefined
          ? undefined
          : { epoch: summary.epoch, status: summary.status };
      },
      readGrid: (bindingId, lines) => terminalObserverPlane.readWindow(bindingId, lines),
      subscribeGrid: (listener) => terminalObserverPlane.subscribeAll(listener),
      now: () => Date.now(),
    });
  });
