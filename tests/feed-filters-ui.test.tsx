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
import { buildOperatorFeed, type OperatorFeed as Feed } from "../src/shared/operator-feed";
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

/** One signal per entry, each its own seat, so seat chips have something to say. */
const feedOf = (
  specs: ReadonlyArray<{ readonly id: string; readonly kind: AgentSignalKind; readonly seat: string; readonly text: string }>,
): Feed => {
  const seats = [...new Map(specs.map((spec) => [spec.seat, spec.seat] as const)).entries()].map(([seat]) => seat);
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
    seats: seats.map((seat) => ({
      seat: { nodeId: `seat-${seat}`, name: seat, portraitIdentity: seat },
      region: { regionId: "build", label: "Build", path: ["Build"] },
    })),
    signals,
  });
};

const FEED = feedOf([
  { id: "a", kind: "escalate", seat: "atlas", text: "Ana asks about the rates" },
  { id: "b", kind: "blocked", seat: "bravo", text: "Bravo is stuck on a sign-in" },
  { id: "c", kind: "work", seat: "atlas", text: "Ship the release notes" },
]);

let root: Root;
let host: HTMLDivElement;
const oldCanvas = state$.canvasName.peek();

const cards = (): string[] =>
  [...document.body.querySelectorAll<HTMLElement>("[data-testid='operator-feed-card']")].map((card) => card.dataset.itemId!.slice("signal:".length));
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

it("filters by kind, by seat, and by both, each chip on its own", async () => {
  await open();
  const kind = (kind: string) => chips("feed-kind-chip").find((chip) => chip.dataset.kind === kind)!;
  // Chips carry the seat's node id; the words are its name.
  const seat = (name: string) => chips("feed-seat-chip").find((chip) => chip.textContent?.startsWith(name))!;
  expect(chips("feed-seat-chip").map((chip) => chip.textContent)).toEqual(["atlas2", "bravo1"]);

  await press(kind("blocked"));
  expect(kind("blocked").getAttribute("aria-pressed")).toBe("true");
  expect(cards()).toEqual(["b"]);

  await press(seat("atlas"));
  expect(chips("feed-seat-chip").find((chip) => chip.textContent?.startsWith("atlas"))?.getAttribute("aria-pressed")).toBe("true");
  // Both axes: blocked is Bravo's only need, so nothing is left.
  expect(cards()).toEqual([]);

  await press(kind("blocked"));
  expect(cards()).toEqual(["a", "c"]);
  await press(seat("atlas"));
  // Both chips off: the whole feed again, most urgent first.
  expect(cards()).toEqual(["b", "a", "c"]);
});

it("says what the narrowing leaves, and announces it, rather than the whole feed's count", async () => {
  await open();
  const status = () => document.body.querySelector(".operator-feed__status")?.textContent ?? "";
  const announced = () => document.body.querySelector(".operator-feed__announce")?.textContent ?? "";
  expect(status()).toContain("3 waiting");

  await type("rates");
  expect(status()).toBe("1 of 3 waiting");
  expect(announced()).toBe("1 need matches these filters");

  await type("nothing like it");
  expect(status()).toBe("0 of 3 waiting");
  expect(announced()).toBe("0 needs match these filters");
});

it("clears everything the operator narrowed, and only then", async () => {
  await open();
  await type("rates");
  await press(chips("feed-kind-chip").find((chip) => chip.dataset.kind === "escalate")!);
  expect(cards()).toEqual(["a"]);
  expect(q("feed-clear-filters")).not.toBeNull();

  await press(q("feed-clear-filters")!);
  // Clear takes the keyboard with it: the field, not the body, then the next Tab stays in the bar.
  expect(document.activeElement).toBe(search());
  expect(search().value).toBe("");
  expect(chips("feed-kind-chip").every((chip) => chip.getAttribute("aria-pressed") === "false")).toBe(true);
  // Back to the feed's own order: most urgent first.
  expect(cards()).toEqual(["b", "a", "c"]);
  expect(feedView$.query.peek()).toBe("");
});
