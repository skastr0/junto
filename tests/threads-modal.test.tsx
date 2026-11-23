// @vitest-environment jsdom
/**
 * Threads, the operator modal (Global threads): the body over the store's
 * state. The chat (which marks what it shows read) is mounted only for the
 * thread on screen, never behind Quick thread; the list asks
 * for its next page; a row says its seat, region, line, last mail and
 * unread; the status and the filters speak in the feed's form.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FeedRegion } from "../src/shared/operator-feed";
import type { OperatorThreadsState } from "../src/window/lib/operator-threads";
import { clearThreadsFilters, threadsView$, type ThreadRow } from "../src/window/lib/threads-view";

import { runThreadKey } from "../src/window/lib/thread-keys";

// jsdom has no CSS.escape; the list's keys use it to find the row a move lands on.
globalThis.CSS ??= { escape: (value: string) => value } as unknown as typeof CSS;

const { ThreadsBody } = await import("../src/window/components/feed/ThreadsModal");

const CANVAS = "threads-modal";
const PRODUCT: FeedRegion = { regionId: "r-product", label: "Product", path: ["Junto", "Product"], color: "2" };
const OPEN: FeedRegion = { regionId: null, label: "open field", path: [] };

const row = (threadId: string, seatId: string, region: FeedRegion, lastAt: number, unread: number, mine = false): ThreadRow => ({
  threadId,
  seat: { nodeId: seatId, name: `seat ${seatId}`, portraitIdentity: seatId },
  region,
  title: `line of ${threadId}`,
  startedAt: lastAt - 1,
  lastAt,
  last: {
    messageId: `${threadId}-m`,
    from: mine ? { kind: "operator" } : { kind: "seat", nodeId: seatId, name: `seat ${seatId}` },
    text: `last of ${threadId}`,
    at: lastAt,
  },
  messageCount: 3,
  unread,
});

const state = (rows: ReadonlyArray<ThreadRow>, extra: Partial<OperatorThreadsState> = {}): OperatorThreadsState => ({
  rows,
  loaded: true,
  error: "",
  total: rows.length,
  unread: rows.filter((one) => one.unread > 0).length,
  regions: [
    { region: PRODUCT, total: 1, unread: 1 },
    { region: OPEN, total: 1, unread: 0 },
  ],
  seatCounts: [
    { seat: rows[0]?.seat ?? { nodeId: "a", name: "seat a", portraitIdentity: "a" }, region: PRODUCT, total: 1, unread: 1 },
    { seat: { nodeId: "b", name: "seat b", portraitIdentity: "b" }, region: OPEN, total: 1, unread: 0 },
  ],
  hasMore: false,
  ...extra,
});

let root: Root;
let host: HTMLDivElement;
const loadMore = vi.fn();
/** Each chat mount, with what its reply field would be told. */
let chats: Array<{ threadId: string; yields: boolean; picked: boolean }> = [];

const draw = (read: OperatorThreadsState, props: { quick?: boolean } = {}): void => {
  act(() =>
    root.render(
      <ThreadsBody
        canvasName={CANVAS}
        read={read}
        all={{ total: 24, unread: 3 }}
        nodesById={new Map()}
        onLoadMore={loadMore}
        chat={(shown, yields, picked) => {
          chats.push({ threadId: shown.threadId, yields: yields(), picked });
          return <div data-testid="chat">{shown.threadId}</div>;
        }}
        {...(props.quick
          ? {
              quickThread: (done: (first?: { seatId: string; threadId: string }) => void) => (
                <button type="button" data-testid="quick" onClick={() => done({ seatId: "b", threadId: "t2" })}>
                  quick
                </button>
              ),
            }
          : {})}
      />,
    ),
  );
};

const q = <E extends Element = HTMLElement>(selector: string): E | null => document.body.querySelector<E>(selector);
const all = (selector: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(selector)];

