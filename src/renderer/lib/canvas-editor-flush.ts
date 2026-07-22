import {
  canvasMutationsQuiesced,
  flushPendingCanvasSave,
  quiesceCanvasMutations,
} from "./mutations";

type DraftCommit = () => void;

// Most canvas editors commit on blur. Editors that intentionally cannot do
// that (for example a modal with an explicit discard action) register their
// live commit boundary here so navigation and native quit can still make the
// current draft durable before the renderer acknowledges the operation.
const draftCommits = new Set<DraftCommit>();
const activeCanvasAuthoringOperations = new Set<Promise<void>>();

/** Admit a direct create/delete operation while the renderer gate is open. */
export const runCanvasAuthoringOperation = async <T>(
  operation: () => Promise<T>,
): Promise<T | undefined> => {
  if (canvasMutationsQuiesced()) return undefined;
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  // Publish the lifetime before invoking caller code so even a re-entrant
  // quiesce observes and drains an operation that admission just accepted.
  activeCanvasAuthoringOperations.add(completion);
  try {
    return await operation();
  } finally {
    finish();
    activeCanvasAuthoringOperations.delete(completion);
  }
};

const drainCanvasAuthoringOperations = async (): Promise<void> => {
  while (activeCanvasAuthoringOperations.size > 0) {
    await Promise.all([...activeCanvasAuthoringOperations]);
  }
};

export const registerCanvasDraftCommit = (commit: DraftCommit): (() => void) => {
  draftCommits.add(commit);
  return () => {
    draftCommits.delete(commit);
  };
};

export const commitCanvasEditorDrafts = (
  activeElement: Pick<HTMLElement, "blur"> | null =
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
    activeElement?.blur();
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
