/**
 * The window's view-state reads and writes (junto/view-state/ipc.ts). The
 * write decodes the shared strict union here, in the core, and publishes the
 * committed row on `viewStateChanged`; main subscribes once and broadcasts,
 * so a write is never announced before its transaction committed.
 */
import { Effect } from "effect";
import { IPC_CHANNELS, type ViewStateApplyResult } from "@shared/ipc";
import { decodeViewStateWrite, type ViewStateSnapshot } from "@shared/view-state";
import { ViewStateRepository, type ViewStatePersistenceError } from "../../junto/view-state/repository";
import { publish } from "../push";
import { coreOps, type CoreOp } from "../ops";

declare module "../ops" {
  interface CoreOps {
    "ipc.viewState.snapshot": CoreOp<Record<string, never>, ViewStateSnapshot>;
    "ipc.viewState.apply": CoreOp<{ readonly input: unknown }, ViewStateApplyResult>;
  }
}

coreOps({
  "ipc.viewState.snapshot": () =>
    Effect.flatMap(ViewStateRepository, (store) => store.snapshot()),
  "ipc.viewState.apply": ({ input }) =>
    Effect.gen(function* () {
      const decoded = decodeViewStateWrite(input);
      if (decoded._tag === "Failure") {
        return { ok: false, error: "this build does not read that view-state write" } satisfies ViewStateApplyResult;
      }
      const write = decoded.success;
      const store = yield* ViewStateRepository;
      return yield* store.write(write).pipe(
        Effect.flatMap((written): Effect.Effect<ViewStateApplyResult> =>
          written
            ? Effect.sync(() => {
                // After the row's transaction committed, never before.
                publish(IPC_CHANNELS.viewStateChanged, write);
                return { ok: true } satisfies ViewStateApplyResult;
              })
            : Effect.succeed({
                ok: false,
                error: "the node this row belongs to is gone; the row was not kept",
              } satisfies ViewStateApplyResult),
        ),
        Effect.catch((error: ViewStatePersistenceError) =>
          Effect.succeed({ ok: false, error: error.message } satisfies ViewStateApplyResult),
        ),
      );
    }),
});
