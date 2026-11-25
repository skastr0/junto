// @vitest-environment jsdom
/**
 * A signal that follows another in its thread (part 7), drawn: its card says
 * what it follows and how many the thread holds, and the pane tells the
 * exchange, ending at this signal, with Open thread asking Threads for it.
 */
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Layer, ManagedRuntime } from "effect";
import type { AgentSignal } from "../src/shared/agent-signals";
import { buildOperatorFeed, type OperatorFeed as Feed } from "../src/shared/operator-feed";
import { CompanionWindow } from "../src/contract/window/companion";
import { SignalsWindow } from "../src/contract/window/signals";
import { WindowRuntimeContext } from "../src/window/rpc/runtime";
import { OperatorFeed } from "../src/window/components/feed/OperatorFeed";
import { clearFeedFilters, feedView$ } from "../src/window/lib/operator-feed";
import { agentSignals$ } from "../src/window/lib/agent-signals-state";
import { operatorModal$ } from "../src/window/lib/operator-modal";
import { threadAsked$ } from "../src/window/lib/threads-view";
import { state$ } from "../src/window/lib/state";

const feedRuntime = ManagedRuntime.make(
  Layer.mergeAll(Layer.succeed(SignalsWindow, {} as never), Layer.succeed(CompanionWindow, {} as never)),
);

const live = vi.hoisted(() => {
  let feed: unknown;
  const listeners = new Set<() => void>();
  return {
    set: (next: unknown): void => {
      feed = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read: () => feed,
  };
});

vi.mock("../src/window/lib/operator-feed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/window/lib/operator-feed")>()),
  useOperatorFeed: (): Feed => useSyncExternalStore(live.subscribe, live.read as () => Feed),
}));

// The thread, as the seat's threads read it: a head signal, an answer, a signal, an answer, then three more.
const thread = vi.hoisted(() => ({
  messages: [] as unknown[],
  head: undefined as unknown,
}));
vi.mock("../src/window/lib/seat-threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/window/lib/seat-threads")>()),
  useSeatThreadMessages: () => ({ messages: thread.messages, loaded: true, error: "", headSignal: thread.head }),
  loadOlderMessages: async () => {},
}));

const CANVAS = "feed-follows";
const NOW = 10_000_000;
const REGION = { regionId: "build", label: "Build", path: ["Build"] };

const signal = (n: number, more: Partial<AgentSignal> = {}): AgentSignal => ({
  signalId: `s${String(n)}`,
  canvasName: CANVAS,
  nodeId: "seat-atlas",
  kind: n === 1 ? "escalate" : "blocked",
  text: `Topic ${String(n)} needs your call`,
  createdAt: NOW - 100_000 + n,
  state: "open",
  threadId: "T1",
  ...(n === 1 ? {} : { followsSignalId: `s${String(n - 1)}` }),
  paired: true,
  ...more,
});
const earlier = (n: number, state: "answered" | "dismissed" | "withdrawn"): AgentSignal => signal(n, { state });

const feedOf = (): Feed =>
  buildOperatorFeed({
    canvasName: CANVAS,
    nowMs: NOW,
    seats: [{ seat: { nodeId: "seat-atlas", name: "atlas", portraitIdentity: "atlas" }, region: REGION }],
    signals: [earlier(1, "answered"), earlier(2, "dismissed"), earlier(3, "answered"), signal(4)],
  });

const message = (n: number, state: "answered" | "dismissed" | "withdrawn", crossed = false) => ({
  messageId: `m${String(n)}`,
  author: "atlas",
  mine: false,
  text: `Topic ${String(n)} needs your call`,
  at: NOW - 90_000 + n,
  signal: { signalId: `s${String(n)}`, kind: n === 1 ? "escalate" : "blocked", state, text: `Topic ${String(n)} needs your call`, ...(crossed ? { crossed: true } : {}) },
});
const answerTo = (n: number) => ({
  messageId: `a${String(n)}`,
  author: "you",
  mine: true,
  text: `Yes, go ahead with ${String(n)}\nthen tell me`,
  at: NOW - 80_000 + n,
  answers: { signalId: `s${String(n)}`, kind: "blocked", text: `Topic ${String(n)} needs your call` },
});

let root: Root;
let host: HTMLDivElement;
const oldCanvas = state$.canvasName.peek();
const all = (selector: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(selector)];
const q = (selector: string): HTMLElement | null => document.body.querySelector<HTMLElement>(selector);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }));
  HTMLElement.prototype.scrollIntoView = () => {};
  clearFeedFilters();
  feedView$.order.set("act");
  state$.canvasName.set(CANVAS);
  thread.head = { signalId: "s1", kind: "escalate", state: "answered", text: "Topic 1 needs your call", at: NOW - 95_000 };
  thread.messages = [answerTo(1), message(2, "dismissed"), answerTo(2), message(3, "withdrawn", true), message(4, "answered")];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearFeedFilters();
  threadAsked$.threadId.set(null);
  agentSignals$.set({});
  operatorModal$.open.set(null);
  state$.canvasName.set(oldCanvas);
  vi.unstubAllGlobals();
});

