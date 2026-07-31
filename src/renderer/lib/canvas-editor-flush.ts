import {
  canvasMutationsQuiesced,
  drainCanvasAuthoringOperations,
  flushPendingCanvasSave,
  quiesceCanvasMutations,
} from "./mutations";

export { runCanvasAuthoringOperation } from "./mutations";

type DraftCommit = () => void;

type ActiveElement = Pick<HTMLElement, "blur"> & {
  /** Optional so the flush boundary remains unit-testable without a DOM. */
  readonly closest?: (selectors: string) => unknown;
};

const FOCUS_SURFACE_SELECTOR = "[data-focus-surface='1']";

/**
 * External canvas notifications also flush local editors. Work surfaces are
 * part of that notification path, but their inputs are not canvas editors:
 * blurring one would move the caret every time a task or request projection
 * changes underneath the open dialog.
 */
export const shouldBlurCanvasFlushTarget = (element: ActiveElement | null): boolean => {
  if (!element) return false;
  const closest = element.closest;
  return typeof closest !== "function" || !closest.call(element, FOCUS_SURFACE_SELECTOR);
};

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
    if (activeElement && shouldBlurCanvasFlushTarget(activeElement)) {
      activeElement.blur();
    }
  } catch (error) {
    firstError ??= error;
  }

  if (firstError !== undefined) throw firstError;
};

/** Commits editor-local drafts, then drains every resulting canvas write. */
export const flushCanvasEdits = async (): Promise<void> => {
  if (!canvasMutationsQuiesced()) commitCanvasEditorDrafts();
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
  quiesceCanvasMutations(commitCanvasEditorDrafts);
  await drainCanvasAuthoringOperations();
  await Promise.resolve();
  await flushPendingCanvasSave();
};
