/**
 * One `[perf]` row a minute in the machine log, in every build: the window's
 * long animation frames (frames that took over 50 ms from start to paint),
 * and the scripts that ran inside them, by total time.
 *
 * WHY. The installed app cannot be profiled from outside, and lag is felt as
 * these frames. Chromium's Long Animation Frames API attributes each one to
 * its scripts (what invoked them, the function, the source file), so the rows
 * name the code that stalled the window, after the fact, with no profiler.
 *
 * COST. A PerformanceObserver only hears frames that were already long; it
 * never asks for a frame. No row is written in a minute with no long frame.
 */

/** The fields of a `PerformanceScriptTiming` this log reads. */
export type LongFrameScript = {
  readonly duration: number;
  readonly invoker?: string;
  readonly invokerType?: string;
  readonly sourceFunctionName?: string;
  readonly sourceURL?: string;
  readonly sourceCharPosition?: number;
};

/** The fields of a `PerformanceLongAnimationFrameTiming` this log reads. */
export type LongFrame = {
  readonly duration: number;
  readonly blockingDuration?: number;
  readonly renderStart?: number;
  readonly styleAndLayoutStart?: number;
  readonly startTime: number;
  readonly scripts?: ReadonlyArray<LongFrameScript>;
};

export type FramePressureRow = {
  readonly frames: number;
  readonly totalMs: number;
  readonly blockingMs: number;
  readonly maxMs: number;
  /** Time in the frames' rendering steps (rAF, style, layout, paint), not in scripts. */
  readonly renderMs: number;
  readonly top: ReadonlyArray<{ readonly script: string; readonly ms: number; readonly n: number }>;
};

export const FRAME_PRESSURE_INTERVAL_MS = 60_000;
export const FRAME_PRESSURE_TOP = 8;

const file = (url: string | undefined): string => {
  if (url === undefined || url.length === 0) return "";
  const clean = url.split(/[?#]/u)[0] ?? url;
  return clean.slice(clean.lastIndexOf("/") + 1);
};

/** `TimerHandler:setInterval scanRows app.js@1234`: what invoked it, the function, where. */
export const scriptKey = (script: LongFrameScript): string => {
  const where = file(script.sourceURL);
  const at = where === "" ? "" : `${where}${script.sourceCharPosition === undefined || script.sourceCharPosition < 0 ? "" : `@${String(script.sourceCharPosition)}`}`;
  return [script.invoker ?? script.invokerType ?? "?", script.sourceFunctionName || "(anonymous)", at]
    .filter((part) => part !== "")
    .join(" ");
};

const round = (ms: number): number => Math.round(ms);

export const framePressureRow = (frames: ReadonlyArray<LongFrame>, top = FRAME_PRESSURE_TOP): FramePressureRow => {
  const byScript = new Map<string, { ms: number; n: number }>();
  let totalMs = 0;
  let blockingMs = 0;
  let maxMs = 0;
  let renderMs = 0;
  for (const frame of frames) {
    totalMs += frame.duration;
    blockingMs += frame.blockingDuration ?? 0;
    maxMs = Math.max(maxMs, frame.duration);
    if (frame.renderStart !== undefined && frame.renderStart > 0) {
      renderMs += Math.max(0, frame.startTime + frame.duration - frame.renderStart);
    }
    for (const script of frame.scripts ?? []) {
      const key = scriptKey(script);
      const seen = byScript.get(key) ?? { ms: 0, n: 0 };
      seen.ms += script.duration;
      seen.n += 1;
      byScript.set(key, seen);
    }
  }
  return {
    frames: frames.length,
    totalMs: round(totalMs),
    blockingMs: round(blockingMs),
    maxMs: round(maxMs),
    renderMs: round(renderMs),
    top: [...byScript.entries()]
      .sort((a, b) => b[1].ms - a[1].ms)
      .slice(0, top)
      .map(([script, seen]) => ({ script, ms: round(seen.ms), n: seen.n })),
  };
};

/** Start the minute rows; returns a stop that writes what is pending. No-op where the API is missing. */
export const startFramePressureLog = (
  write: (message: string) => void = (message) => console.info(message),
  intervalMs = FRAME_PRESSURE_INTERVAL_MS,
): (() => void) => {
  if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame")) {
    return () => undefined;
  }
  let pending: Array<LongFrame> = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) pending.push(entry as unknown as LongFrame);
  });
  observer.observe({ type: "long-animation-frame", buffered: true });
  const flush = (): void => {
    if (pending.length === 0) return;
    const frames = pending;
    pending = [];
    write(`[perf] long-frames ${JSON.stringify(framePressureRow(frames))}`);
  };
  const timer = setInterval(flush, intervalMs);
  return () => {
    clearInterval(timer);
    observer.disconnect();
    flush();
  };
};
