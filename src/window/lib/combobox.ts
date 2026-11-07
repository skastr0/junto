/**
 * Keyboard and ghost-text model for the house typeahead (`ui/Combobox`).
 *
 * The one law: the input value is only what the user typed. A suggestion is
 * ghost text drawn past the caret, never selected text and never part of the
 * value; the highlight moves over the list without writing into the input.
 * Everything here is pure so the rules are testable without a rendered tree.
 */

/**
 * The faint tail to draw after the typed value, or "" when there is none.
 *
 * A completion is only drawn while it extends what was typed (case aside, so
 * "pr" can show "ojects/" of "Projects/"), the caret sits at the end with
 * nothing selected, and the user has not dismissed it for this exact value.
 */
export const ghostSuffix = ({
  value,
  completion,
  caretAtEnd,
  dismissedFor,
}: {
  readonly value: string;
  readonly completion: string | undefined;
  readonly caretAtEnd: boolean;
  readonly dismissedFor?: string;
}): string => {
  if (!completion || !caretAtEnd || dismissedFor === value) return "";
  if (completion.length <= value.length) return "";
  if (!completion.toLowerCase().startsWith(value.toLowerCase())) return "";
  return completion.slice(value.length);
};

export type ComboboxKey = {
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  /** IME composition in progress: every key belongs to the composer. */
  readonly isComposing?: boolean;
};

export type ComboboxKeyState = {
  readonly optionCount: number;
  /** Highlighted option index, or -1 when nothing is highlighted. */
  readonly activeIndex: number;
  /** A ghost suffix is currently drawn. */
  readonly ghost: boolean;
  /** Caret at the end of the value with no selection. */
  readonly caretAtEnd: boolean;
};

export type ComboboxIntent =
  /** Not ours: let the browser and ancestors have the key. */
  | { readonly type: "none" }
  /** Move the highlight; the value is untouched. */
  | { readonly type: "highlight"; readonly index: number }
  /** Take the ghost text into the value. */
  | { readonly type: "accept" }
  /** Enter: act on the highlighted option, or on the typed value when none. */
  | { readonly type: "commit"; readonly index: number | undefined }
  /** Escape with something to clear: drop the highlight and the ghost. */
  | { readonly type: "dismiss" };

const NONE: ComboboxIntent = { type: "none" };

const hasModifier = (event: ComboboxKey): boolean =>
  Boolean(event.altKey || event.ctrlKey || event.metaKey);

/**
 * What a key means to the combobox. Keys that only matter when there is
 * something to act on (Tab, ArrowRight, Escape) pass through otherwise, so
 * focus moves, caret moves, and surface-closing Escape keep working.
 */
export const comboboxKeyIntent = (
  event: ComboboxKey,
  state: ComboboxKeyState,
): ComboboxIntent => {
  if (event.isComposing) return NONE;
  const { optionCount, activeIndex } = state;
  const active = activeIndex >= 0 && activeIndex < optionCount;
  switch (event.key) {
    case "ArrowDown":
    case "ArrowUp": {
      if (optionCount === 0 || hasModifier(event)) return NONE;
      const step = event.key === "ArrowDown" ? 1 : -1;
      if (!active) {
        return { type: "highlight", index: step > 0 ? 0 : optionCount - 1 };
      }
      return {
        type: "highlight",
        index: (activeIndex + step + optionCount) % optionCount,
      };
    }
    case "Tab":
      return state.ghost && !event.shiftKey && !hasModifier(event)
        ? { type: "accept" }
        : NONE;
    case "ArrowRight":
      return state.ghost && state.caretAtEnd && !event.shiftKey && !hasModifier(event)
        ? { type: "accept" }
        : NONE;
    case "Enter":
      if (event.shiftKey || hasModifier(event)) return NONE;
      return { type: "commit", index: active ? activeIndex : undefined };
    case "Escape":
      return active || state.ghost ? { type: "dismiss" } : NONE;
    default:
      return NONE;
  }
};
