import type { CanvasDoc } from "@shared/canvas";
import type { CanvasReadResult } from "@shared/ipc";

/** External reloads retain the complete main-owned canvas projection. */
export type ExternalCanvasRead = CanvasReadResult;

export interface CanvasExternalReloadDeps {
  readonly flushLocalEdits: () => Promise<void>;
  readonly readCanvas: (name: string) => Promise<ExternalCanvasRead>;
  readonly currentCanvasName: () => string;
  readonly currentDoc: () => CanvasDoc;
  readonly currentDocEpoch: () => number;
  readonly currentRevision: (name: string) => string | undefined;
  readonly hasPendingChanges: (name: string) => boolean;
  readonly acceptRevision: (name: string, revision: string) => void;
  readonly apply: (result: ExternalCanvasRead) => void;
  readonly onFailure: (error: unknown) => void;
}

export interface CanvasExternalReloadCoordinator {
  readonly changed: (name: string) => Promise<void>;
}

/**
 * Orders asynchronous canvasChanged reloads (app-owned write notifications)
 * and rejects results whose canvas or local revision changed while disk I/O
 * was in flight. A later notification always supersedes an earlier read, even
 * when the reads resolve out of order. External raw disk edits do not drive
 * this path.
 */
export const makeCanvasExternalReloadCoordinator = (
  deps: CanvasExternalReloadDeps,
): CanvasExternalReloadCoordinator => {
  let latestRequest = 0;

  const isCurrentRequest = (request: number, name: string): boolean =>
    request === latestRequest
    && deps.currentCanvasName() === name;

  return {
    changed: async (name) => {
      const request = ++latestRequest;
      if (deps.currentCanvasName() !== name) return;

      try {
        // This is also the editor-draft boundary. A conflicting disk edit may
        // rebind the local document to a recovery canvas; if so, the guards
        // below deliberately abandon this original-canvas notification.
        await deps.flushLocalEdits();
        if (!isCurrentRequest(request, name)) return;

        const baselineRevision = deps.currentRevision(name);
        const baselineDocEpoch = deps.currentDocEpoch();
        const result = await deps.readCanvas(name);
        if (!isCurrentRequest(request, name)) return;

        // A user edit can arrive while readCanvas is pending without changing
        // the accepted revision yet. Make that edit durable and let its own
        // change notification drive the next read rather than rolling it back.
        if (deps.hasPendingChanges(name)) {
          await deps.flushLocalEdits();
          return;
        }
        if (
          deps.currentRevision(name) !== baselineRevision
          || deps.currentDocEpoch() !== baselineDocEpoch
        ) return;

        if (result.revision === baselineRevision) return;
        if (JSON.stringify(result.doc) === JSON.stringify(deps.currentDoc())) {
          deps.acceptRevision(name, result.revision);
          return;
        }
        deps.apply(result);
      } catch (error) {
        // A superseded request cannot own the visible error channel.
        if (request === latestRequest && deps.currentCanvasName() === name) {
          deps.onFailure(error);
        }
      }
    },
  };
};
