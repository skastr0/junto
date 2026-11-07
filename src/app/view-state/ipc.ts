/**
 * View state over IPC (0.11, 04): one snapshot at window load, one write per
 * changed row, and a push of that write to every window as it lands. Machine
 * local; nothing here is journalled or sent to another machine.
 *
 * Both handlers ask the core's view-state group (src/contract/core/view-state.ts).
 * The write is decoded here, at main's edge, from the shared strict union, so
 * the core is only ever handed a row; the core publishes the committed row,
 * which main forwards. A write that cannot be decoded, or a store failure,
 * answers `{ ok: false }` and the renderer keeps its mirror as it was; a push
 * is sent only after the row committed.
 */
import type { IpcMain } from "electron";
import { Context, Result } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import { decodeViewStateWrite, type ViewStateApplyResult } from "@shared/view-state";
import { ViewStateCore } from "../../contract/core/view-state";
import { CorePushesMain } from "../core-process/main-side/core-pushes";
import { AppRuntime } from "../runtime";

export const registerViewStateIpc = (
  ipc: Pick<IpcMain, "handle">,
  broadcast: (channel: string, payload: unknown) => void,
  core: Context.Context<ViewStateCore | CorePushesMain>,
): void => {
  const viewState = Context.get(core, ViewStateCore);
  const pushes = Context.get(core, CorePushesMain);

  ipc.handle(IPC_CHANNELS.viewStateSnapshot, () => AppRuntime.runPromise(viewState.ViewStateSnapshot()));

  // The core publishes each committed write; every window reads it as it lands.
  pushes.subscribe(IPC_CHANNELS.viewStateChanged, (change) => broadcast(IPC_CHANNELS.viewStateChanged, change));

  ipc.handle(IPC_CHANNELS.viewStateApply, (_event, raw: unknown): Promise<ViewStateApplyResult> => {
    const decoded = decodeViewStateWrite(raw);
    if (Result.isFailure(decoded)) return Promise.resolve({ ok: false, error: "this build does not read that view-state write" });
    return AppRuntime.runPromise(viewState.ViewStateApply({ write: decoded.success }));
  });
};