const open = async (): Promise<void> => {
  live.set(feedOf());
  operatorModal$.open.set("feed");
  await act(async () =>
    root.render(
      <WindowRuntimeContext.Provider value={feedRuntime as never}>
        <OperatorFeed />
      </WindowRuntimeContext.Provider>,
    ),
  );
};

it("says on the card what it follows and how many the thread holds", async () => {
  await open();
  const line = q('[data-testid="feed-follows"]')!;
  expect(line.textContent).toContain("Follows:");
  expect(line.textContent).toContain("Topic 3 needs your call");
  expect(line.textContent).toContain("4 in this thread");
});

it("tells the exchange in the pane, folded past four, ending at this signal", async () => {
  await open();
  const rows = all('[data-testid="feed-exchange-signal"], [data-testid="feed-exchange-answer"]');
  // Earlier: s1, You, s2, You, s3 is 5 rows, past four: the last three, then this signal.
  expect(rows.map((row) => row.textContent ?? "")).toHaveLength(4);
  expect(q('[data-testid="feed-exchange-all"]')?.textContent).toBe("Show all 5");
  expect(rows.at(-1)!.dataset.current).toBe("true");
  await act(async () => q('[data-testid="feed-exchange-all"]')!.click());
  const unfolded = all('[data-testid="feed-exchange-signal"], [data-testid="feed-exchange-answer"]');
  expect(unfolded).toHaveLength(6);
  expect(unfolded[0]!.dataset.signalId).toBe("s1");
  expect(unfolded[0]!.textContent).toContain("Answered");
  expect(unfolded[1]!.textContent).toBe("You: Yes, go ahead with 1");
  expect(q('[data-testid="feed-exchange"]')!.textContent).toContain("atlas withdrew this before your answer reached it.");
  expect(q('[data-testid="feed-exchange-all"]')).toBeNull();
});

it("opens Threads on the thread, and the feed comes back on close", async () => {
  await open();
  await act(async () => q('[data-testid="feed-exchange-open"]')!.click());
  expect(threadAsked$.threadId.peek()).toBe("T1");
  expect(operatorModal$.open.peek()).toBe("threads");
});

/** Two cards open: this seat's s4 and another seat's one. */
const twoOpen = (s4: AgentSignal | undefined): Feed =>
  buildOperatorFeed({
    canvasName: CANVAS,
    nowMs: NOW,
    seats: ["atlas", "bravo"].map((seat) => ({ seat: { nodeId: `seat-${seat}`, name: seat, portraitIdentity: seat }, region: REGION })),
    signals: [
      ...(s4 === undefined ? [] : [s4]),
      { signalId: "b1", canvasName: CANVAS, nodeId: "seat-bravo", kind: "feedback", text: "Bravo wants a look", createdAt: NOW - 50_000, state: "open" },
    ],
  });

it("keeps a card the seat withdrew before the answer reached it, in the pane, until the operator moves", async () => {
  const open4 = signal(4);
  live.set(twoOpen(open4));
  operatorModal$.open.set("feed");
  await act(async () =>
    root.render(
      <WindowRuntimeContext.Provider value={feedRuntime as never}>
        <OperatorFeed />
      </WindowRuntimeContext.Provider>,
    ),
  );
  const selected = (): string | undefined => q('[data-testid="operator-feed-card"][aria-current="true"]')?.dataset.itemId;
  expect(selected()).toBe("signal:s4");
  expect(q('[data-testid="feed-crossed"]')).toBeNull();
  // The answer crossed the withdrawal: closed as withdrawn, holding the answer.
  await act(async () => {
    agentSignals$.s4.set({ ...open4, state: "withdrawn", response: { text: "Yes", at: NOW } });
    live.set(twoOpen(undefined));
  });
  // The list handed on; the pane keeps s4 and says why, in the answer area.
  expect(selected()).toBe("signal:b1");
  expect(q('[data-testid="feed-crossed"]')?.textContent).toBe("atlas withdrew this before your answer reached it.");
  expect(q('[data-testid="operator-feed-detail"]')?.dataset.itemId).toBe("signal:s4");
  expect(q(".operator-feed__announce")?.textContent).toBe("atlas withdrew this before your answer reached it.");
  // A key that would answer is only let go of: nothing is sent on the card the pane is not showing.
  const frame = q(".operator-modal__frame")!;
  await act(async () => {
    frame.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
  });
  expect(q('[data-testid="feed-crossed"]')).toBeNull();
  expect(q('[data-testid="operator-feed-detail"]')?.dataset.itemId).toBe("signal:b1");
});

it("says nothing of a card that closed an ordinary way", async () => {
  const open4 = signal(4);
  live.set(twoOpen(open4));
  operatorModal$.open.set("feed");
  await act(async () =>
    root.render(
      <WindowRuntimeContext.Provider value={feedRuntime as never}>
        <OperatorFeed />
      </WindowRuntimeContext.Provider>,
    ),
  );
  await act(async () => {
    agentSignals$.s4.set({ ...open4, state: "answered", response: { text: "Yes", at: NOW } });
    live.set(twoOpen(undefined));
  });
  expect(q('[data-testid="feed-crossed"]')).toBeNull();
  expect(q('[data-testid="operator-feed-detail"]')?.dataset.itemId).toBe("signal:b1");
});