beforeEach(() => {
  chats = [];
  loadMore.mockReset();
  clearThreadsFilters();
  threadsView$.order.set("newest");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const rows = [row("t1", "a", PRODUCT, 300, 2), row("t2", "b", OPEN, 200, 0, true)];

it("shows the first thread's chat on the right, and only it", () => {
  draw(state(rows));
  expect(all('[data-testid="chat"]').map((chat) => chat.textContent)).toEqual(["t1"]);
  expect(q('[data-testid="operator-threads-row"][data-thread="t1"]')?.dataset.selected).toBe("true");
});

it("swaps the chat for the one picked, and leaves the keyboard in the list unless Enter opened it", () => {
  draw(state(rows));
  act(() => q<HTMLButtonElement>('[data-thread="t2"]')!.click());
  expect(q('[data-testid="chat"]')?.textContent).toBe("t2");
  expect(chats.every((chat) => chat.yields)).toBe(true);
});

it("mounts no chat while Quick thread takes the pane, and shows the new thread once the list has it", () => {
  draw(state([]), { quick: true });
  act(() => q<HTMLButtonElement>('[data-testid="operator-threads-new"]')!.click());
  draw(state(rows.slice(0, 1)), { quick: true });
  expect(q('[data-testid="chat"]')).toBeNull();
  // Sent: the new thread t2 is not in the list yet, so nothing else is shown in its place.
  act(() => q<HTMLButtonElement>('[data-testid="quick"]')!.click());
  expect(q('[data-testid="quick"]')).toBeNull();
  expect(q('[data-testid="chat"]')).toBeNull();
  draw(state(rows), { quick: true });
  expect(q('[data-testid="chat"]')?.textContent).toBe("t2");
  expect(q('[data-thread="t2"]')?.dataset.selected).toBe("true");
});

it("answers the Quick thread key while it is open", () => {
  draw(state(rows), { quick: true });
  act(() => {
    expect(runThreadKey("threads.quick")).toBe(true);
  });
  expect(q('[data-testid="quick"]')).not.toBeNull();
  act(() => root.unmount());
  root = createRoot(host);
  expect(runThreadKey("threads.quick")).toBe(false);
});

it("draws a row's seat, region, line, last mail and unread, and You on the operator's own", () => {
  draw(state(rows));
  const first = q('[data-thread="t1"]')!;
  expect(first.querySelector(".operator-threads__seat")?.textContent).toBe("seat a");
  expect(first.querySelector(".operator-threads__region-name")?.textContent).toBe("Product");
  expect(first.querySelector(".operator-threads__line")?.textContent).toBe("line of t1");
  expect(first.querySelector('[data-testid="operator-threads-row-unread"]')?.textContent).toBe("2");
  expect(first.dataset.unread).toBe("true");
  const second = q('[data-thread="t2"]')!;
  expect(second.querySelector(".operator-threads__last")?.textContent).toBe("You: last of t2");
  expect(second.querySelector('[data-testid="operator-threads-row-unread"]')).toBeNull();
});

it("says the status in the feed's form, and what a filter shows", () => {
  draw(state(rows));
  expect(q(".operator-feed__status")?.textContent).toBe("24 threads, 3 unread");
  act(() => threadsView$.unread.set(true));
  expect(q(".operator-feed__status")?.textContent).toBe("2 of 24 shown");
  expect(q(".operator-feed__announce")?.textContent).toBe("2 of 24 shown with these filters");
  expect(q('[data-testid="threads-unread-chip"]')?.getAttribute("aria-pressed")).toBe("true");
});

it("draws the region strip from the store's regions and the seat row from its seat counts", () => {
  draw(state(rows));
  const chips = all('[data-testid="feed-region-chip"]').map((chip) => chip.getAttribute("aria-label"));
  expect(chips).toEqual(["All regions, 3 unread", "Junto, 1 unread", "Junto > Product, 1 unread", "open field"]);
  expect(q('[data-testid="feed-region-strip"]')?.getAttribute("aria-label")).toBe("Filter threads by region");
  act(() => q<HTMLButtonElement>('[data-testid="feed-seats-toggle"]')!.click());
  expect(all('[data-testid="feed-seat-chip"]').map((chip) => chip.getAttribute("aria-label"))).toEqual([
    "seat a, 1 thread",
    "seat b, 1 thread",
  ]);
});

it("asks for the next page when the list does not fill its column", () => {
  draw(state(rows, { hasMore: true }));
  // jsdom lays nothing out: a list with no height asks for nothing, like a folded one.
  expect(loadMore).not.toHaveBeenCalled();
  const list = q<HTMLDivElement>('[data-testid="operator-threads"]')!;
  Object.defineProperty(list, "clientHeight", { configurable: true, value: 600 });
  Object.defineProperty(list, "scrollHeight", { configurable: true, value: 700 });
  act(() => list.dispatchEvent(new Event("scroll")));
  expect(loadMore).toHaveBeenCalledTimes(1);
});

it("says No threads yet with Quick thread, and Nothing matches with Clear", () => {
  draw({ ...state([]), total: 0, unread: 0 }, { quick: true });
  act(() => root.render(<></>));
  act(() =>
    root.render(
      <ThreadsBody
        canvasName={CANVAS}
        read={{ ...state([]), total: 0 }}
        all={{ total: 0, unread: 0 }}
        nodesById={new Map()}
        onLoadMore={loadMore}
        chat={() => null}
        quickThread={() => null}
      />,
    ),
  );
  expect(q(".operator-feed__empty-title")?.textContent).toBe("No threads yet");
  expect(q(".operator-feed__empty button")?.textContent).toBe("Quick thread");
  act(() => threadsView$.query.set("zzz"));
  expect(q('[data-testid="threads-no-matches"] .operator-feed__empty-title')?.textContent).toBe("Nothing matches these filters");
});

it("is one Tab stop: the selected row, or the first while none is", () => {
  draw(state(rows), { quick: true });
  expect(all('[data-testid="operator-threads-row"]').map((one) => one.tabIndex)).toEqual([0, -1]);
  act(() => q<HTMLButtonElement>('[data-thread="t2"]')!.click());
  expect(all('[data-testid="operator-threads-row"]').map((one) => one.tabIndex)).toEqual([-1, 0]);
  act(() => q<HTMLButtonElement>('[data-testid="operator-threads-new"]')!.click());
  expect(q('[data-testid="operator-threads-new"]')?.getAttribute("aria-current")).toBe("true");
  expect(all('[data-testid="operator-threads-row"]').map((one) => one.tabIndex)).toEqual([0, -1]);
});

it("says a row's unread in words, and the Unread chip's count in its name", () => {
  draw(state([{ ...rows[0]!, unread: 120 }, rows[1]!]));
  const first = q('[data-thread="t1"]')!;
  expect(first.querySelector('[data-testid="operator-threads-row-unread"]')?.getAttribute("aria-hidden")).toBe("true");
  expect(first.querySelector(".sr-only")?.textContent).toBe("more than 99 unread");
  expect(q('[data-testid="threads-unread-chip"]')?.getAttribute("aria-label")).toBe("Unread, 1");
});

it("says a region pick, and Every thread shown when the last narrowing clears", () => {
  draw(state(rows));
  expect(q(".operator-feed__announce")?.textContent).toBe("");
  act(() => threadsView$.region.set({ canvasName: CANVAS, path: ["Junto", "Product"] }));
  expect(q(".operator-feed__announce")?.textContent).toBe("2 of 24 shown in Product");
  act(() => threadsView$.unread.set(true));
  expect(q(".operator-feed__announce")?.textContent).toBe("2 of 24 shown in Product with these filters");
  act(() => clearThreadsFilters());
  expect(q(".operator-feed__announce")?.textContent).toBe("Every thread shown");
});

it("closes Quick thread on Escape, back on New thread, before the modal", () => {
  draw(state(rows), { quick: true });
  act(() => q<HTMLButtonElement>('[data-testid="operator-threads-new"]')!.click());
  expect(q('[data-testid="quick"]')).not.toBeNull();
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(q('[data-testid="quick"]')).toBeNull();
  expect(q('[data-testid="chat"]')?.textContent).toBe("t1");
  expect(document.activeElement?.getAttribute("data-testid")).toBe("operator-threads-new");
});

it("starts line 3 with the Clock while the operator's own last mail waits for its seat", () => {
  const waiting = { ...rows[1]!, last: { ...rows[1]!.last, waiting: true as const } };
  draw(state([rows[0]!, waiting]));
  const last = q('[data-thread="t2"] .operator-threads__last')!;
  expect(last.querySelector('[data-testid="operator-threads-row-waiting"]')?.getAttribute("title")).toBe("Waiting for seat b. It arrives when the seat is back.");
  expect(last.querySelector(".sr-only")?.textContent).toBe("Waiting for seat b. It arrives when the seat is back. ");
  expect(q('[data-thread="t1"] [data-testid="operator-threads-row-waiting"]')).toBeNull();
});

it("marks a thread with an open signal by its kind's glyph, said as open and the feed's word", () => {
  draw(state([{ ...rows[0]!, openSignal: { signalId: "s1", kind: "escalate", text: "Which rate?" } }, rows[1]!]));
  const mark = q('[data-thread="t1"] [data-testid="operator-threads-row-signal"]')!;
  expect(mark.dataset.kind).toBe("escalate");
  expect(mark.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  expect(mark.querySelector(".sr-only")?.textContent).toBe("open, waiting on you");
  // Before the unread pill.
  expect(mark.nextElementSibling?.getAttribute("data-testid")).toBe("operator-threads-row-unread");
  expect(q('[data-thread="t2"] [data-testid="operator-threads-row-signal"]')).toBeNull();
});

const unreadRows = [row("u1", "a", PRODUCT, 300, 1), row("u2", "a", PRODUCT, 200, 2), row("u3", "b", OPEN, 100, 1)];

it("reads no thread the operator did not pick, and keeps the one picked under Unread until selection moves", () => {
  act(() => threadsView$.unread.set(true));
  draw(state(unreadRows));
  // Shown first, not chosen: the chat is told it is not the operator's pick, so nothing is read.
  expect(chats.at(-1)).toMatchObject({ threadId: "u1", picked: false });
  expect(chats.every((chat) => !chat.picked)).toBe(true);
  act(() => q<HTMLButtonElement>('[data-thread="u2"]')!.click());
  expect(chats.at(-1)).toMatchObject({ threadId: "u2", picked: true });
  // Read, the store's Unread list drops it: it stays, in its place, while selected.
  draw(state([unreadRows[0]!, unreadRows[2]!]));
  expect(all('[data-testid="operator-threads-row"]').map((one) => one.dataset.thread)).toEqual(["u1", "u2", "u3"]);
  expect(q('[data-thread="u2"]')?.dataset.selected).toBe("true");
  // Selection moves on: it leaves.
  act(() => q<HTMLButtonElement>('[data-thread="u3"]')!.click());
  expect(all('[data-testid="operator-threads-row"]').map((one) => one.dataset.thread)).toEqual(["u1", "u3"]);
});

it("hears the list's keys from the frame on open, and leaves a field's keys to it", () => {
  draw(state(rows));
  const frame = q(".operator-modal__frame")!;
  act(() => {
    frame.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  expect(q('[data-thread="t2"]')?.dataset.selected).toBe("true");
  expect(chats.at(-1)).toMatchObject({ threadId: "t2", picked: true });
  const search = q<HTMLInputElement>('input[type="search"], .operator-feed__controls input')!;
  act(() => {
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  });
  expect(q('[data-thread="t2"]')?.dataset.selected).toBe("true");
});

it("folds a seat row with no toggle, so Escape is not spent on it", () => {
  act(() => threadsView$.seatsOpen.set(true));
  draw(state(rows, { seatCounts: [{ seat: rows[0]!.seat, region: PRODUCT, total: 2, unread: 1 }] }));
  expect(q('[data-testid="feed-seats-toggle"]')).toBeNull();
  expect(threadsView$.seatsOpen.peek()).toBe(false);
});

it("leaves the keyboard on New thread after a send, then on the new thread's row, and clears a filter that hides it", () => {
  act(() => threadsView$.query.set("line"));
  draw(state(rows.slice(0, 1)), { quick: true });
  act(() => q<HTMLButtonElement>('[data-testid="operator-threads-new"]')!.click());
  act(() => q<HTMLButtonElement>('[data-testid="quick"]')!.click());
  expect(threadsView$.query.peek()).toBe("");
  expect(document.activeElement?.getAttribute("data-testid")).toBe("operator-threads-new");
  draw(state(rows), { quick: true });
  expect(document.activeElement?.closest("[data-thread]")?.getAttribute("data-thread")).toBe("t2");
  expect(chats.at(-1)).toMatchObject({ threadId: "t2", picked: true });
});

it("watches the column it has, after the empty state gives it back", () => {
  const watched: Element[] = [];
  const unwatched: Element[] = [];
  const Real = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    private at: Element | undefined;
    observe(element: Element): void {
      this.at = element;
      watched.push(element);
    }
    unobserve(): void {}
    disconnect(): void {
      if (this.at) unwatched.push(this.at);
    }
  } as unknown as typeof ResizeObserver;
  try {
    draw({ ...state([]), total: 0, unread: 0 }, { quick: true });
    act(() => root.render(<></>));
    act(() =>
      root.render(
        <ThreadsBody
          canvasName={CANVAS}
          read={{ ...state([]), total: 0 }}
          all={{ total: 0, unread: 0 }}
          nodesById={new Map()}
          onLoadMore={loadMore}
          chat={() => null}
          quickThread={() => <div data-testid="quick-pane" />}
        />,
      ),
    );
    act(() => q<HTMLButtonElement>('[data-testid="threads-empty-quick"]')!.click());
    const column = q(".operator-threads__scroll");
    expect(column).not.toBeNull();
    expect(watched.at(-1)).toBe(column);
  } finally {
    globalThis.ResizeObserver = Real;
  }
});
