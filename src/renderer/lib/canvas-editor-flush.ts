import {
  canvasMutationsQuiesced,
  drainCanvasAuthoringOperations,
  flushPendingCanvasSave,
  quiesceCanvasMutations,
} from "./mutations";
import { ownsCanvasDraftFocus, releaseFocus } from "./focus-ownership";

export { runCanvasAuthoringOperation } from "./mutations";

type DraftCommit = () => void;

type ActiveElement = Pick<HTMLElement, "blur"> & {
  /** Optional so the flush boundary remains unit-testable without a DOM. */
  readonly closest?: (selectors: string) => unknown;
};

/**
 * Why the canvas is flushing.
 * - background: a canvasChanged echo (agent activity, work facts, our own
 *   save). The operator may be mid-keystroke; focus is never touched.
 * - navigation: the document is about to be swapped or the app is quitting,
 *   so a commit-on-blur draft must land now.
 */
export type CanvasFlushCause = "background" | "navigation";

/**
 * Only a navigation flush may release focus, and only from an explicitly
 * marked authoring draft. Unmarked inputs are protected by default,
 * including future work surfaces that do not yet know about this policy.
 */
export const shouldBlurCanvasFlushTarget = (
  element: ActiveElement | null,
  cause: CanvasFlushCause = "navigation",
): boolean => cause === "navigation" && ownsCanvasDraftFocus(element);

// Most canvas editors commit on blur. Editors that intentionally cannot do
// that (for example a modal with an explicit discard action) register their
// live commit boundary here so navigation and native quit can still make the
// current draft durable before the renderer acknowledges the operation.
const draftCommits = new Set<DraftCommit>();

export const registerCanvasDraftCommit = (commit: DraftCommit): (() => void) => {
  draftCommits.add(commit);
  return () => {
    draftCommits.delete(commit);
  };
};

export const commitCanvasEditorDrafts = (
  cause: CanvasFlushCause = "navigation",
  activeElement: ActiveElement | null =
    typeof document === "undefined" ? null : document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
): void => {
  let firstError: unknown;

  for (const commit of [...draftCommits]) {
    try {
      commit();
    } catch (error) {
      firstError ??= error;
    }
  }

  try {
    if (activeElement && shouldBlurCanvasFlushTarget(activeElement, cause)) {
      releaseFocus(activeElement, "navigation");
    }
  } catch (error) {
    firstError ??= error;
  }

  if (firstError !== undefined) throw firstError;
};

/** Commits editor-local drafts, then drains every resulting canvas write. */
export const flushCanvasEdits = async (cause: CanvasFlushCause): Promise<void> => {
  if (!canvasMutationsQuiesced()) commitCanvasEditorDrafts(cause);
  // React blur handlers and registered commits update the observable document
  // synchronously. The microtask also lets any same-turn handler finish before
  // the save pump is inspected.
  await Promise.resolve();
  await flushPendingCanvasSave();
};

/**
 * Signal-only finality boundary. Drafts commit and mutation admission closes
 * synchronously before the first await; the remaining async work can only
 * drain snapshots that were already admitted.
 */
export const quiesceAndFlushCanvasEdits = async (): Promise<void> => {
  quiesceCanvasMutations(() => commitCanvasEditorDrafts("navigation"));
  await drainCanvasAuthoringOperations();
  await Promise.resolve();
  await flushPendingCanvasSave();
};
