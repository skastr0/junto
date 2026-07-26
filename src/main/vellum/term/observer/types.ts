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

export type SessionObserverOptions = {
  readonly bindingId: string;
  readonly epoch: string;
  readonly cols: number;
  readonly rows: number;
  /** Unicode version pin — both grids must agree (plan trap: wide-char columns). */
  readonly unicodeVersion?: "6" | "11";
};
