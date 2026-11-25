// @vitest-environment jsdom
/**
 * The needs-you feed in the order to act, drawn (part 8): ten raised in order
 * take three rows, the next is on top and selected after each answer, ten
 * times; a waiting card says what it depends on and goes there; the fold
 * unfolds; Ready keeps what can be acted on; W goes to what the selected
 * card waits on; a filter hiding it is cleared and said.
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
import { state$ } from "../src/window/lib/state";

const feedRuntime = ManagedRuntime.make(
  Layer.mergeAll(Layer.succeed(SignalsWindow, {} as never), Layer.succeed(CompanionWindow, {} as never)),
);

const live = vi.hoisted(() => {
  let feed: Feed | undefined;
  const listeners = new Set<() => void>();
  return {
    set: (next: Feed): void => {
      feed = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read: (): Feed => feed!,
  };
});

vi.mock("../src/window/lib/quick-reply-rules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/window/lib/quick-reply-rules")>()),
  sendSignalAnswer: async () => ({ ok: true }),
}));

vi.mock("../src/window/lib/operator-feed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/window/lib/operator-feed")>()),
  useOperatorFeed: (): Feed => useSyncExternalStore(live.subscribe, live.read),
}));

const CANVAS = "feed-order";
const NOW = 10_000_000;
const REGION = { regionId: "build", label: "Build", path: ["Build"] };

/** Ten raised by one seat, each after the one before, and one from another seat in no order. */
const signalsOf = (open: number, total = 10): AgentSignal[] => [
  ...Array.from({ length: total }, (_, n): AgentSignal => ({
    signalId: `s${String(n + 1)}`,
    canvasName: CANVAS,
    nodeId: "seat-atlas",
    kind: "escalate",
    text: `Topic ${String(n + 1)} needs your call`,
    createdAt: NOW - 100_000 + n,
    state: n < total - open ? "answered" : "open",
    ...(n === 0 ? {} : { dependsOn: [`s${String(n)}`] }),
  })),
  {
    signalId: "other",
    canvasName: CANVAS,
    nodeId: "seat-bravo",
    kind: "feedback",
    text: "Bravo wants a look",
    createdAt: NOW - 50_000,
    state: "open",
  },
];

const feedOf = (open: number, total = 10): Feed =>
  buildOperatorFeed({
    canvasName: CANVAS,
    nowMs: NOW,
    seats: ["atlas", "bravo"].map((seat) => ({ seat: { nodeId: `seat-${seat}`, name: seat, portraitIdentity: seat }, region: REGION })),
    signals: signalsOf(open, total),
  });

let root: Root;
let host: HTMLDivElement;
const oldCanvas = state$.canvasName.peek();

const all = (selector: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(selector)];
const q = (selector: string): HTMLElement | null => document.body.querySelector<HTMLElement>(selector);
/** The list as drawn: each card by its signal, each fold by what it says. */
const rows = (): string[] =>
  all('[data-testid="operator-feed-card"], [data-testid="feed-chain-fold"]').map((row) =>
    row.dataset.testid === "feed-chain-fold" ? row.textContent! : row.dataset.itemId!.replace(/^signal:/u, ""),
  );
const selectedId = (): string | undefined =>
  q('[data-testid="operator-feed-card"][aria-current="true"]')?.dataset.itemId?.replace(/^signal:/u, "");
const press = async (element: Element | null): Promise<void> => {
  await act(async () => (element as HTMLElement).click());
};
const key = async (name: string): Promise<void> => {
  await act(async () => {
    q(".operator-modal__frame")!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
};
const open = async (feed: Feed): Promise<void> => {
  live.set(feed);
  await act(async () =>
    root.render(
      <WindowRuntimeContext.Provider value={feedRuntime as never}>
        <OperatorFeed />
      </WindowRuntimeContext.Provider>,
    ),
  );
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Reduced motion: an answered card leaves at once instead of fading.
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }));
  HTMLElement.prototype.scrollIntoView = () => {};
  clearFeedFilters();
  feedView$.order.set("act");
  state$.canvasName.set(CANVAS);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearFeedFilters();
  state$.canvasName.set(oldCanvas);
  vi.unstubAllGlobals();
});

