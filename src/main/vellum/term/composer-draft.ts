/**
 * Operator composer draft ledger — the gate that stops the factory from
 * submitting a half-written prompt.
 *
 * The drive's only busy signal used to be seat state. A seat whose agent is
 * done is `idle` even while the operator is mid-sentence in the prompt box, so
 * a factory notice would paste + CR straight into that draft and submit it.
 *
 * Screen text cannot answer "is the composer empty?" portably: measured on
 * live seats, `extractPromptBoxText` returns "" for Claude and Pi but the
 * harness footer for Cursor and Grok and a bare ">" for Antigravity. Chrome is
 * indistinguishable from a draft, so a screen-derived gate would either miss
 * drafts or block delivery forever.
 *
 * Keystrokes are exact. Every operator byte reaches the PTY through the
 * terminal write IPC, so this ledger counts what the operator put in the box
 * and what took it back out. Non-zero count means a draft is on screen and no
 * factory write may land.
 */

/** Ctrl+C — every v1 harness clears the composer with it. */
const INTERRUPT = "\u0003";
/** Ctrl+U — kill line. */
const KILL_LINE = "\u0015";
/** Ctrl+W kills a word; count is unknowable, so treat it as a full clear. */
const KILL_WORD = "\u0017";
const BACKSPACE = "\u007f";
const BACKSPACE_ALT = "\u0008";
const ESC = "\u001b";

export type ComposerDraftDelta =
  /** Draft is gone: submitted or cleared. */
  | { readonly kind: "clear" }
  /** Net change in visible characters (may be negative). */
  | { readonly kind: "delta"; readonly chars: number };

/**
 * Classify one operator write into its effect on the composer.
 *
 * A write carrying a submit (CR/LF) or a clearing key resets the draft: what
 * came before it left the box. Otherwise printable characters add and
 * backspaces subtract. Escape sequences (arrows, function keys, mouse, paste
 * markers) are chrome — they move the cursor without changing the character
 * count, so they are skipped rather than counted.
 */
export const classifyComposerWrite = (data: string): ComposerDraftDelta => {
  let chars = 0;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i]!;
    if (ch === "\r" || ch === "\n") return { kind: "clear" };
    if (ch === INTERRUPT || ch === KILL_LINE || ch === KILL_WORD) {
      return { kind: "clear" };
    }
    if (ch === BACKSPACE || ch === BACKSPACE_ALT) {
      chars -= 1;
      continue;
    }
    if (ch === ESC) {
      // Skip the sequence body: CSI/SS3 run to a final byte in @..~, and a
      // lone ESC (or ESC + one char) is a meta key. Never counted either way.
      const next = data[i + 1];
      if (next === "[" || next === "O") {
        let j = i + 2;
        while (j < data.length && !/[@-~]/u.test(data[j]!)) j++;
        i = j;
      } else if (next !== undefined) {
        i += 1;
      }
      continue;
    }
    // Remaining C0 controls are editing/navigation keys, not visible text.
    if (ch < " ") continue;
    chars += 1;
  }
  return { kind: "delta", chars };
};

export type ComposerClearListener = (bindingId: string) => void;

/**
 * Per-binding count of operator-typed characters sitting in the prompt box.
 * Process-local: a draft the operator abandons is cleared by the next submit,
 * clearing key, or terminal generation change.
 */
export class ComposerDraftLedger {
  private readonly chars = new Map<string, number>();
  private readonly listeners = new Set<ComposerClearListener>();

  /** Record one operator write to a seat's PTY. */
  note(bindingId: string, data: string): void {
    const before = this.chars.get(bindingId) ?? 0;
    const delta = classifyComposerWrite(data);
    if (delta.kind === "clear") {
      this.set(bindingId, 0, before);
      return;
    }
    this.set(bindingId, Math.max(0, before + delta.chars), before);
  }

  /** Drop any draft state for a binding (epoch change, seat gone). */
  clear(bindingId: string): void {
    this.set(bindingId, 0, this.chars.get(bindingId) ?? 0);
  }

  /** True while the operator has unsubmitted text in the prompt box. */
  hasDraft(bindingId: string): boolean {
    return (this.chars.get(bindingId) ?? 0) > 0;
  }

  /** Characters currently counted (diagnostics / tests). */
  draftLength(bindingId: string): number {
    return this.chars.get(bindingId) ?? 0;
  }

  /** Notified when a binding's draft goes from present to empty. */
  onClear(listener: ComposerClearListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Test seam. */
  resetForTest(): void {
    this.chars.clear();
  }

  private set(bindingId: string, next: number, before: number): void {
    if (next <= 0) this.chars.delete(bindingId);
    else this.chars.set(bindingId, next);
    if (before > 0 && next <= 0) {
      for (const listener of this.listeners) listener(bindingId);
    }
  }
}

/** Process singleton — the terminal write IPC feeds it, the drive reads it. */
export const composerDraft = new ComposerDraftLedger();
