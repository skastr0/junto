/**
 * The page chip's Working flag: true while a seat drives the page or just
 * did, false once the driver mark's recent window ends (one timer per page),
 * and false for the operator, a held page and a page with no read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asNodeId } from "../src/shared/model";
import { DRIVER_RECENT_MS, initialPageDriving, reducePageDriving } from "../src/shared/page-driver";
import { applyPageDriving, pageDriving$ } from "../src/renderer/lib/page-driving";

const REF = "junto://canvas/work?node=p1";
const seat = asNodeId("scout");
const working = () => pageDriving$.workingByRef[REF].peek();

describe("the page chip's Working flag", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => {
    applyPageDriving(REF, undefined);
    vi.useRealTimers();
  });

  it("is on while a seat runs, stays on through the recent window after, then goes off on its own", () => {
    const running = reducePageDriving(initialPageDriving, { kind: "seat-start", nodeId: seat, at: 10_000 });
    applyPageDriving(REF, running);
    expect(working()).toBe(true);
    const done = reducePageDriving(running, { kind: "seat-end", nodeId: seat, at: 10_500 });
    vi.setSystemTime(10_500);
    applyPageDriving(REF, done);
    expect(working()).toBe(true);
    vi.advanceTimersByTime(DRIVER_RECENT_MS - 1);
    expect(working()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(working()).toBe(false);
  });

  it("is off for the operator's own driving, a page they hold, and no read", () => {
    const running = reducePageDriving(initialPageDriving, { kind: "seat-start", nodeId: seat, at: 10_000 });
    applyPageDriving(REF, running);
    applyPageDriving(REF, reducePageDriving(running, { kind: "take-over", at: 10_100 }));
    expect(working()).toBe(false);
    applyPageDriving(REF, reducePageDriving(initialPageDriving, { kind: "operator-act", at: 10_200 }));
    expect(working()).toBe(false);
    applyPageDriving(REF, running);
    applyPageDriving(REF, undefined);
    expect(working()).toBe(false);
  });

  it("a newer driving cancels the old window's timer", () => {
    const done = reducePageDriving(
      reducePageDriving(initialPageDriving, { kind: "seat-start", nodeId: seat, at: 10_000 }),
      { kind: "seat-end", nodeId: seat, at: 10_000 },
    );
    applyPageDriving(REF, done);
    const again = reducePageDriving(done, { kind: "seat-start", nodeId: seat, at: 15_000 });
    vi.setSystemTime(15_000);
    applyPageDriving(REF, again);
    vi.advanceTimersByTime(DRIVER_RECENT_MS * 2);
    expect(working()).toBe(true);
  });
});