it("opens in the order to act, ten raised in order as three rows, the first selected", async () => {
  await open(feedOf(10));
  expect(rows()).toEqual(["s1", "s2", "8 more in this order", "other"]);
  expect(selectedId()).toBe("s1");
  const [first, second] = all('[data-testid="operator-feed-card"]');
  expect(first!.querySelector('[data-testid="feed-chain-place"]')?.textContent).toBe("1 of 10");
  expect(second!.querySelector('[data-testid="feed-chain-place"]')?.textContent).toBe("2 of 10");
  expect(second!.dataset.waiting).toBe("true");
  expect(second!.querySelector('[data-testid="feed-depends-on"]')?.textContent).toContain("Depends on:Topic 1 needs your call");
  expect(first!.querySelector('[data-testid="feed-depends-on"]')).toBeNull();
});

it("puts the next on top and selected after each answer, ten times, no scrolling", async () => {
  await open(feedOf(10));
  for (let left = 10; left >= 1; left -= 1) {
    const next = `s${String(11 - left)}`;
    expect(rows()[0]).toBe(next);
    expect(selectedId()).toBe(next);
    // Answered: it closes, and the one after it is ready.
    await act(async () => live.set(feedOf(left - 1)));
  }
  expect(rows()).toEqual(["other"]);
});

it("goes from a waiting card to what it depends on, by its link, the band and W", async () => {
  await open(feedOf(10));
  await press(all('[data-testid="operator-feed-card"]')[1]!);
  expect(selectedId()).toBe("s2");
  // The pane of a waiting signal says what it depends on, framed.
  expect(q('[data-testid="feed-depends-band"]')?.textContent).toContain("Topic 1 needs your call");
  expect(q('[data-testid="feed-depends-row"]')?.textContent).toContain("1 of 10");
  await key("w");
  expect(selectedId()).toBe("s1");
  // On a ready card W does nothing.
  await key("w");
  expect(selectedId()).toBe("s1");
  await press(all('[data-testid="operator-feed-card"]')[1]!);
  await press(q('[data-testid="feed-depends-link"]'));
  expect(selectedId()).toBe("s1");
});

it("draws the W key only on the selected waiting card", async () => {
  await open(feedOf(10));
  await press(all('[data-testid="operator-feed-card"]')[1]!);
  expect(selectedId()).toBe("s2");
  await press(q('[data-testid="feed-chain-fold"]'));
  expect(selectedId()).toBe("s3");
  const waiting = all('[data-testid="operator-feed-card"]').filter((card) => card.dataset.waiting === "true");
  expect(waiting.length).toBeGreaterThan(2);
  const hinted = waiting.filter((card) => card.querySelector(".operator-feed__depends-key") !== null);
  expect(hinted.map((card) => card.dataset.itemId!.replace(/^signal:/u, ""))).toEqual([selectedId()]);
  // The link stays on every waiting card.
  expect(waiting.every((card) => card.querySelector('[data-testid="feed-depends-link"]') !== null)).toBe(true);
});

it("keeps the keyboard in the feed after a link, and says where it went and what a fold showed", async () => {
  await open(feedOf(10));
  const frame = q(".operator-modal__frame")!;
  await press(all('[data-testid="operator-feed-card"]')[1]!);
  const link = q('[data-testid="feed-depends-link"]') as HTMLElement;
  link.focus();
  await press(link);
  expect(selectedId()).toBe("s1");
  expect(document.activeElement).toBe(frame);
  expect(q(".operator-feed__announce")?.textContent).toBe("Went to: Topic 1 needs your call, 1 of 10");
  await press(q('[data-testid="feed-chain-fold"]'));
  expect(q(".operator-feed__announce")?.textContent).toBe("8 more shown");
});

