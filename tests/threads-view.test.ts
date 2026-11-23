import { describe, expect, it } from "vitest";
import { SeatUrgency } from "../src/shared/wire/urgency";
import type { FeedRegion } from "../src/shared/operator-feed";
import type { SeatThreadSummary } from "../src/window/lib/seat-threads";
import {
  orderThreadRows,
  reconcileThreadSelection,
  threadRegionChips,
  threadRowKey,
  threadRowMatches,
  threadSeatChips,
  threadsFilterOn,
  threadsStatusLine,
  unreadThreads,
  viewThreadRows,
  type ThreadRow,
} from "../src/window/lib/threads-view";

const OPEN: FeedRegion = { regionId: null, label: "open field", path: [] };
const PRODUCT: FeedRegion = { regionId: "r-product", label: "Product", path: ["Junto", "Product"], color: "2" };
const CANVAS: FeedRegion = { regionId: "r-canvas", label: "Canvas", path: ["Junto", "Canvas"], color: "4" };

const thread = (threadId: string, lastAt: number, unread = 0): SeatThreadSummary => ({
  threadId,
  title: `thread ${threadId}`,
  participants: ["you", "seat"],
  startedAt: lastAt - 1000,
  lastAt,
  last: { messageId: `${threadId}-last`, author: "seat", mine: false, text: "latest words", at: lastAt },
  messageCount: 2,
  canReply: true,
  unread,
});

const row = (seatId: string, seatName: string, region: FeedRegion, summary: SeatThreadSummary): ThreadRow => ({
  canvasName: "factory",
  seatId,
  seatName,
  region,
  thread: summary,
});

const rows: ReadonlyArray<ThreadRow> = [
  row("a", "alpha", PRODUCT, thread("t1", 100, 2)),
  row("b", "bravo", CANVAS, thread("t2", 300)),
  row("c", "charlie", OPEN, thread("t3", 200, 1)),
  row("a", "alpha", PRODUCT, thread("t4", 50)),
];

const NO_FILTER = { query: "", unread: false, seat: undefined };
const urgencyNone = (): undefined => undefined;

describe("threads view", () => {
  it("orders newest first by default, whatever the seats' states", () => {
    const keys = viewThreadRows(rows, undefined, "factory", "newest", NO_FILTER, urgencyNone).map((one) => one.thread.threadId);
    expect(keys).toEqual(["t2", "t3", "t1", "t4"]);
  });

  it("orders by the seat's urgency in the rail's view first, then recency", () => {
    const groups: Record<string, ReturnType<typeof SeatUrgency.groupOf>> = {
      a: SeatUrgency.group.blocked,
      b: SeatUrgency.group.working,
      c: SeatUrgency.group.waiting,
    };
    const keys = orderThreadRows(rows, "urgency", (seatId) => groups[seatId]).map((one) => one.thread.threadId);
    // alpha blocked (its newer thread first), charlie waiting, bravo working.
    expect(keys).toEqual(["t1", "t4", "t3", "t2"]);
  });

  it("puts a seat whose urgency is unknown with the offline seats, after the rest", () => {
    const keys = orderThreadRows(rows, "urgency", (seatId) => (seatId === "b" ? SeatUrgency.group.resting : undefined)).map(
      (one) => one.thread.threadId,
    );
    expect(keys[0]).toBe("t2");
  });

  it("narrows to a region and its children, and ignores a pick on another canvas", () => {
    const junto = viewThreadRows(rows, { canvasName: "factory", path: ["Junto"] }, "factory", "newest", NO_FILTER, urgencyNone);
    expect(junto.map((one) => one.seatId)).toEqual(["b", "a", "a"]);
    const elsewhere = viewThreadRows(rows, { canvasName: "other", path: ["Junto"] }, "factory", "newest", NO_FILTER, urgencyNone);
    expect(elsewhere).toHaveLength(4);
    const open = viewThreadRows(rows, { canvasName: "factory", path: [] }, "factory", "newest", NO_FILTER, urgencyNone);
    expect(open.map((one) => one.seatId)).toEqual(["c"]);
  });

  it("keeps only unread threads with Unread, and one seat with a seat pick", () => {
    expect(rows.filter((one) => threadRowMatches(one, { ...NO_FILTER, unread: true })).map((one) => one.thread.threadId)).toEqual([
      "t1",
      "t3",
    ]);
    expect(rows.filter((one) => threadRowMatches(one, { ...NO_FILTER, seat: "a" }))).toHaveLength(2);
  });

  it("leaves the words to the core read: a query alone filters nothing here, but counts as a filter", () => {
    expect(rows.filter((one) => threadRowMatches(one, { ...NO_FILTER, query: "zzz" }))).toHaveLength(4);
    expect(threadsFilterOn({ ...NO_FILTER, query: " fix " })).toBe(true);
    expect(threadsFilterOn({ ...NO_FILTER, query: "  " })).toBe(false);
  });

  it("draws region chips with a parent before its first child, counting unread threads", () => {
    const chips = threadRegionChips(rows);
    expect(chips.map((chip) => chip.label)).toEqual(["Junto", "Canvas", "open field", "Product"]);
    expect(chips.find((chip) => chip.label === "Junto")?.count).toBe(1);
    expect(chips.find((chip) => chip.label === "Product")?.count).toBe(1);
    expect(chips.find((chip) => chip.label === "Product")?.color).toBe("2");
    expect(chips.find((chip) => chip.label === "Canvas")?.count).toBe(0);
  });

  it("draws one seat chip per seat, the most threads first", () => {
    const chips = threadSeatChips(rows);
    expect(chips.map((chip) => [chip.name, chip.count])).toEqual([
      ["alpha", 2],
      ["bravo", 1],
      ["charlie", 1],
    ]);
  });

  it("says the status in the feed's form", () => {
    expect(threadsStatusLine({ total: 24, unread: 3, shown: 24, filtering: false })).toBe("24 threads, 3 unread");
    expect(threadsStatusLine({ total: 1, unread: 0, shown: 1, filtering: false })).toBe("1 thread");
    expect(threadsStatusLine({ total: 24, unread: 3, shown: 5, filtering: true })).toBe("5 of 24 shown");
    expect(threadsStatusLine({ total: 24, unread: 3, shown: 6, region: ["Junto", "Product"], filtering: false })).toBe(
      "6 of 24 threads in Product",
    );
    expect(threadsStatusLine({ total: 24, unread: 3, shown: 2, region: [], filtering: true })).toBe("2 of 24 shown in the open field");
    expect(threadsStatusLine({ total: 0, unread: 0, shown: 0, filtering: false })).toBe("no threads yet");
    expect(unreadThreads(rows)).toBe(2);
  });

  it("keys a row by its seat and its thread", () => {
    expect(threadRowKey(rows[0]!)).not.toBe(threadRowKey({ ...rows[0]!, seatId: "b" }));
  });

  it("hands a selection that left to its next neighbour, else the one before, else the first", () => {
    expect(reconcileThreadSelection(["a", "b", "c"], ["a", "c"], "b")).toBe("c");
    expect(reconcileThreadSelection(["a", "b", "c"], ["a", "b"], "c")).toBe("b");
    expect(reconcileThreadSelection(["a"], ["x", "y"], "a")).toBe("x");
    expect(reconcileThreadSelection([], ["x"], null)).toBe("x");
    expect(reconcileThreadSelection(["a"], [], "a")).toBeNull();
  });
});
