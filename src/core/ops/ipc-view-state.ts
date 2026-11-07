/**
 * The core's handlers of the view-state group (src/contract/core/view-state.ts):
 * the snapshot a window opens with, and one row written at a time. A write
 * publishes the committed row on `viewStateChanged`, which main broadcasts,
 * so a write is never announced before its transaction committed.
 */
import { Effect } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import type { ViewStateApplyResult } from "@shared/view-state";
import { ViewStateRpcs, ViewStateUnavailable } from "../../contract/core/view-state";
import { CorePushes } from "../push";
import { ViewStateRepository } from "../view-state/repository";

export const ViewStateHandlers = ViewStateRpcs.toLayer(
  Effect.gen(function* () {
    const store = yield* ViewStateRepository;
    const pushes = yield* CorePushes;
    return {
      ViewStateSnapshot: () =>
        store.snapshot().pipe(Effect.mapError((error) => new ViewStateUnavailable({ message: error.message }))),
      ViewStateApply: ({ write }) =>
        store.write(write).pipe(
          Effect.flatMap((written): Effect.Effect<ViewStateApplyResult> =>
            written
              ? // After the row's transaction committed, never before.
                pushes.publish(IPC_CHANNELS.viewStateChanged, write).pipe(Effect.as({ ok: true }))
              : Effect.succeed({ ok: false, error: "the node this row belongs to is gone; the row was not kept" }),
          ),
          Effect.catchTag("ViewStatePersistenceError", (error) => Effect.succeed<ViewStateApplyResult>({ ok: false, error: error.message })),
        ),
    };
  }),
);
