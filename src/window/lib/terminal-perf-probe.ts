import type { Terminal } from "@xterm/xterm";
import { PERF_ENABLED } from "./performance/perf-flag";

/**
 * Read-only terminal numbers for the performance baseline
 * (e2e/scenarios/perf-terminal-baseline.spec.ts), registered only while
 * JUNTO_PERF is on. It hands out numbers and never the Terminal: the
 * Terminal's input() reaches the PTY, and a renderer global must not.
 */
export type TerminalPerfProbe = {
  readonly visible: () => boolean;
  /** First buffer line in the viewport; moves when the terminal scrolls. */
  readonly viewportY: () => number;
  /** Lines in the active buffer, scrollback included. */
  readonly lines: () => number;
  readonly rows: () => number;
  /** xterm render passes since registration. */
  readonly renders: () => number;
  /** performance.now() of the last parsed write (echo arrived) and the last render pass (echo drawn). */
  readonly parsedAt: () => number;
  readonly renderedAt: () => number;
};

type ProbeRegistry = Map<string, TerminalPerfProbe>;

const registry = (): ProbeRegistry => {
  const host = globalThis as { __juntoTermPerf?: ProbeRegistry };
  host.__juntoTermPerf ??= new Map();
  return host.__juntoTermPerf;
};

/** Register a probe for one terminal; returns the unregister. A no-op unless JUNTO_PERF is on. */
export const registerTerminalPerfProbe = (
  key: string,
  term: Terminal,
  visible: () => boolean,
): (() => void) => {
  if (!PERF_ENABLED) return () => {};
  let renders = 0;
  let parsedAt = 0;
  let renderedAt = 0;
  const onRender = term.onRender(() => {
    renders += 1;
    renderedAt = performance.now();
  });
  const onParsed = term.onWriteParsed(() => {
    parsedAt = performance.now();
  });
  registry().set(key, {
    visible,
    viewportY: () => term.buffer.active.viewportY,
    lines: () => term.buffer.active.length,
    rows: () => term.rows,
    renders: () => renders,
    parsedAt: () => parsedAt,
    renderedAt: () => renderedAt,
  });
  return () => {
    onRender.dispose();
    onParsed.dispose();
    registry().delete(key);
  };
};
