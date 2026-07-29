/**
 * DEC private modes that must be re-armed on the renderer after a plain-text
 * attach rebuild. Grid attach loses SGR and mode state; the live PTY app still
 * believes mouse/alt-screen are on, so hover/click die until we re-inject.
 *
 * Sequences are written to the *renderer* xterm only (term.write), never to the
 * PTY — the app already has these modes set.
 */

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
 * Restore the active-grid cursor after a plain-text screen rebuild.
 * Coordinates are zero-based in the attach contract; CUP is one-based.
 * Older independently updated peers may omit them, in which case replay
 * remains usable and live output continues from xterm's current cursor.
 */
export const buildAttachCursorEscape = (
  cursor:
    | {
        readonly x?: number;
        readonly y?: number;
        readonly cols: number;
        readonly rows: number;
      }
    | undefined,
): string => {
  const xValue = cursor?.x;
  const yValue = cursor?.y;
  if (
    !cursor ||
    typeof xValue !== "number" ||
    typeof yValue !== "number" ||
    !Number.isFinite(xValue) ||
    !Number.isFinite(yValue) ||
    !Number.isFinite(cursor.cols) ||
    !Number.isFinite(cursor.rows) ||
    cursor.cols < 1 ||
    cursor.rows < 1
  ) {
    return "";
  }
  const x = Math.max(0, Math.min(Math.floor(xValue), Math.floor(cursor.cols) - 1));
  const y = Math.max(0, Math.min(Math.floor(yValue), Math.floor(cursor.rows) - 1));
  return `\x1b[${y + 1};${x + 1}H`;
};

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

/**
 * Escapes to re-arm renderer xterm after plain-text grid attach.
 * - `beforeContent`: enter alt screen so writes land on the TUI buffer
 * - `afterContent`: mouse + paste + sync (app already owns these on the PTY)
 */
export const buildAttachRestoreEscapes = (
  modes: TerminalAttachModes,
): { readonly beforeContent: string; readonly afterContent: string } => {
  let beforeContent = "";
  if (modes.altScreen) {
    // 1049 = save cursor + alt screen (what nearly all TUIs use).
    beforeContent = "\x1b[?1049h";
  }

  const after: string[] = [];
  if (modes.mouseModes.length > 0) {
    // Encoding (1006) before tracking level is conventional; join is fine.
    after.push(`\x1b[?${modes.mouseModes.join(";")}h`);
  }
  if (modes.bracketedPaste) after.push("\x1b[?2004h");
  if (modes.synchronizedOutput) after.push("\x1b[?2026h");

  return {
    beforeContent,
    afterContent: after.join(""),
  };
};
