/**
 * View state over IPC (0.11, 04): one snapshot at window load, one write per
 * changed row, and a push of that write to every window as it lands. Machine
 * local; nothing here is journalled or sent to another machine.
 *
 * The write is decoded from the shared strict union before the store sees it.
 * A write that cannot be decoded, or a store failure, answers `{ ok: false }`
 * and the renderer keeps its mirror as it was; a push is sent only after the
 * row committed.
 */
import type { IpcMain } from "electron";
import { Effect } from "effect";
import { IPC_CHANNELS, type ViewStateApplyResult } from "@shared/ipc";
import { decodeViewStateWrite } from "@shared/view-state";
import { ViewStateRepository, type ViewStatePersistenceError } from "./repository";

export type ViewStateRun = <A, E>(effect: Effect.Effect<A, E, ViewStateRepository>) => Promise<A>;

export const registerViewStateIpc = (
  ipc: Pick<IpcMain, "handle">,
  broadcast: (channel: string, payload: unknown) => void,
  run: ViewStateRun,
): void => {
  ipc.handle(IPC_CHANNELS.viewStateSnapshot, () =>
    run(Effect.flatMap(ViewStateRepository, (store) => store.snapshot())),
  );

  ipc.handle(IPC_CHANNELS.viewStateApply, (_event, raw: unknown) => {
    const decoded = decodeViewStateWrite(raw);
    if (decoded._tag === "Failure") {
      return { ok: false, error: "this build does not read that view-state write" } satisfies ViewStateApplyResult;
    }
    const write = decoded.success;
    return run(
      Effect.flatMap(ViewStateRepository, (store) =>
        store.write(write).pipe(
          Effect.flatMap((written): Effect.Effect<ViewStateApplyResult> =>
            written
              ? Effect.sync(() => {
                  // After the row's transaction committed, never before.
                  broadcast(IPC_CHANNELS.viewStateChanged, write);
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
        ),
      ),
    );
  });
};
