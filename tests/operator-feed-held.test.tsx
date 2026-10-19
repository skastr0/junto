// @vitest-environment jsdom
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentSignal } from "../src/shared/agent-signals";
import { buildOperatorFeed, type FeedRegion, type OperatorFeed as Feed } from "../src/shared/operator-feed";
import { OperatorFeed } from "../src/renderer/components/feed/OperatorFeed";
import { state$ } from "../src/renderer/lib/state";

// The real feed, fed by hand. The live feed is rebuilt as its stores move,
// often with nothing in it changed, so every render here hands the feed a
// fresh copy: nothing may lean on its identity holding still.
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

vi.mock("../src/renderer/lib/operator-feed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/renderer/lib/operator-feed")>()),
  useOperatorFeed: (): Feed => {
    const feed = useSyncExternalStore(live.subscribe, live.read);
    return { ...feed, sections: feed.sections.map((section) => ({ ...section, items: [...section.items] })) };
  },
}));

const CANVAS = "feed-held";
const NOW = 10_000_000;
const regions: Readonly<Record<string, FeedRegion>> = {
  lead: { regionId: "lead", label: "Lead", path: ["Lead"] },
  build: { regionId: "build", label: "Build", path: ["Build"] },
  docs: { regionId: "docs", label: "Docs", path: ["Docs"] },
};

/** Signals by region, oldest first; a region ranks by its oldest. */
const feedOf = (byRegion: Readonly<Record<string, ReadonlyArray<string>>>, minutesAgo: Readonly<Record<string, number>> = {}): Feed => {
  const entries = Object.entries(byRegion).flatMap(([regionId, ids]) => ids.map((id) => [regionId, id] as const));
  const signals: AgentSignal[] = entries.map(([regionId, id], index) => ({
    signalId: id,
    canvasName: CANVAS,
    nodeId: `seat-${regionId}`,
    kind: "feedback",
    text: `${id} is ready`,
    createdAt: NOW - (minutesAgo[id] ?? 100 - index) * 60_000,
    state: "open",
  }));
  return buildOperatorFeed({
    canvasName: CANVAS,
    nowMs: NOW,
    seats: Object.keys(byRegion).map((regionId) => ({
      seat: { nodeId: `seat-${regionId}`, name: regionId, portraitIdentity: regionId },
      region: regions[regionId]!,
    })),
    signals,
  });
};

let root: Root;
let host: HTMLDivElement;
const oldCanvas = state$.canvasName.peek();

const cardOf = (id: string): HTMLElement | null => document.body.querySelector(`[data-item-id='signal:${id}']`);
const order = (): string[] =>
  [...document.body.querySelectorAll<HTMLElement>("[data-testid='operator-feed-card']")].map((card) =>
    `${card.dataset.itemId!.slice("signal:".length)}${card.parentElement!.classList.contains("operator-feed__slot--leaving") ? " leaving" : ""}`,
  );
const regionLabels = (): string[] =>
  [...document.body.querySelectorAll(".operator-feed__region-label")].map((label) => label.textContent ?? "");
const show = async (feed: Feed): Promise<void> => {
  await act(async () => live.set(feed));
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = () => {};
  state$.canvasName.set(CANVAS);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  state$.canvasName.set(oldCanvas);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("an answered card stays the same element, in its place, until its fade is over", async () => {
  live.set(feedOf({ build: ["a", "b", "c"] }));
  await act(async () => root.render(<OperatorFeed />));
  const b = cardOf("b");
  expect(order()).toEqual(["a", "b", "c"]);

  await show(feedOf({ build: ["a", "c"] }));
  expect(cardOf("b")).toBe(b);
  expect(order()).toEqual(["a", "b leaving", "c"]);
  // Fresh feeds while it fades: no render loop, and it holds.
  await show(feedOf({ build: ["a", "c"] }));
  expect(cardOf("b")).toBe(b);

  await act(async () => vi.advanceTimersByTime(300));
  expect(order()).toEqual(["a", "c"]);
});

const pane = (): HTMLElement | null => document.body.querySelector("[data-testid='operator-feed-detail']");

it("the pane shows the first item, and a reply open on an item that leaves goes with it", async () => {
  live.set(feedOf({ build: ["a", "b"] }));
  await act(async () => root.render(<OperatorFeed />));
  expect(pane()?.dataset.itemId).toBe("signal:a");
  // Pills live only in the pane, never on a row in the list.
  expect(cardOf("a")!.querySelector("[data-testid='quick-replies']")).toBeNull();
  expect(pane()!.querySelector("[data-testid='quick-replies']")).not.toBeNull();
  expect(pane()!.querySelector("[data-testid='quiet-notes']")).not.toBeNull();
  await act(async () => pane()!.querySelector<HTMLButtonElement>("[aria-label='Write reply to build']")!.click());
  expect(pane()!.querySelector("textarea")).not.toBeNull();

  await show(feedOf({ build: ["b"] }));
  expect(pane()?.dataset.itemId).toBe("signal:b");
  expect(pane()!.querySelector("textarea")).toBeNull();
});

it("a region whose only card leaves stays where it was while it fades", async () => {
  live.set(feedOf({ lead: ["l"], build: ["a"], docs: ["d"] }));
  await act(async () => root.render(<OperatorFeed />));
  expect(regionLabels()).toEqual(["Lead", "Build", "Docs"]);

  await show(feedOf({ build: ["a"], docs: ["d"] }));
  expect(regionLabels()).toEqual(["Lead", "Build", "Docs"]);
  expect(order()).toEqual(["l leaving", "a", "d"]);

  await act(async () => vi.advanceTimersByTime(300));
  expect(regionLabels()).toEqual(["Build", "Docs"]);
});

it("holds the order on screen through a re-rank, and ranks a new card into it", async () => {
  live.set(feedOf({ build: ["a", "b"], docs: ["d"] }, { a: 90, b: 80, d: 70 }));
  await act(async () => root.render(<OperatorFeed />));
  expect(regionLabels()).toEqual(["Build", "Docs"]);

  // Without a, Docs now ranks first (e is the oldest).
  await show(feedOf({ build: ["b"], docs: ["d", "e"] }, { b: 60, d: 70, e: 95 }));
  await act(async () => vi.advanceTimersByTime(300));
  expect(regionLabels()).toEqual(["Build", "Docs"]);
  expect(order()).toEqual(["b", "e", "d"]);
});
