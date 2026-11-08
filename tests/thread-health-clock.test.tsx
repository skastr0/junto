// @vitest-environment jsdom
/**
 * The 15 s health clock re-renders a seat card only when the card's health
 * mark changes. Every card re-rendering on every tick was a 55 ms main-thread
 * task every 15 s on the operator's board (0.11.10 trace).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useThreadHealthMark } from "../src/window/lib/thread-health";
import { applySeatAwarenessEvent, resetSeatAwareness } from "../src/window/lib/seat-awareness";
import type { SeatAwarenessAssessment } from "../src/shared/seat-awareness-contract";

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);
const TICK_MS = 15_000;

let host: HTMLDivElement;
let root: Root;
let renders = 0;
let labels: Array<string | undefined> = [];

function Card() {
  renders += 1;
  const mark = useThreadHealthMark("bind-1", undefined);
  labels.push(mark.label);
  return <span>{mark.label}</span>;
}

/** A going-well reading observed `observedAt`, against window digest d1. */
const seed = (observedAt: number, liveDigest: string): void => {
  const assessment: SeatAwarenessAssessment = {
    bindingId: "bind-1",
    assessmentId: "as-1",
    availability: "current",
    observedAt,
    activity: null,
    concerns: [],
    absences: [],
    unansweredConcerns: [],
    evidence: { digest: "d1", capturedAt: observedAt, lines: [] },
    selectedLineId: null,
    unavailableReason: null,
    health: {
      bindingId: "bind-1",
      value: "going_well",
      confidence: 0.9,
      observedAt,
      provenance: { source: "jev", assessmentId: "as-1", questionId: "health.going_well", packVersion: "awareness-pack/2" },
      signals: [{ value: "going_well", probability: 0.9, questionId: "health.going_well" }],
    },
  } as SeatAwarenessAssessment;
  applySeatAwarenessEvent({ kind: "assessment", assessment, windowDigest: liveDigest, at: 1 });
};

const tick = async (times: number): Promise<void> => {
  for (let index = 0; index < times; index += 1) await act(async () => vi.advanceTimersByTime(TICK_MS));
};

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  renders = 0;
  labels = [];
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  resetSeatAwareness();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("does not re-render a card whose reading stays current as the clock ticks", async () => {
  // The screen is still the one observed, so the reading is current at any age.
  seed(T0, "d1");
  await act(async () => root.render(<Card />));
  const mounted = renders;
  await tick(8);
  expect(renders).toBe(mounted);
  expect(host.textContent).toBe("AI reads: going well");
});

it("re-renders a stale card only when its observed age changes, and draws the new age", async () => {
  // Observed 59.5 minutes ago against a window the seat has since left: stale, aged in whole minutes.
  seed(T0 - 59 * 60_000 - 30_000, "d2");
  await act(async () => root.render(<Card />));
  const mounted = renders;
  expect(host.textContent).toBe("AI reads: going well, last observed 59m ago");
  // 15 s on the age still reads 59m: nothing redraws.
  await tick(1);
  expect(renders).toBe(mounted);
  // 30 s on it reads 1h: one redraw, with the new age.
  await tick(1);
  expect(renders).toBe(mounted + 1);
  expect(host.textContent).toBe("AI reads: going well, last observed 1h ago");
  // Another 90 s of ticks still read 1h: nothing more.
  await tick(6);
  expect(renders).toBe(mounted + 1);

  // A fresh reading arrives: the card redraws once, with the new mark.
  seed(T0 + 8 * TICK_MS, "d1");
  await act(async () => {});
  expect(host.textContent).toBe("AI reads: going well");
  expect(renders).toBe(mounted + 2);
  expect(labels.at(-1)).toBe("AI reads: going well");
});
