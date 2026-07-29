/**
 * Main-process terminal observer types.
 * Screen truth for managed agents — independent of renderer lifetime.
 */

export type ObserverRegionName =
  | "whole_recent"
  | "bottom_non_empty_lines"
  | "footer_line"
  | "after_last_horizontal_rule"
  | "prompt_box_body"
  | "above_prompt_box";

export type ObserverModes = {
  /** CSI ?2004 — bracketed paste mode (readline input is live). */
  readonly bracketedPaste: boolean;
  /** CSI ?2026 — synchronized output (repaint boundary). */
  readonly synchronizedOutput: boolean;
  /** CSI ?1049/1047/47 — alternate screen state used by seat observation. */
  readonly altScreen: boolean;
  /** Active mouse DEC private modes (1000/1002/1003/1006/…). */
  readonly mouseModes: readonly number[];
};

export type ObserverSignals = {
  /** Last OSC 0 / OSC 2 title, sanitized. */
  readonly title: string;
  /** Last OSC 9 payload (after "9;"), raw. Empty when never seen. */
  readonly osc9: string;
  readonly modes: ObserverModes;
};

export type ObserverGridSnapshot = {
  readonly cols: number;
  readonly rows: number;
  /** Bottom `rows` lines of the active buffer as plain text (soft wraps kept). */
  readonly lines: readonly string[];
  /** Joined detection text (newline-separated). */
  readonly text: string;
  readonly signals: ObserverSignals;
  /** Monotonic feed sequence from the PTY plane (not xterm-internal). */
  readonly seq: bigint;
  readonly epoch: string;
  readonly bindingId: string;
};

export type ObserverListener = (snapshot: ObserverGridSnapshot) => void;

/**
 * Full-buffer VT attach payload for the renderer. Used after the exact raw
 * byte journal has truncated; survives long sessions without replaying from
 * the middle of an escape sequence or flattening terminal presentation.
 */
export type AttachScreen = {
  readonly bindingId: string;
  readonly epoch: string;
  readonly cols: number;
  readonly rows: number;
  /** PTY plane seq at serialization time. */
  readonly seq: bigint;
  /** Serialized VT state for the full normal + alternate buffers. */
  readonly serialized: string;
};

export type SessionObserverOptions = {
  readonly bindingId: string;
  readonly epoch: string;
  readonly cols: number;
  readonly rows: number;
  /**
   * Unicode version pin. Stock headless only has `"6"`. `"11"` requires
   * `@xterm/addon-unicode11` on both headless and renderer — do not request
   * it until that addon is loaded everywhere.
   */
  readonly unicodeVersion?: "6";
  /**
   * Headless scrollback lines retained for long-session attach.
   * Default large enough that multi-hour agent sessions do not lose history
   * to a 512KB journal ring.
   */
  readonly scrollback?: number;
};
