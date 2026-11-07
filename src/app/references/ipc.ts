/**
 * What the window calls for the app briefing and references. Every handler
 * asks the core's references group (src/contract/core/references.ts): the
 * store lives with the core, the operator is the author, and each committed
 * change is published there and forwarded here. What the window sends is
 * decoded closed here, and the place it names is settled here, so the core is
 * only handed a place and a name. A read that cannot be answered rejects; a
 * write that is refused answers with the reason in words.
 */
import type { IpcMain } from "electron";
import { Context, Result } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import {
  decodeReferencePlaceInput,
  decodeReferenceReadInput,
  decodeReferenceWriteInput,
  referencePlaceOf,
  type AppBriefing,
  type AppBriefingWriteResult,
  type ReferenceDeleteResult,
  type ReferenceSummary,
  type ReferenceWriteResult,
  type StoredReference,
} from "@shared/references";
import { ReferencesCore } from "../../contract/core/references";
import { subscribe as onCorePush } from "../core-process/main-side/core-pushes";
import { AppRuntime } from "../runtime";

const UNREADABLE = "this build does not read that request";
const NOT_SAVED = "that could not be saved; try again";

export const registerReferencesIpc = (
  ipcMain: Pick<IpcMain, "handle">,
  broadcast: (channel: string, payload: unknown) => void,
  core: Context.Context<ReferencesCore>,
): (() => void) => {
  const references = Context.get(core, ReferencesCore);
  ipcMain.handle(IPC_CHANNELS.appBriefingRead, (): Promise<AppBriefing | null> =>
    AppRuntime.runPromise(references.ReferencesBriefingRead()),
  );
  ipcMain.handle(IPC_CHANNELS.appBriefingWrite, (_event, body: unknown): Promise<AppBriefingWriteResult> =>
    typeof body === "string"
      ? AppRuntime.runPromise(references.ReferencesBriefingWrite({ body }))
      : Promise.resolve({ ok: false, message: "the briefing must be text" }),
  );
  ipcMain.handle(IPC_CHANNELS.referencesList, (_event, input: unknown): Promise<ReadonlyArray<ReferenceSummary>> => {
    const decoded = decodeReferencePlaceInput(input ?? {});
    if (Result.isFailure(decoded)) return Promise.reject(new Error(UNREADABLE));
    const placed = referencePlaceOf(decoded.success);
    if (!placed.ok) return Promise.reject(new Error(placed.message));
    return AppRuntime.runPromise(references.ReferencesList({ place: placed.place }));
  });
  ipcMain.handle(IPC_CHANNELS.referencesRead, (_event, input: unknown): Promise<StoredReference | null> => {
    const decoded = decodeReferenceReadInput(input);
    if (Result.isFailure(decoded)) return Promise.reject(new Error(UNREADABLE));
    const { canvasName, regionId, name } = decoded.success;
    const placed = referencePlaceOf({ canvasName, regionId });
    if (!placed.ok) return Promise.reject(new Error(placed.message));
    return AppRuntime.runPromise(references.ReferencesRead({ place: placed.place, name }));
  });
  ipcMain.handle(IPC_CHANNELS.referencesWrite, (_event, input: unknown): Promise<ReferenceWriteResult> => {
    const decoded = decodeReferenceWriteInput(input);
    if (Result.isFailure(decoded)) return Promise.resolve({ ok: false, message: NOT_SAVED });
    const { canvasName, regionId, name, description, body } = decoded.success;
    const placed = referencePlaceOf({ canvasName, regionId });
    if (!placed.ok) return Promise.resolve(placed);
    return AppRuntime.runPromise(references.ReferencesWrite({ place: placed.place, name, description, body }));
  });
  ipcMain.handle(IPC_CHANNELS.referencesDelete, (_event, input: unknown): Promise<ReferenceDeleteResult> => {
    const decoded = decodeReferenceReadInput(input);
    if (Result.isFailure(decoded)) return Promise.resolve({ ok: false, message: NOT_SAVED });
    const { canvasName, regionId, name } = decoded.success;
    const placed = referencePlaceOf({ canvasName, regionId });
    if (!placed.ok) return Promise.resolve(placed);
    return AppRuntime.runPromise(references.ReferencesDelete({ place: placed.place, name }));
  });
  // Every committed write, the operator's or an overseer's, reaches open pages.
  return onCorePush(IPC_CHANNELS.referencesChanged, (event) => broadcast(IPC_CHANNELS.referencesChanged, event));
};
