/** DEC private modes tracked by the headless observer for seat-state signals. */

/** Mouse tracking / encoding modes (xterm CoreMouseService). */
export const MOUSE_DEC_MODES = [
  9, // X10
  1000, // VT200
  1001, // highlight
  1002, // button-event (drag)
  1003, // any-event (move/hover)
  1005, // UTF-8
  1006, // SGR (required by modern TUIs)
  1015, // urxvt
  1016, // SGR pixels
] as const;

/** Alternate screen buffer modes. */
export const ALT_SCREEN_DEC_MODES = [47, 1047, 1049] as const;

const MOUSE_SET = new Set<number>(MOUSE_DEC_MODES);
const ALT_SET = new Set<number>(ALT_SCREEN_DEC_MODES);

export type TerminalAttachModes = {
  readonly bracketedPaste: boolean;
  readonly synchronizedOutput: boolean;
  /** App is painting the alternate screen (1049/1047/47). */
  readonly altScreen: boolean;
  /** Active mouse-related DEC private mode numbers. */
  readonly mouseModes: readonly number[];
};

export const idleAttachModes = (): TerminalAttachModes => ({
  bracketedPaste: false,
  synchronizedOutput: false,
  altScreen: false,
  mouseModes: [],
});

export const isMouseDecMode = (mode: number): boolean => MOUSE_SET.has(mode);
export const isAltScreenDecMode = (mode: number): boolean => ALT_SET.has(mode);

/**
 * Apply a DECSET/DECRST mode number onto attach mode state.
 * `set` true = CSI ? Pm h, false = CSI ? Pm l.
 */
export const applyDecPrivateMode = (
  current: TerminalAttachModes,
  mode: number,
  set: boolean,
): TerminalAttachModes => {
  if (mode === 2004) {
    return { ...current, bracketedPaste: set };
  }
  if (mode === 2026) {
    return { ...current, synchronizedOutput: set };
  }
  if (isAltScreenDecMode(mode)) {
    // Any alt-screen mode on → alt; last off of all three would need a set —
    // we track a single boolean: turning any on sets true; turning any off
    // sets false (apps usually disable the same code they enabled).
    return { ...current, altScreen: set };
  }
  if (isMouseDecMode(mode)) {
    const next = new Set(current.mouseModes);
    if (set) next.add(mode);
    else next.delete(mode);
    return {
      ...current,
      mouseModes: [...next].sort((a, b) => a - b),
    };
  }
  return current;
};
