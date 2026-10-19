// @vitest-environment jsdom
/**
 * The auto cache mode's question, in the seat's open terminal view. It shows
 * only for the view's own seat while main lists it, sends the operator's
 * answer, and says main's message when the answer does not go through.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SeatCacheDue, SeatCacheDueAnswerInput, SeatCacheDueAnswerResult } from "../src/shared/seat-cache-due";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bridge = {
  listeners: new Set<(due: ReadonlyArray<SeatCacheDue>) => void>(),
  current: [] as SeatCacheDue[],
  answers: [] as SeatCacheDueAnswerInput[],
  result: { ok: true } as SeatCacheDueAnswerResult,
  list: async (): Promise<SeatCacheDue[]> => bridge.current,
};
vi.mock("../src/renderer/lib/junto-api", () => ({
  getJuntoApi: () => ({
    seatCacheDueList: () => bridge.list(),
    seatCacheDueAnswer: async (input: SeatCacheDueAnswerInput) => {
      bridge.answers.push(input);
      return bridge.result;
    },
    onSeatCacheDue: (listener: (due: ReadonlyArray<SeatCacheDue>) => void) => {
      bridge.listeners.add(listener);
      return () => bridge.listeners.delete(listener);
    },
  }),
}));

const { cacheDueLine, seatCacheDue$, subscribeSeatCacheDue } = await import("../src/renderer/lib/seat-cache-due-state");
const { SeatCacheDuePopup } = await import("../src/renderer/components/terminal/SeatCacheDuePopup");

const NOW = 1_800_000_000_000;
const ask = (seatId: string, windowEndsAt = NOW - 12 * 60_000): SeatCacheDue => ({ canvasName: "factory", seatId, windowEndsAt });
const push = (due: ReadonlyArray<SeatCacheDue>) => act(() => bridge.listeners.forEach((listener) => listener(due)));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: NOW });
  seatCacheDue$.byKey.set({});
  bridge.current = [];
  bridge.answers = [];
  bridge.result = { ok: true };
  bridge.list = async () => bridge.current;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  subscribeSeatCacheDue()();
  vi.useRealTimers();
});

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
};

const render = async (seatId = "seat-1") => {
  act(() => root.render(<SeatCacheDuePopup canvasName="factory" seatId={seatId} />));
  await flush();
};

const popup = () => host.querySelector('[data-testid="seat-cache-due"]');
const press = async (testId: string) => {
  act(() => (host.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).click());
  await flush();
};

describe("the cache question in the seat's view", () => {
  it("says how long ago the cache expired", () => {
    expect(cacheDueLine(NOW - 20_000, NOW)).toBe("Cache expired just now.");
    expect(cacheDueLine(NOW - 12 * 60_000, NOW)).toBe("Cache expired 12m ago.");
    expect(cacheDueLine(NOW - 72 * 60_000, NOW)).toBe("Cache expired 1h 12m ago.");
    expect(cacheDueLine(NOW - 120 * 60_000, NOW)).toBe("Cache expired 2h ago.");
  });

  it("shows for a window that opens on a listed seat, and only for its own seat", async () => {
    bridge.current = [ask("seat-2")];
    await render("seat-1");
    expect(popup()).toBeNull();
    bridge.current = [ask("seat-1")];
    act(() => root.unmount());
    subscribeSeatCacheDue()();
    root = createRoot(host);
    await render("seat-1");
    expect(popup()?.textContent).toContain("Cache expired 12m ago. Start fresh, or keep this session?");
  });

  it("follows main's pushes: shown while listed, gone once it leaves the list", async () => {
    await render();
    expect(popup()).toBeNull();
    push([ask("seat-1")]);
    expect(popup()).not.toBeNull();
    push([]);
    expect(popup()).toBeNull();
  });

  it("does not let the opening read put back a seat a push already removed", async () => {
    let resolveList: (due: SeatCacheDue[]) => void = () => undefined;
    bridge.list = () =>
      new Promise((resolve) => {
        resolveList = resolve;
      });
    await render();
    push([]);
    resolveList([ask("seat-1")]);
    await flush();
    expect(popup()).toBeNull();
  });

  it("sends the answer and shows main's message when it fails", async () => {
    await render();
    push([ask("seat-1")]);
    bridge.result = { ok: false, message: "The seat is working; offboard waits for idle." };
    await press("seat-cache-due-fresh");
    expect(bridge.answers).toEqual([{ canvasName: "factory", seatId: "seat-1", answer: "fresh" }]);
    expect(host.querySelector('[data-testid="seat-cache-due-failure"]')?.textContent).toBe(
      "The seat is working; offboard waits for idle.",
    );
    bridge.result = { ok: true };
    await press("seat-cache-due-keep");
    expect(bridge.answers.at(-1)).toEqual({ canvasName: "factory", seatId: "seat-1", answer: "keep" });
    expect(host.querySelector('[data-testid="seat-cache-due-failure"]')).toBeNull();
  });

  it("reads the line again as time passes", async () => {
    await render();
    push([ask("seat-1")]);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(popup()?.textContent).toContain("Cache expired 13m ago.");
  });
});
