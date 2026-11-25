// @vitest-environment jsdom
/**
 * A burst of seat reports reaches every reader.
 *
 * Main sends one message per seat report, and a board reports in bursts: a
 * pause, a broadcast, a link coming back. Each message is its own task, and
 * applied on arrival each report was its own round of notifications and its
 * own React commit, back to back, with React's scheduler queued behind every
 * message. React counts a commit that leaves an update pending as a nested
 * update and refuses the 51st in a row ("Maximum update depth exceeded"), so
 * one component that set state from an effect on each report made a later
 * report throw inside the store's notification. The store library stops
 * telling readers at the first one that throws, so whoever came after it
 * never heard that report: the canvas feed among them, and the seat's card
 * kept its old state.
 *
 * These tests drive the real store through its IPC listener, one task per
 * message, queued together as Electron queues a burst.
 *
 * The fix they lock is dc81c9552, which landed this file with it.
 */
import { useEffect, useState } from "react";
import { observe } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import {
  agentSeat$,
  applyAgentSeatStateEvent,
  resetAgentSeatState,
  subscribeAgentSeatState,
} from "../src/window/lib/agent-seat-state";

// React schedules as it does in the app: a store change in the microtask of
// its task, everything else on its scheduler.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const seatId = (index: number): string => `seat-${String(index)}`;

const report = (
  index: number,
  state: AgentSeatStateEvent["state"],
  at: number,
): AgentSeatStateEvent => ({
  bindingId: seatId(index),
  epoch: "e1",
  state,
  reason: state,
  confidence: "high",
  at,
});

/** Every task queued before this one has run. */
const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await turn();
};

/** The store's IPC listener, taken from a preload that sends nothing by itself. */
const subscribe = (): { readonly send: (raw: unknown) => void; readonly stop: () => void } => {
  let listener: ((raw: unknown) => void) | undefined;
  (window as unknown as { junto: unknown }).junto = {
    onAgentSeatStateChanged: (next: (raw: unknown) => void) => {
      listener = next;
      return () => undefined;
    },
  };
  const stop = subscribeAgentSeatState();
  return { send: (raw) => listener?.(raw), stop };
};

/**
 * Deliver each report as its own task, all queued before the first runs: the
 * burst Electron hands the window. Answers what the listener threw.
 */
const deliver = (send: (raw: unknown) => void, reports: ReadonlyArray<AgentSeatStateEvent>): Promise<unknown[]> =>
  new Promise((resolve) => {
    const thrown: unknown[] = [];
    reports.forEach((event, index) => {
      setImmediate(() => {
        try {
          send(event);
        } catch (error) {
          thrown.push(error);
        }
        if (index === reports.length - 1) resolve(thrown);
      });
    });
  });

/** What any component that keeps a seat fact in React state does: set it from an effect. */
function Mirror() {
  const rev = use$(agentSeat$.rev);
  const [seen, setSeen] = useState(0);
  useEffect(() => {
    setSeen(rev);
  }, [rev]);
  return <output>{seen}</output>;
}

describe("a burst of seat reports", () => {
  let container: HTMLDivElement;
  let root: Root | undefined;
  let stops: Array<() => void> = [];

  beforeEach(() => {
    resetAgentSeatState();
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(async () => {
    for (const stop of stops) stop();
    stops = [];
    root?.unmount();
    root = undefined;
    await settle();
    container.remove();
    resetAgentSeatState();
    delete (window as unknown as { junto?: unknown }).junto;
  });

  it("throws at no report, and a reader behind a component that sets state from an effect hears every seat", async () => {
    const seats = 120;
    root = createRoot(container);
    root.render(<Mirror />);
    await settle();
    // Told after the component, as the canvas feed is told after the top bar.
    let board = new Map<string, string | undefined>();
    stops.push(
      observe(() => {
        agentSeat$.rev.get();
        const next = new Map<string, string | undefined>();
        for (let i = 0; i < seats; i += 1) next.set(seatId(i), agentSeat$.byBindingId[seatId(i)].peek()?.state);
        board = next;
      }),
    );
    const { send, stop } = subscribe();
    stops.push(stop);

    const thrown = await deliver(
      send,
      Array.from({ length: seats }, (_, i) => report(i, "working", 10 + i)),
    );
    await settle();

    expect(thrown.map((error) => (error instanceof Error ? error.message : String(error)))).toEqual([]);
    expect([...board.values()].filter((state) => state !== "working")).toEqual([]);
    expect(container.textContent).toBe(String(agentSeat$.rev.peek()));
  });

  it("wakes a reader once for reports that arrive together", async () => {
    let runs = 0;
    stops.push(
      observe(() => {
        agentSeat$.rev.get();
        runs += 1;
      }),
    );
    const { send, stop } = subscribe();
    stops.push(stop);
    const before = runs;

    const thrown = await deliver(send, [report(0, "working", 10), report(1, "working", 11), report(2, "working", 12)]);
    await settle();

    expect(thrown).toEqual([]);
    expect(agentSeat$.byBindingId[seatId(2)].peek()?.state).toBe("working");
    expect(runs - before).toBe(1);
  });

  it("drops a report still waiting when the store is reset", async () => {
    const { send } = subscribe();
    send(report(0, "working", 10));
    resetAgentSeatState();
    await settle();

    expect(agentSeat$.byBindingId[seatId(0)].peek()).toBeUndefined();
    expect(agentSeat$.rev.peek()).toBe(0);
  });
});

describe("one seat report", () => {
  beforeEach(() => {
    resetAgentSeatState();
  });

  afterEach(() => {
    resetAgentSeatState();
  });

  it("is written whole before any reader is told: a finished turn arrives with its needsLook", () => {
    applyAgentSeatStateEvent(report(0, "working", 10));
    const seen: Array<readonly [string | undefined, boolean, number | undefined]> = [];
    const stop = observe(() => {
      const event = agentSeat$.byBindingId[seatId(0)].get();
      seen.push([
        event?.state,
        agentSeat$.needsLookByBindingId[seatId(0)].peek() === true,
        agentSeat$.doneAtByBindingId[seatId(0)].peek(),
      ]);
    });
    seen.length = 0;

    applyAgentSeatStateEvent(report(0, "idle", 20));
    stop();

    expect(seen).toEqual([["idle", true, 20]]);
  });
});
