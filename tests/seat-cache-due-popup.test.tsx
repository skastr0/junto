// @vitest-environment jsdom
/**
 * The auto cache mode's question, in the seat's open terminal view. It shows
 * only for the view's own seat while the core lists it, sends the operator's
 * answer, and says the core's message when the answer does not go through.
 * The window's service follows a stand-in for the group's client.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SeatCacheDueWindow } from "../src/contract/window/seat-cache-due";
import type { SeatCacheDue, SeatCacheDueAnswerResult } from "../src/window/lib/seat-cache-due-state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type AnswerInput = { readonly canvasName: string; readonly seatId: string; readonly question: string; readonly answer: string };

const core = {
  answers: [] as AnswerInput[],
  result: { ok: true } as SeatCacheDueAnswerResult,
};

const { cacheDueLine, SeatCacheDueState } = await import("../src/window/lib/seat-cache-due-state");
const { WindowRuntimeContext } = await import("../src/window/rpc/runtime");
const { SeatCacheDuePopup } = await import("../src/window/components/terminal/SeatCacheDuePopup");

const NOW = 1_800_000_000_000;
const ask = (seatId: string, windowEndsAt = NOW - 12 * 60_000): SeatCacheDue =>
  ({ canvasName: "factory", seatId, question: `q-${seatId}`.padEnd(22, "0"), windowEndsAt });

let host: HTMLDivElement;
let root: Root;
let lists: Queue.Queue<ReadonlyArray<SeatCacheDue>>;
let runtime: ReturnType<typeof runtimeOver>;

/** The window's service over a client whose follow sends what the test pushes. */
const runtimeOver = (opening: ReadonlyArray<SeatCacheDue>) => {
  lists = Effect.runSync(Queue.unbounded<ReadonlyArray<SeatCacheDue>>());
  Queue.offerUnsafe(lists, opening);
  const client = {
    SeatCacheDueFollow: () => Stream.fromQueue(lists),
    SeatCacheDueAnswer: ({ input }: { readonly input: AnswerInput }) =>
      Effect.sync(() => {
        core.answers.push(input);
        return core.result;
      }),
  };
  return ManagedRuntime.make(SeatCacheDueState.layer.pipe(Layer.provide(Layer.succeed(SeatCacheDueWindow, client as never))));
};
const push = async (due: ReadonlyArray<SeatCacheDue>) => {
  Queue.offerUnsafe(lists, due);
  await flush();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: NOW });
  core.answers = [];
  core.result = { ok: true };
  runtime = runtimeOver([]);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  act(() => root.unmount());
  host.remove();
  await runtime.dispose();
  vi.useRealTimers();
});

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
};

const render = async (seatId = "seat-1") => {
  act(() =>
    root.render(
      <WindowRuntimeContext.Provider value={runtime as never}>
        <SeatCacheDuePopup canvasName="factory" seatId={seatId} />
      </WindowRuntimeContext.Provider>,
    ),
  );
  await flush();
};

const popup = () => host.querySelector('[data-testid="seat-cache-due"]');
const press = async (testId: string, within: ParentNode = host) => {
  act(() => (within.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).click());
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
    await runtime.dispose();
    runtime = runtimeOver([ask("seat-2")]);
    await render("seat-1");
    expect(popup()).toBeNull();
    act(() => root.unmount());
    await runtime.dispose();
    runtime = runtimeOver([ask("seat-1")]);
    root = createRoot(host);
    await render("seat-1");
    expect(popup()?.textContent).toBe("Cache expired 12m ago.Start freshKeep this session");
  });

  it("follows the core's list: shown while listed, gone once it leaves the list", async () => {
    await render();
    expect(popup()).toBeNull();
    await push([ask("seat-1")]);
    expect(popup()).not.toBeNull();
    await push([]);
    expect(popup()).toBeNull();
  });

  it("sends the answer and shows the core's message when it fails", async () => {
    await render();
    await push([ask("seat-1")]);
    core.result = { ok: false, message: "The seat is working; offboard waits for idle." };
    await press("seat-cache-due-fresh");
    expect(core.answers).toEqual([{ canvasName: "factory", seatId: "seat-1", question: ask("seat-1").question, answer: "fresh" }]);
    expect(host.querySelector('[data-testid="seat-cache-due-failure"]')?.textContent).toBe(
      "The seat is working; offboard waits for idle.",
    );
    core.result = { ok: true };
    await press("seat-cache-due-keep");
    expect(core.answers.at(-1)).toEqual({ canvasName: "factory", seatId: "seat-1", question: ask("seat-1").question, answer: "keep" });
    expect(host.querySelector('[data-testid="seat-cache-due-failure"]')).toBeNull();
  });

  it("hears a press on a view adopted outside React's root, as a grid cell is", async () => {
    await render();
    await push([ask("seat-1")]);
    const elsewhere = document.createElement("div");
    document.body.appendChild(elsewhere);
    const shown = popup()!;
    elsewhere.appendChild(shown);
    await press("seat-cache-due-keep", elsewhere);
    expect(core.answers).toEqual([{ canvasName: "factory", seatId: "seat-1", question: ask("seat-1").question, answer: "keep" }]);
    // Back where React left it, so it can unmount it.
    host.appendChild(shown);
    elsewhere.remove();
  });

  it("says the tokens a continue re-reads when there is an estimate, and nothing when there is none", async () => {
    await render();
    await push([{ ...ask("seat-1"), tokens: 251_000 }]);
    expect(popup()?.textContent).toBe(
      "Cache expired 12m ago. Continuing re-reads about 251k tokens.Start freshKeep this session",
    );
    await push([ask("seat-1")]);
    expect(popup()?.textContent).toBe("Cache expired 12m ago.Start freshKeep this session");
  });

  it("reads the line again as time passes", async () => {
    await render();
    await push([ask("seat-1")]);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(popup()?.textContent).toContain("Cache expired 13m ago.");
  });
});
