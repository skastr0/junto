/**
 * Where this machine's update stands, as the window shows it: a service of
 * the window's runtime (src/window/rpc/runtime.ts), built once at boot. It
 * follows `UpdateStates` for as long as the runtime lives; the stream opens
 * with the current status, so no read races a change. Following fails soft:
 * the update UI is optional chrome.
 */
import { observable, type Observable } from "@legendapp/state";
import { Context, Effect, Layer, Stream } from "effect";
import type { RpcClientError } from "effect/rpc";
import { idleUpdateStatus, type UpdateStatus } from "@shared/update";
import { UpdateWindow } from "../../contract/window/update";

export type UpdateView = { readonly status: UpdateStatus; readonly busy: boolean };

export class UpdateState extends Context.Service<UpdateState, {
  readonly view$: Observable<UpdateView>;
  /** Ask the feed now; the answer is shown as it comes. */
  readonly check: Effect.Effect<UpdateStatus, RpcClientError.RpcClientError>;
  /** Restart into the staged release; a refusal is shown as it comes. */
  readonly restartAndInstall: Effect.Effect<UpdateStatus, RpcClientError.RpcClientError>;
}>()("@junto/window/UpdateState") {
  static readonly layer = Layer.effect(
    UpdateState,
    Effect.gen(function* () {
      const update = yield* UpdateWindow;
      const view$ = observable<UpdateView>({ status: idleUpdateStatus("0.0.0"), busy: false });
      const show = (status: UpdateStatus): void => {
        view$.set({
          status,
          busy: status.phase === "checking" || status.phase === "downloading" || status.phase === "installing",
        });
      };
      yield* update.UpdateStates().pipe(
        Stream.runForEach((status) => Effect.sync(() => show(status))),
        Effect.ignore,
        Effect.forkScoped,
      );
      const asked = (call: Effect.Effect<UpdateStatus, RpcClientError.RpcClientError>) =>
        Effect.sync(() => view$.busy.set(true)).pipe(
          Effect.andThen(call),
          Effect.tap((status) => Effect.sync(() => view$.status.set(status))),
          // An install in progress stays busy: the process is about to exit.
          Effect.ensuring(Effect.sync(() => {
            if (view$.status.phase.peek() !== "installing") view$.busy.set(false);
          })),
        );
      return {
        view$,
        check: asked(update.UpdateCheck()),
        restartAndInstall: asked(update.UpdateRestartAndInstall()),
      };
    }),
  );
}
