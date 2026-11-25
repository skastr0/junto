import { PERF_ENABLED } from "./performance/perf-flag";

/**
 * The phases of one terminal's open, as marks, so a probe can say how much of a
 * grid open is the constructor, the fit addon, xterm's own open, the WebGL
 * attach and the first fit, per cell.
 *
 * Off unless JUNTO_PERF is on: an always-off build pays neither the call nor
 * the string it would build. The name pair is `junto-term-open:<key>:<phase>:
 * <start|end>`; a probe reads them with performance.getEntriesByType("mark")
 * and measures each pair itself.
 */
export type TerminalOpenPhase = "ctor" | "fit-addon" | "open" | "webgl" | "fit";

const PREFIX = "junto-term-open";

export const openPhaseMark = (
  key: string,
  phase: TerminalOpenPhase,
  edge: "start" | "end",
): void => {
  if (!PERF_ENABLED) return;
  performance.mark(`${PREFIX}:${key}:${phase}:${edge}`);
};

/**
 * When the first paint lands, as one mark. The probe compares it with the
 * start of the open phase: everything the grid paid for a cell is the distance
 * from the constructor to the first painted frame.
 */
export const markFirstPaint = (key: string): void => {
  if (!PERF_ENABLED) return;
  performance.mark(`${PREFIX}:${key}:first-paint`);
};
