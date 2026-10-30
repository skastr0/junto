// @vitest-environment jsdom
/**
 * The needs feed's narrowing on the desktop (0.11.4): a search field whose
 * placeholder is "Search needs", a chip per kind saying the one name every
 * surface gives it, a chip per seat by its name, and Clear. Each chip toggles
 * its own axis, so clearing the search leaves the chips on.
 */
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentSignal, AgentSignalKind } from "../src/shared/agent-signals";
import { buildOperatorFeed, feedItemRank, OPERATOR_FEED_VERSION, type FeedItem, type FeedRegion, type OperatorFeed as Feed } from "../src/shared/operator-feed";
import { OperatorFeed } from "../src/renderer/components/feed/OperatorFeed";
import { clearFeedFilters, feedView$ } from "../src/renderer/lib/operator-feed";
import { state$ } from "../src/renderer/lib/state";

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

const CANVAS = "feed-filters";
const NOW = 10_000_000;

/** One signal per entry, each an entry on a seat, so seat chips have something to say. */
const REGION_OF: Readonly<Record<string, FeedRegion>> = {
  Build: { regionId: "build", label: "Build", path: ["Build"] },
  Design: { regionId: "design", label: "Design", path: ["Design"], color: "3" },
};

const feedOf = (
  specs: ReadonlyArray<{
    readonly id: string;
    readonly kind: AgentSignalKind;
    readonly seat: string;
    readonly text: string;
    /** The seat's region; Build unless the entry says otherwise. */
    readonly region?: keyof typeof REGION_OF;
  }>,
): Feed => {
  const seats = [...new Map(specs.map((spec) => [spec.seat, spec.region ?? "Build"] as const)).entries()].map(
    ([seat, region]) => ({ seat, region }),
  );
  const signals: AgentSignal[] = specs.map((spec) => ({
    signalId: spec.id,
    canvasName: CANVAS,
    nodeId: `seat-${spec.seat}`,
    kind: spec.kind,
    text: spec.text,
    createdAt: NOW - 60_000,
    state: "open",
  }));
  return buildOperatorFeed({
    canvasName: CANVAS,
    nowMs: NOW,
    seats: seats.map(({ seat, region }) => ({
      seat: { nodeId: `seat-${seat}`, name: seat, portraitIdentity: seat },
      region: REGION_OF[region]!,
    })),
    signals,
  });
};

/**
 * A feed holding an AI reading beside a need: the reading is listed, not
 * counted, but the kind chips can narrow to it, so the narrowed pair must count
 * rows or it says nothing matches while the card is on screen.
 */
const WITH_READING: Feed = (() => {
  const need: FeedItem = {
    itemId: "signal:a",
    kind: "escalate",
    urgency: feedItemRank("escalate"),
    canvasName: CANVAS,
    seat: { nodeId: "seat-atlas", name: "atlas", portraitIdentity: "seat-atlas" },
    region: { regionId: "build", label: "Build", path: ["Build"] },
    text: "Ana asks about the rates",
    since: NOW - 120_000,
  };
  const reading: FeedItem = {
    itemId: "health:seat-bravo",
    kind: "health",
    urgency: feedItemRank("health"),
    canvasName: CANVAS,
    seat: { nodeId: "seat-bravo", name: "bravo", portraitIdentity: "seat-bravo" },
    region: { regionId: "build", label: "Build", path: ["Build"] },
    text: "Bravo reads waiting on you",
    since: NOW - 60_000,
  };
  return {
    version: OPERATOR_FEED_VERSION,
    canvasName: CANVAS,
    generatedAt: NOW,
    count: 1,
    sections: [{ region: reading.region, items: [need, reading], worstUrgency: need.urgency }],
  };
})();

const FEED = feedOf([
  { id: "a", kind: "escalate", seat: "atlas", text: "Ana asks about the rates" },
  { id: "b", kind: "blocked", seat: "bravo", text: "Bravo is stuck on a sign-in" },
  { id: "c", kind: "work", seat: "atlas", text: "Ship the release notes" },
]);

let root: Root;
let host: HTMLDivElement;
const oldCanvas = state$.canvasName.peek();

const cards = (): string[] =>
  [...document.body.querySelectorAll<HTMLElement>("[data-testid='operator-feed-card']")].map((card) => card.dataset.itemId!.replace(/^signal:/u, ""));
