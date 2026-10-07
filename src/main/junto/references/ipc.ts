import type { IpcMain } from "electron";
import { Effect } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import {
  APP_REFERENCE_PLACE,
  toReferenceSummary,
  type AppBriefing,
  type AppBriefingWriteResult,
  type ReferenceDeleteResult,
  type ReferencePlace,
  type ReferenceSummary,
  type ReferenceWriteResult,
  type ReferencesChangedEvent,
  type StoredReference,
} from "@shared/references";
import { onReferencesChanged } from "./changes";
import { ReferencesRepository, type ReferencesRepositoryError } from "./repository";

/**
 * What the window calls for the app briefing and references. Thin over the
 * one store; the operator is the author. A read that cannot be answered
 * rejects; a write that is refused answers with the reason in words.
 */
export type ReferencesRun = <A, E>(effect: Effect.Effect<A, E, ReferencesRepository>) => Promise<A>;

const NOT_SAVED = "that could not be saved; try again";

const record = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};

type Placed = { readonly ok: true; readonly place: ReferencePlace } | { readonly ok: false; readonly message: string };

/** Nothing is the app; a canvas and a region together are that region. */
const placeOf = (input: unknown): Placed => {
  const { canvasName, regionId } = record(input);
  if (canvasName === undefined && regionId === undefined) return { ok: true, place: APP_REFERENCE_PLACE };
  if (typeof canvasName === "string" && canvasName.length > 0 && typeof regionId === "string" && regionId.length > 0) {
    return { ok: true, place: { kind: "region", canvasName, regionId } };
  }
  return { ok: false, message: "a region's reference needs both its canvas and its region" };
};

const refusal = (error: ReferencesRepositoryError): { readonly ok: false; readonly message: string } => ({
  ok: false,
  message: error._tag === "ReferenceRefused" ? error.message : NOT_SAVED,
});

export const referencesIpcHandlers = (run: ReferencesRun) => {
  const store = <A, E>(use: (repository: ReferencesRepository["Service"]) => Effect.Effect<A, E>) =>
    run(Effect.flatMap(ReferencesRepository, use));
  const settled = <A extends { readonly ok: true }>(
    use: (repository: ReferencesRepository["Service"]) => Effect.Effect<A, ReferencesRepositoryError>,
  ) =>
    run(
      Effect.flatMap(ReferencesRepository, use).pipe(
        Effect.catch((error) => Effect.succeed(refusal(error))),
      ),
    );
  const placedOrThrow = (input: unknown): ReferencePlace => {
    const placed = placeOf(input);
    if (!placed.ok) throw new Error(placed.message);
    return placed.place;
  };

  return {
    appBriefingRead: (): Promise<AppBriefing | null> => store((repository) => repository.briefingRead()),
    appBriefingWrite: (body: unknown): Promise<AppBriefingWriteResult> =>
      typeof body !== "string"
        ? Promise.resolve({ ok: false, message: "the briefing must be text" })
        : settled((repository) =>
            repository.briefingWrite(body, "operator").pipe(Effect.map((briefing) => ({ ok: true as const, briefing }))),
          ),
    referencesList: async (input: unknown): Promise<ReadonlyArray<ReferenceSummary>> => {
      const place = placedOrThrow(input);
      return (await store((repository) => repository.list(place))).map(toReferenceSummary);
    },
    referencesRead: async (input: unknown): Promise<StoredReference | null> => {
      const place = placedOrThrow(input);
      return store((repository) => repository.read(place, record(input).name));
    },
    referencesWrite: (input: unknown): Promise<ReferenceWriteResult> => {
      const placed = placeOf(input);
      if (!placed.ok) return Promise.resolve(placed);
      const { name, description, body } = record(input);
      return settled((repository) =>
        repository
          .write(placed.place, { name, description, body }, "operator")
          .pipe(Effect.map((reference) => ({ ok: true as const, reference: toReferenceSummary(reference) }))),
      );
    },
    referencesDelete: (input: unknown): Promise<ReferenceDeleteResult> => {
      const placed = placeOf(input);
      if (!placed.ok) return Promise.resolve(placed);
      return settled((repository) =>
        repository.remove(placed.place, record(input).name).pipe(Effect.map((deleted) => ({ ok: true as const, deleted }))),
      );
    },
  };
};

/** One line in the app's IPC registration; returns how to stop the broadcast. */
export const registerReferencesIpc = (
  ipcMain: Pick<IpcMain, "handle">,
  broadcast: (channel: string, payload: ReferencesChangedEvent) => void,
  run: ReferencesRun,
): (() => void) => {
  const handlers = referencesIpcHandlers(run);
  ipcMain.handle(IPC_CHANNELS.appBriefingRead, () => handlers.appBriefingRead());
  ipcMain.handle(IPC_CHANNELS.appBriefingWrite, (_event, body: unknown) => handlers.appBriefingWrite(body));
  ipcMain.handle(IPC_CHANNELS.referencesList, (_event, input: unknown) => handlers.referencesList(input));
  ipcMain.handle(IPC_CHANNELS.referencesRead, (_event, input: unknown) => handlers.referencesRead(input));
  ipcMain.handle(IPC_CHANNELS.referencesWrite, (_event, input: unknown) => handlers.referencesWrite(input));
  ipcMain.handle(IPC_CHANNELS.referencesDelete, (_event, input: unknown) => handlers.referencesDelete(input));
  // Every committed write, the operator's or an overseer's, reaches open pages.
  return onReferencesChanged((event) => broadcast(IPC_CHANNELS.referencesChanged, event));
};
