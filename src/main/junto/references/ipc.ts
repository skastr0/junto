/**
 * What the window calls for the app briefing and references. Every handler is
 * a core operation (core-process/ops/ipc-references.ts): the store lives with
 * the core, the operator is the author, and each committed change is published
 * there and forwarded here. A read that cannot be answered rejects; a write
 * that is refused answers with the reason in words.
 */
import type { IpcMain } from "electron";
import { IPC_CHANNELS } from "@shared/ipc";
import type {
  AppBriefing,
  AppBriefingWriteResult,
  ReferenceDeleteResult,
  ReferenceSummary,
  ReferenceWriteResult,
  StoredReference,
} from "@shared/references";
import { askOnEveryCore } from "../../core-process/every-core";
import { core } from "../../core-process/main-client";
import { subscribe as onCorePush } from "../../core-process/push";

export const registerReferencesIpc = (
  ipcMain: Pick<IpcMain, "handle">,
  broadcast: (channel: string, payload: unknown) => void,
): (() => void) => {
  ipcMain.handle(IPC_CHANNELS.appBriefingRead, (): Promise<AppBriefing | null> =>
    core.call("ipc.references.briefingRead", {}),
  );
  ipcMain.handle(IPC_CHANNELS.appBriefingWrite, (_event, body: unknown): Promise<AppBriefingWriteResult> =>
    core.call("ipc.references.briefingWrite", { input: body }),
  );
  ipcMain.handle(IPC_CHANNELS.referencesList, (_event, input: unknown): Promise<ReadonlyArray<ReferenceSummary>> =>
    core.call("ipc.references.list", { input }),
  );
  ipcMain.handle(IPC_CHANNELS.referencesRead, (_event, input: unknown): Promise<StoredReference | null> =>
    core.call("ipc.references.read", { input }),
  );
  ipcMain.handle(IPC_CHANNELS.referencesWrite, (_event, input: unknown): Promise<ReferenceWriteResult> =>
    core.call("ipc.references.write", { input }),
  );
  ipcMain.handle(IPC_CHANNELS.referencesDelete, (_event, input: unknown): Promise<ReferenceDeleteResult> =>
    core.call("ipc.references.delete", { input }),
  );
  // Every committed write, the operator's or an overseer's, reaches open pages.
  const stop = onCorePush(IPC_CHANNELS.referencesChanged, (event) =>
    broadcast(IPC_CHANNELS.referencesChanged, event),
  );
  askOnEveryCore("ipc.references.watch", () => core.call("ipc.references.watch", {}));
  return stop;
};