const q = (testId: string) => document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const chips = (which: "feed-kind-chip" | "feed-seat-chip"): HTMLButtonElement[] =>
  [...document.body.querySelectorAll<HTMLButtonElement>(`[data-testid="${which}"]`)];
const search = (): HTMLInputElement => document.body.querySelector<HTMLInputElement>(".operator-feed__search")!;
const type = async (text: string): Promise<void> => {
  const field = search();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const press = async (element: Element): Promise<void> => {
  await act(async () => (element as HTMLElement).click());
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = () => {};
  clearFeedFilters();
  feedView$.seatsOpen.set(false);
  state$.canvasName.set(CANVAS);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearFeedFilters();
  feedView$.seatsOpen.set(false);
  state$.canvasName.set(oldCanvas);
  vi.unstubAllGlobals();
});

const open = async (): Promise<void> => {
  live.set(FEED);
  await act(async () => root.render(<OperatorFeed />));
};

it("searches needs by their words, under a field that says what it does", async () => {
  await open();
  expect(search().placeholder).toBe("Search needs");
  expect(cards()).toHaveLength(3);

  await type("RATES");
  expect(cards()).toEqual(["a"]);
  // The words are looked for in the sentence and the detail.
  await type("sign-in");
  expect(cards()).toEqual(["b"]);
  await type("nothing like it");
  expect(cards()).toEqual([]);
  expect(q("feed-no-matches")).not.toBeNull();
});

it("gives every kind one chip, in the one order, named as every surface names it", async () => {
  await open();
  expect(chips("feed-kind-chip").map((chip) => chip.textContent)).toEqual(["Blocked1", "Waiting on you1", "To do1"]);
});

it("keeps the seats folded behind one toggle until the operator asks for them", async () => {
  await open();
  const row = q("feed-seats-row")!;
  const toggle = q("feed-seats-toggle")!;
  // Folded: no seat chip shows, and the toggle names the row it opens and says it is closed.
  expect(row.hidden).toBe(true);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.getAttribute("aria-controls")).toBe(row.id);
  expect(toggle.textContent).toContain("Seats");
  expect(toggle.textContent).toContain("2");

  await press(toggle);
  expect(row.hidden).toBe(false);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(chips("feed-seat-chip").map((chip) => chip.textContent)).toEqual(["atlas2", "bravo1"]);
  // Every seat chip carries its region's dot, the same coding as the region chips.
  expect(chips("feed-seat-chip").every((chip) => chip.querySelector(".feed-region-chip__swatch") !== null)).toBe(true);

  await press(toggle);
  expect(row.hidden).toBe(true);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
});

it("filters by one seat at a time, leaving the chosen seat in the bar with its own clear", async () => {
  await open();
  const kind = (name: string) => chips("feed-kind-chip").find((chip) => chip.dataset.kind === name)!;
  const seat = (name: string) => chips("feed-seat-chip").find((chip) => chip.dataset.seat === `seat-${name}`)!;
  await press(q("feed-seats-toggle")!);

  await press(seat("atlas"));
  expect(seat("atlas").getAttribute("aria-pressed")).toBe("true");
  expect(cards()).toEqual(["a", "c"]);

  // A second seat replaces the first: one seat at a time, like the region pick.
  await press(seat("bravo"));
  expect(cards()).toEqual(["b"]);
  expect(seat("atlas").getAttribute("aria-pressed")).toBe("false");

  // Kinds and the seat narrow together, each on its own axis.
  await press(kind("blocked"));
  expect(cards()).toEqual(["b"]);
  await press(kind("blocked"));
  expect(cards()).toEqual(["b"]);

  // The chosen seat stays in the bar whether the row is open or folded.
  const chosen = () => q("feed-seat-chosen")!;
  expect(chosen().textContent).toBe("bravo");
  await press(q("feed-seats-toggle")!);
  expect(q("feed-seats-row")!.hidden).toBe(true);
  expect(chosen().textContent).toBe("bravo");

  // Its own clear drops it, with the keyboard left where the operator was.
  const clear = chosen().querySelector<HTMLButtonElement>("button[aria-label='Clear seat bravo']")!;
  await press(clear);
  expect(cards()).toEqual(["b", "a", "c"]);
  expect(q("feed-seat-chosen")).toBeNull();
  expect(seat("bravo").getAttribute("aria-pressed")).toBe("false");
});

