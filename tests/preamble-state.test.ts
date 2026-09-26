import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPreambles,
  dismissPreamble,
  preambleByNodeId$,
  showPreamble,
} from "../src/renderer/lib/preamble-state";
import type { PreambleEvent } from "../src/shared/preamble";
import { FEED_TUNING } from "../src/renderer/lib/preamble-feed";

const event = (overrides: Partial<PreambleEvent> = {}): PreambleEvent => ({
  preambleId: "preamble-1",
  canvasName: "work",
  nodeId: "agent",
  text: "Inspecting the task.",
  expiresAt: Date.now() + 30_000,
  ...overrides,
});

describe("preamble renderer state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearPreambles();
  });

  afterEach(() => {
    clearPreambles();
    vi.useRealTimers();
  });

  it("shows a preamble and expires it at the server deadline", () => {
    showPreamble(event());
    expect(preambleByNodeId$.agent.peek()?.current.text).toBe("Inspecting the task.");

    vi.advanceTimersByTime(29_999);
    expect(preambleByNodeId$.agent.peek()).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(preambleByNodeId$.agent.peek()).toBeUndefined();
  });

  it("dismisses only the active preamble when ids race", () => {
    showPreamble(event());
    // The seat's next words wait out the first note's dwell.
    vi.advanceTimersByTime(FEED_TUNING.dwellMs);
    showPreamble(event({ preambleId: "preamble-2", text: "Still checking." }));

    dismissPreamble("agent", "preamble-1");
    expect(preambleByNodeId$.agent.peek()?.current.id).toBe("preamble-2");
    dismissPreamble("agent", "preamble-2");
    expect(preambleByNodeId$.agent.peek()).toBeUndefined();
  });
});
