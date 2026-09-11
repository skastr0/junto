/**
 * Auto-copy selected xterm text to the system clipboard on selection end.
 *
 * Used by the native TerminalSurface. Selection is the
 * only product copy path for PTYs — there is no careful user/assistant turn
 * segmentation in a raw terminal buffer, so we do not offer a "copy session
 * turns" control (that would invent structure that is not there).
 */

export type XtermSelectionApi = {
  readonly hasSelection: () => boolean;
  readonly getSelection: () => string;
};

export type ClipboardWriter = (text: string) => Promise<void> | void;

/** Normalize selection: reject empty / whitespace-only. */
export const selectionTextForCopy = (raw: string | undefined | null): string | undefined => {
  if (typeof raw !== "string") return undefined;
  // Preserve intentional interior whitespace / trailing newlines in code blocks;
  // only reject when the whole selection is empty or pure whitespace.
  if (raw.length === 0 || raw.trim().length === 0) return undefined;
  return raw;
};

/**
 * Decide whether to write the current selection to the clipboard.
 * Skips empty selections and re-writes of the same text (mouseup + selection
 * change both fire after a drag).
 */
export const shouldAutoCopySelection = (
  term: XtermSelectionApi,
  lastCopied: string | undefined,
): string | undefined => {
  if (!term.hasSelection()) return undefined;
  const text = selectionTextForCopy(term.getSelection());
  if (text === undefined) return undefined;
  if (text === lastCopied) return undefined;
  return text;
};

/**
 * Wire mouseup on the xterm host to auto-copy the current selection.
 * Returns a disposer. Does not clear the selection — operator keeps visual feedback.
 */
export const attachXtermAutoCopy = (
  host: HTMLElement,
  term: XtermSelectionApi,
  writeClipboard: ClipboardWriter = defaultClipboardWrite,
  isEnabled: () => boolean = () => true,
): (() => void) => {
  let lastCopied: string | undefined;
  let inFlight: string | undefined;

  const onMouseUp = (): void => {
    if (!isEnabled()) return;
    const text = shouldAutoCopySelection(term, lastCopied);
    if (text === undefined) return;
    // Coalesce concurrent mouseup + selectionchange paths.
    if (inFlight === text) return;
    inFlight = text;
    void Promise.resolve(writeClipboard(text))
      .then(() => {
        lastCopied = text;
      })
      .catch(() => {
        // Clipboard may be denied; leave lastCopied so a retry can succeed.
      })
      .finally(() => {
        if (inFlight === text) inFlight = undefined;
      });
  };

  host.addEventListener("mouseup", onMouseUp);
  return () => {
    host.removeEventListener("mouseup", onMouseUp);
  };
};

export const defaultClipboardWrite: ClipboardWriter = async (text) => {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Electron / older hosts: execCommand fallback.
  if (typeof document === "undefined") {
    throw new Error("clipboard write unavailable");
  }
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.position = "fixed";
  el.style.left = "-9999px";
  document.body.appendChild(el);
  el.select();
  try {
    const ok = document.execCommand("copy");
    if (!ok) throw new Error("execCommand copy failed");
  } finally {
    document.body.removeChild(el);
  }
};