it("lists only the picked region's seats, and drops a seat that region does not hold", async () => {
  live.set(
    feedOf([
      { id: "a", kind: "escalate", seat: "atlas", text: "Atlas asks about the rates" },
      { id: "b", kind: "work", seat: "cleo", text: "Cleo ships the notes" },
      { id: "c", kind: "blocked", seat: "bravo", text: "Bravo is stuck", region: "Design" },
    ]),
  );
  await act(async () => root.render(<OperatorFeed />));
  const region = (name: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="feed-region-chip"]')].find((chip) =>
      chip.textContent?.includes(name),
    )!;
  const seatsIn = () => chips("feed-seat-chip").map((chip) => chip.dataset.seat);

  await press(q("feed-seats-toggle")!);
  expect(seatsIn()).toEqual(["seat-atlas", "seat-bravo", "seat-cleo"]);

  // A picked region leaves only its own seats in the row.
  await press(region("Build"));
  expect(seatsIn()).toEqual(["seat-atlas", "seat-cleo"]);
  await press(chips("feed-seat-chip").find((chip) => chip.dataset.seat === "seat-atlas")!);
  expect(cards()).toEqual(["a"]);

  // A region that does not hold the picked seat drops it rather than emptying the feed.
  await press(region("Design"));
  expect(q("feed-seat-chosen")).toBeNull();
  // One seat in scope chooses nothing: the toggle gives way to the chips alone.
  expect(q("feed-seats-toggle")).toBeNull();
  expect(cards()).toEqual(["c"]);
});

it("says what the narrowing leaves, and announces it, rather than the whole feed's count", async () => {
  await open();
  const status = () => document.body.querySelector(".operator-feed__status")?.textContent ?? "";
  const announced = () => document.body.querySelector(".operator-feed__announce")?.textContent ?? "";
  expect(status()).toContain("3 waiting");

  await type("rates");
  expect(status()).toBe("1 of 3 shown");
  expect(announced()).toBe("1 of 3 shown with these filters");

  await type("nothing like it");
  expect(status()).toBe("0 of 3 shown");
  expect(announced()).toBe("0 of 3 shown with these filters");
});

it("counts a reading the kind chips narrow to, so the pair never says nothing while a card shows", async () => {
  live.set(WITH_READING);
  await act(async () => root.render(<OperatorFeed />));
  const status = () => document.body.querySelector(".operator-feed__status")?.textContent ?? "";
  const announced = () => document.body.querySelector(".operator-feed__announce")?.textContent ?? "";
  // At rest the feed counts its one need; the reading is listed, not counted.
  expect(status()).toContain("1 waiting");

  await press(chips("feed-kind-chip").find((chip) => chip.dataset.kind === "health")!);
  expect(cards()).toEqual(["health:seat-bravo"]);
  expect(status()).toBe("1 of 2 shown");
  expect(announced()).toBe("1 of 2 shown with these filters");
});

it("clears everything the operator narrowed, and only then", async () => {
  await open();
  await type("rates");
  await press(chips("feed-kind-chip").find((chip) => chip.dataset.kind === "escalate")!);
  await press(q("feed-seats-toggle")!);
  await press(chips("feed-seat-chip").find((chip) => chip.dataset.seat === "seat-atlas")!);
  expect(cards()).toEqual(["a"]);
  expect(q("feed-seat-chosen")).not.toBeNull();
  expect(q("feed-clear-filters")).not.toBeNull();

  await press(q("feed-clear-filters")!);
  // Clear takes the keyboard with it: the field, not the body, then the next Tab stays in the bar.
  expect(document.activeElement).toBe(search());
  expect(search().value).toBe("");
  expect(chips("feed-kind-chip").every((chip) => chip.getAttribute("aria-pressed") === "false")).toBe(true);
  // The seat goes with the rest, and the row is left as the operator had it.
  expect(q("feed-seat-chosen")).toBeNull();
  expect(chips("feed-seat-chip").every((chip) => chip.getAttribute("aria-pressed") === "false")).toBe(true);
  // Back to the feed's own order: most urgent first.
  expect(cards()).toEqual(["b", "a", "c"]);
  expect(feedView$.query.peek()).toBe("");
  expect(feedView$.seat.peek()).toBeUndefined();
});
