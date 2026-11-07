import { observable } from "@legendapp/state";
import { baseName, type FilePath } from "@shared/files";
import type { NodeId } from "@shared/physics/schema";
import { fileDraftCanvas, filesErrorLine, filesSource, heldFileDrafts, setFileDraft } from "./files-source";

/**
 * Unsaved Files drafts before the window goes (quit, close, reload). Drafts
 * live only in memory and never go to disk outside the file itself, so
 * leaving with any asks first: Save all, Discard, or Cancel, as editors do.
 * `settleFileDrafts` answers whether leaving may go on; main asks it before a
 * quit or a close, and a reload asks it through `beforeunload`.
 */

export type DraftsAsk = {
  /** The files with drafts, by name, for the question. */
  readonly names: ReadonlyArray<string>;
  /** Files Save all could not write, each with why. Empty until a save is refused. */
  readonly refused: ReadonlyArray<string>;
  readonly busy: boolean;
};

export const draftsAsk$ = observable<{ pending: DraftsAsk | null }>({ pending: null });

type Answer = "save" | "discard" | "cancel";
let answer: ((choice: Answer) => void) | null = null;
let settling: Promise<boolean> | null = null;

/** The operator chose (UnsavedFilesHost calls this). */
export const answerDraftsAsk = (choice: Answer): void => {
  const resolve = answer;
  answer = null;
  resolve?.(choice);
};

/** Write every draft back to its file; a refused one keeps its draft and says why. */
const saveAll = async (): Promise<ReadonlyArray<string>> => {
  const refused: string[] = [];
  for (const { node, path, draft } of heldFileDrafts()) {
    const canvas = fileDraftCanvas(node);
    if (canvas === undefined) {
      refused.push(`${baseName(path)}: ${filesErrorLine("no-node")}`);
      continue;
    }
    const result = await filesSource().write({ canvas, node }, path, draft.text, draft.base);
    // Text typed while the write was out is newer than what landed: it stays.
    if (result.ok) dropIfSame(node, path, draft.text);
    else refused.push(`${baseName(path)}: ${filesErrorLine(result.error)}`);
  }
  return refused;
};

const dropIfSame = (node: NodeId, path: FilePath, text: string): void => {
  const now = heldFileDrafts().find((held) => held.node === node && held.path === path);
  if (now?.draft.text === text) setFileDraft(node, path, undefined);
};

const ask = async (): Promise<boolean> => {
  const names = heldFileDrafts().map(({ path }) => baseName(path));
  draftsAsk$.pending.set({ names, refused: [], busy: false });
  try {
    for (;;) {
      const choice = await new Promise<Answer>((resolve) => {
        answer = resolve;
      });
      if (choice === "cancel") return false;
      if (choice === "discard") {
        for (const { node, path } of heldFileDrafts()) setFileDraft(node, path, undefined);
        return true;
      }
      draftsAsk$.pending.busy.set(true);
      const refused = await saveAll();
      if (refused.length === 0) return true;
      // Nothing leaves while a draft could not be written: the operator chooses again.
      draftsAsk$.pending.set({ names: heldFileDrafts().map(({ path }) => baseName(path)), refused, busy: false });
    }
  } finally {
    answer = null;
    draftsAsk$.pending.set(null);
  }
};

/** Whether the window may go: true at once without drafts, else what the operator chose. One ask at a time. */
export const settleFileDrafts = (): Promise<boolean> => {
  if (heldFileDrafts().length === 0) return Promise.resolve(true);
  settling ??= ask().finally(() => {
    settling = null;
  });
  return settling;
};

/**
 * A reload with drafts stops and asks. Whatever the answer, the reload does
 * not go on by itself: once the drafts are saved or dropped, the next one
 * does. Returns the uninstall.
 */
export const installFileDraftsUnloadGuard = (target: Window = window): (() => void) => {
  const guard = (event: BeforeUnloadEvent): void => {
    if (heldFileDrafts().length === 0) return;
    event.preventDefault();
    event.returnValue = "";
    void settleFileDrafts();
  };
  target.addEventListener("beforeunload", guard);
  return () => target.removeEventListener("beforeunload", guard);
};