it("names a card with whether it waits and its place, a fold with its chain, and Ready apart from the kinds", async () => {
  await open(feedOf(10));
  const [first, second] = all('[data-testid="operator-feed-card"]');
  const nameOf = (card: Element): string =>
    (card.getAttribute("aria-labelledby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
  expect(nameOf(first!)).toContain("1 of 10");
  expect(nameOf(first!)).not.toContain("Not ready, depends on another signal");
  // A ready card keeps its kind; one that depends on another is not waiting on the operator yet, so it does not say so.
  expect(nameOf(first!)).toContain("waiting on you");
  expect(nameOf(second!)).not.toContain("waiting on you");
  expect(nameOf(second!)).toContain("Not ready, depends on another signal, 2 of 10");
  expect(q('[data-testid="feed-chain-fold"]')?.getAttribute("aria-label")).toBe(
    "Show 8 more signals in this order, after: Topic 2 needs your call",
  );
  expect(q('[data-testid="feed-ready-chip"]')?.closest('[role="group"]')?.getAttribute("aria-label")).toBe("Show only");
  await press(second!);
  expect(q('[data-testid="feed-depends-link"]')?.getAttribute("aria-keyshortcuts")).toBeTruthy();
});

it("says the card a key steps onto in the live line", async () => {
  await open(feedOf(10));
  await key("j");
  expect(selectedId()).toBe("s2");
  expect(q(".operator-feed__announce")?.textContent).toBe(
    "atlas, not ready, depends on another signal, 2 of 10: Topic 2 needs your call",
  );
});

it("says an answer and the card that takes its place, or that nothing else waits", async () => {
  await open(feedOf(2));
  await key("1");
  await act(async () => live.set(feedOf(1)));
  expect(q(".operator-feed__announce")?.textContent).toBe("Answered. Next: atlas, waiting on you: Topic 10 needs your call");
  await key("1");
  await act(async () => live.set(feedOf(0)));
  expect(q(".operator-feed__announce")?.textContent).toBe("Answered. Next: bravo, ready for review: Bravo wants a look");
});

it("does not say the feed is clear when a filter hides what still waits", async () => {
  await open(feedOf(1));
  await act(async () => feedView$.seat.set("seat-atlas"));
  expect(rows()).toEqual(["s10"]);
  await key("1");
  await act(async () => live.set(feedOf(0)));
  expect(q(".operator-feed__announce")?.textContent).toBe("Answered. Nothing else shown with these filters");
});

it("draws a batch of 50 raised in order as three rows, and walks it one by one with the next always on top", async () => {
  await open(feedOf(50, 50));
  expect(rows()).toEqual(["s1", "s2", "48 more in this order", "other"]);
  expect(all('[data-testid="operator-feed-card"]')[0]!.querySelector('[data-testid="feed-chain-place"]')?.textContent).toBe("1 of 50");
  for (let left = 50; left >= 1; left -= 1) {
    const next = `s${String(51 - left)}`;
    expect(rows()[0]).toBe(next);
    expect(selectedId()).toBe(next);
    await act(async () => live.set(feedOf(left - 1, 50)));
  }
  expect(rows()).toEqual(["other"]);
});

it("unfolds the rest of a chain in place", async () => {
  await open(feedOf(10));
  await press(q('[data-testid="feed-chain-fold"]'));
  expect(rows()).toEqual(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "other"]);
  expect(selectedId()).toBe("s3");
});

it("keeps only what can be acted on under Ready, and clears a filter that hides where a link goes", async () => {
  await open(feedOf(10));
  const ready = q('[data-testid="feed-ready-chip"]')!;
  expect(ready.getAttribute("aria-label")).toBe("Ready, 2");
  await press(ready);
  expect(rows()).toEqual(["s1", "other"]);
  await press(ready);
  // Narrowed to the waiting card's words: its link's target is hidden, so the filters clear to show it.
  await act(async () => feedView$.query.set("Topic 2"));
  expect(rows()).toEqual(["s2"]);
  await press(q('[data-testid="feed-depends-link"]'));
  expect(feedView$.query.peek()).toBe("");
  expect(selectedId()).toBe("s1");
  expect(q(".operator-feed__announce")?.textContent).toBe("Filters cleared to show it. Went to: Topic 1 needs your call, 1 of 10");
});

it("is Most urgent first, a chain kept in order, in the order menu's other choices", async () => {
  feedView$.order.set("newest");
  await open(feedOf(10));
  const shown = rows();
  expect(shown.filter((id) => id.startsWith("s"))).toEqual(Array.from({ length: 10 }, (_, n) => `s${String(n + 1)}`));
  expect(shown).not.toContain("8 more in this order");
});
