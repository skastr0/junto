/**
 * The page chip's Working flag: true while a seat drives the page or just
 * did, false once the driver mark's recent window ends (one timer per page),
 * and false for the operator, a held page and a page with no read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asNodeId } from "../src/shared/model";
import { DRIVER_RECENT_MS, initialPageDriving, reducePageDriving } from "../src/shared/page-driver";
import type { BrowserChromeState } from "../src/shared/browser-chrome";
import type { BrowserSessionInfo } from "../src/shared/ipc";
import { initialPageTabs } from "../src/shared/page-tabs";
import { browser$ } from "../src/renderer/lib/browser-state";
import { applyPageDriving, pageDriving$, refreshPageDriving, subscribePageDriving } from "../src/renderer/lib/page-driving";

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
    // The timer lands one past the window's end, so it never wakes early to a zero wait.
    vi.advanceTimersByTime(2);
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

describe("reading a page's driving from main", () => {
  const seatRuns = reducePageDriving(initialPageDriving, { kind: "seat-start", nodeId: seat, at: Date.now() });
  const stateOf = (driving: typeof seatRuns): BrowserChromeState => ({ tabs: initialPageTabs("https://example.com/"), driving });
  const session = (sessionId: string, state: BrowserSessionInfo["state"] = "ready"): BrowserSessionInfo => ({
    ref: REF, sessionId, nodeId: "p1", url: "https://example.com/", profile: "personal", state, attached: true,
  });
  let answers: Array<(state: BrowserChromeState) => void>;
  let pageChanged: ((sessionId: string) => void) | undefined;
  beforeEach(() => {
    answers = [];
    (globalThis as unknown as { window: unknown }).window = {
      junto: {
        browserPageState: () => new Promise((resolve) => answers.push((data) => resolve({ ok: true, data }))),
        onBrowserPageChanged: (listener: (sessionId: string) => void) => {
          pageChanged = listener;
          return () => undefined;
        },
      },
    };
  });
  afterEach(() => {
    browser$.sessionByRef.set({});
    delete (globalThis as { window?: unknown }).window;
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("lets the newer read win when two answer out of order, and a no-session read outranks one in flight", async () => {
    browser$.sessionByRef[REF].set(session("s1"));
    const older = refreshPageDriving(REF);
    const newer = refreshPageDriving(REF);
    answers[1]!(stateOf(initialPageDriving));
    answers[0]!(stateOf(seatRuns));
    await Promise.all([older, newer]);
    expect(pageDriving$.workingByRef[REF].peek()).toBe(false);

    const inFlight = refreshPageDriving(REF);
    browser$.sessionByRef[REF].delete();
    await refreshPageDriving(REF);
    answers[2]!(stateOf(seatRuns));
    await inFlight;
    expect(pageDriving$.workingByRef[REF].peek() ?? false).toBe(false);
  });

  it("replays a page event that came before its session mapped, and forgets the page once it is destroyed", async () => {
    subscribePageDriving();
    pageChanged!("s2");
    expect(answers).toHaveLength(0);
    browser$.sessionByRef[REF].set(session("s2"));
    expect(answers).toHaveLength(1);
    answers[0]!(stateOf(seatRuns));
    await settle();
    expect(pageDriving$.workingByRef[REF].peek()).toBe(true);
    browser$.sessionByRef[REF].set(session("s2", "destroyed"));
    expect(REF in pageDriving$.workingByRef.peek()).toBe(false);
  });
});
