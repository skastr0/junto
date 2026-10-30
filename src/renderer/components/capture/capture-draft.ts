/**
 * Quick capture's kept draft (0.12, the Cmd+T desk): the document words the
 * operator wrote, on disk at every change, so a close, a quit, a kill -9 or a
 * reboot loses none of them (`view_capture_desks`, one row per canvas).
 *
 * One write is in flight at a time; a change made while it runs waits and
 * is written next, replacing any other change that waited. So the words a
 * kill can take are only those typed after the last write landed. Once the
 * words are in their artifact the row is cleared, so it never brings back
 * text the artifact already holds.
 */
import type { CaptureDraft } from "@shared/view-state";
import { nodeViewStore } from "../../lib/node-view-state";

export type CaptureDraftWriter = {
  /** Keep this draft, or null to clear it. */
  readonly write: (draft: CaptureDraft | null) => void;
  /**
   * Resolves once nothing is waiting and nothing is in flight. Never rejects.
   * Each write that arrives meanwhile is waited for too, so while the
   * operator keeps typing it keeps waiting: await it as the writing closes.
   */
  readonly settled: () => Promise<void>;
};

/** The draft kept for a canvas, as the window loaded it or last wrote it. */
export const captureDraftOf = (canvas: string): CaptureDraft | undefined => nodeViewStore().captureDraft(canvas);

export const captureDraftWriter = (canvas: string): CaptureDraftWriter => {
  /** The change waiting for the one in flight; undefined while none waits. */
  let waiting: CaptureDraft | null | undefined;
  let flight: Promise<void> | null = null;

  const run = (draft: CaptureDraft | null): Promise<void> =>
    nodeViewStore()
      .writeCaptureDraft(canvas, draft)
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        if (waiting === undefined) {
          flight = null;
          return;
        }
        const next = waiting;
        waiting = undefined;
        flight = run(next);
        return flight;
      });

  return {
    write: (draft) => {
      if (flight !== null) {
        waiting = draft;
        return;
      }
      flight = run(draft);
    },
    settled: async () => {
      while (flight !== null) await flight;
    },
  };
};
