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
let chats: Array<{ threadId: string; yields: boolean }> = [];

const draw = (read: OperatorThreadsState, props: { quick?: boolean } = {}): void => {
  act(() =>
    root.render(
      <ThreadsBody
        canvasName={CANVAS}
        read={read}
        all={{ total: 24, unread: 3 }}
        nodesById={new Map()}
        onLoadMore={loadMore}
        chat={(shown, yields) => {
          chats.push({ threadId: shown.threadId, yields: yields() });
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
