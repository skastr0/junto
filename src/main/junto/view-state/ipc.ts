/**
 * View state over IPC (0.11, 04): one snapshot at window load, one write per
 * changed row, and a push of that write to every window as it lands. Machine
 * local; nothing here is journalled or sent to another machine.
 *
 * Both handlers are core operations (core-process/ops/ipc-view-state.ts): the
 * write is decoded from the shared strict union in the core, before the store
 * sees it, and the core publishes the committed row, which main forwards. A
 * write that cannot be decoded, or a store failure, answers `{ ok: false }`
 * and the renderer keeps its mirror as it was; a push is sent only after the
 * row committed.
 */
import type { IpcMain } from "electron";
import { IPC_CHANNELS, type ViewStateApplyResult } from "@shared/ipc";
import type { ViewStateReload } from "@shared/view-state";
import { core } from "../../core-process/main-client";
import { subscribe as onCorePush } from "../../core-process/push";
import { subscribeViewStateChanges } from "./changes";

export const registerViewStateIpc = (
  ipc: Pick<IpcMain, "handle">,
  broadcast: (channel: string, payload: unknown) => void,
): void => {
  ipc.handle(IPC_CHANNELS.viewStateSnapshot, () => core.call("ipc.viewState.snapshot", {}));

  // The core publishes each committed write; every window reads it as it lands.
  onCorePush(IPC_CHANNELS.viewStateChanged, (change) => broadcast(IPC_CHANNELS.viewStateChanged, change));

  // A node or canvas delete took rows in its transaction; every window reads again.
  subscribeViewStateChanges(() => {
    broadcast(IPC_CHANNELS.viewStateChanged, { area: "reload" } satisfies ViewStateReload);
  });

  ipc.handle(IPC_CHANNELS.viewStateApply, (_event, raw: unknown): Promise<ViewStateApplyResult> =>
    core.call("ipc.viewState.apply", { input: raw }),
  );
};
