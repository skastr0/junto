/**
 * The Observability panel's group (src/contract/window/observability.ts) and
 * main's own rows. The ring lives in the core, where every service row is
 * written (src/contract/core/observability.ts); main's own logger lines are
 * sent there on `ObservabilityAppend`, so the panel shows one log, not main's
 * half of it. A query and a clear go to the core as they are; the live stream
 * holds the core's watch slot for as long as the panel follows it, so a new
 * row reaches a window only while a panel watches.
 */
import { app } from "electron";
import { Context, Effect, Queue, Stream } from "effect";
import { OBSERVABILITY_CLEARED, OBSERVABILITY_LOG } from "../../contract/core/channels";
import { ObservabilityCore } from "../../contract/core/observability";
import {
  ObservabilityForwarded,
  ObservabilityWindowRpcs,
  type ObservabilityLiveEvent,
} from "../../contract/window/observability";
import { subscribe as onCorePush } from "../core-process/main-side/core-pushes";
import { AppRuntime } from "../runtime";
import { forwardTo, fromCore } from "../window/ipc";
import { mainLog, mainRows } from "./main-log";

/**
 * Main's own lines belong in the core's ring: each is sent as it is
 * written, in order, and a row the core does not take is main's log file's
 * alone. Not one row after the quit begins: the core stops before main does,
 * so a late row goes to main's log file only, never into a call nobody
 * answers.
 */
export const registerObservabilityAppend = (core: Context.Context<ObservabilityCore>): void => {
  const observability = Context.get(core, ObservabilityCore);
  AppRuntime.runFork(
    Queue.take(mainRows).pipe(
      Effect.flatMap((entry) => Effect.forkChild(Effect.ignore(observability.ObservabilityAppend({ entry })))),
      Effect.forever,
    ),
  );
  app.once("before-quit", () => mainLog.stopRows());
};

/**
 * The panel's watch. It listens before it opens the slot, so no row the core
 * pushes once the slot is open is missed; rows that arrive before the counts
 * are held and sent after them. The slot closes when the stream ends, whoever
 * ends it.
 */
const live = (observability: ObservabilityCore["Service"]): Stream.Stream<ObservabilityLiveEvent> =>
  Stream.callback<ObservabilityLiveEvent>((queue) =>
    Effect.gen(function* () {
      const held: Array<ObservabilityLiveEvent> = [];
      let opened = false;
      const tell = (event: ObservabilityLiveEvent): void => {
        if (opened) Queue.offerUnsafe(queue, event);
        else held.push(event);
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => [
          onCorePush(OBSERVABILITY_LOG, (entry) => tell({ _tag: "Row", entry })),
          onCorePush(OBSERVABILITY_CLEARED, (cleared) => tell({ _tag: "Cleared", cleared })),
        ]),
        (offs) => Effect.sync(() => offs.forEach((off) => off())),
      );
      const snapshot = yield* Effect.acquireRelease(fromCore(observability.ObservabilityWatch()), () =>
        Effect.ignore(observability.ObservabilityUnwatch()),
      );
      Queue.offerUnsafe(queue, { _tag: "Opened", snapshot });
      opened = true;
      for (const event of held.splice(0)) Queue.offerUnsafe(queue, event);
    }),
  );

export const ObservabilityWindowHandlers = ObservabilityWindowRpcs.toLayer(
  Effect.gen(function* () {
    const observability = yield* ObservabilityCore;
    return {
      ...forwardTo(ObservabilityForwarded, observability),
      ObservabilityLive: () => live(observability),
    };
  }),
);
