/**
 * The Files node's own save: Cmd+S saves the file open in the modal in
 * front. The modal registers what its save does while a file is open, and
 * the last one registered is the file in front. With nothing registered the
 * key passes, so Cmd+S never acts on anything else.
 *
 * The save handles its own outcome: a stale or denied write is said in the
 * modal, and the draft is kept. The registry only carries the call.
 */

export type FileEditorSave = () => void | Promise<void>;

const registered: FileEditorSave[] = [];

/** Register a showing file's save; call the returned function when it hides. */
export const registerFileEditorSave = (save: FileEditorSave): (() => void) => {
  registered.push(save);
  return () => {
    const at = registered.lastIndexOf(save);
    if (at >= 0) registered.splice(at, 1);
  };
};

/** Save the file in front; false when no file is open, so the key passes. */
export const saveFileInFront = (): boolean => {
  const front = registered.at(-1);
  if (front === undefined) return false;
  void front();
  return true;
};
