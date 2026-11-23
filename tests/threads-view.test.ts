import { describe, expect, it } from "vitest";
import { SeatUrgency } from "../src/shared/wire/urgency";
import type { FeedRegion } from "../src/shared/operator-feed";
import {
  keepUnread,
  orderThreadRows,
  reconcileThreadSelection,
  seatSummaryOf,
  seatsByUrgency,
  threadRegionChips,
  threadRowKey,
  threadSeatChips,
  threadsFilterOn,
  threadsReadFilter,
  threadsStatusLine,
  type ThreadRow,
} from "../src/window/lib/threads-view";

const OPEN: FeedRegion = { regionId: null, label: "open field", path: [] };
const PRODUCT: FeedRegion = { regionId: "r-product", label: "Product", path: ["Junto", "Product"], color: "2" };
const CANVAS: FeedRegion = { regionId: "r-canvas", label: "Canvas", path: ["Junto", "Canvas"], color: "4" };

const row = (seatId: string, seatName: string, region: FeedRegion, threadId: string, lastAt: number, unread = 0, mine = false): ThreadRow => ({
  threadId,
  seat: { nodeId: seatId, name: seatName, portraitIdentity: seatId },
  region,
  title: `thread ${threadId}`,
  startedAt: lastAt - 1000,
  lastAt,
  last: {
    messageId: `${threadId}-last`,
    from: mine ? { kind: "operator" } : { kind: "seat", nodeId: seatId, name: seatName },
    text: "latest words",
    at: lastAt,
  },
  messageCount: 2,
  unread,
});

const rows: ReadonlyArray<ThreadRow> = [
  row("a", "alpha", PRODUCT, "t1", 100, 2),
  row("b", "bravo", CANVAS, "t2", 300),
  row("c", "charlie", OPEN, "t3", 200, 1),
  row("a", "alpha", PRODUCT, "t4", 50, 0, true),
];

const urgencyNone = (): undefined => undefined;

describe("threads view", () => {
  it("orders newest first by default, whatever the seats' states", () => {
    expect(orderThreadRows(rows, "newest", urgencyNone).map((one) => one.threadId)).toEqual(["t2", "t3", "t1", "t4"]);
  });

  it("orders by the seat's urgency in the rail's view first, then recency", () => {
    const groups: Record<string, ReturnType<typeof SeatUrgency.groupOf>> = {
      a: SeatUrgency.group.blocked,
      b: SeatUrgency.group.working,
      c: SeatUrgency.group.waiting,
    };
    // alpha blocked (its newer thread first), charlie waiting, bravo working.
    expect(orderThreadRows(rows, "urgency", (seatId) => groups[seatId]).map((one) => one.threadId)).toEqual(["t1", "t4", "t3", "t2"]);
    expect(seatsByUrgency(["b", "a", "c", "d"], (seatId) => groups[seatId])).toEqual([["a"], ["c"], ["b"], ["d"]]);
  });

  it("puts a seat whose urgency is unknown with the offline seats, after the rest", () => {
    const keys = orderThreadRows(rows, "urgency", (seatId) => (seatId === "b" ? SeatUrgency.group.resting : undefined)).map(
      (one) => one.threadId,
    );
    expect(keys[0]).toBe("t2");
  });

  it("asks the core read for the region, the words and the seat, and only on this canvas", () => {
    expect(threadsReadFilter({ region: undefined, query: "  ", seat: undefined }, "factory")).toEqual({ canvasName: "factory" });
    expect(
      threadsReadFilter({ region: { canvasName: "factory", path: ["Junto"] }, query: " fix tabs ", seat: "a" }, "factory"),
    ).toEqual({ canvasName: "factory", region: ["Junto"], search: "fix tabs", seats: ["a"] });
    expect(threadsReadFilter({ region: { canvasName: "other", path: ["Junto"] }, query: "", seat: undefined }, "factory")).toEqual({
      canvasName: "factory",
    });
  });

  it("keeps only unread threads with Unread, and counts the words as a filter", () => {
    expect(keepUnread(rows, true).map((one) => one.threadId)).toEqual(["t1", "t3"]);
    expect(keepUnread(rows, false)).toHaveLength(4);
    expect(threadsFilterOn({ query: " fix ", unread: false, seat: undefined })).toBe(true);
    expect(threadsFilterOn({ query: "  ", unread: false, seat: undefined })).toBe(false);
    expect(threadsFilterOn({ query: "", unread: true, seat: undefined })).toBe(true);
  });

  it("hands the chat a summary it can answer, with the operator as you", () => {
    const mine = seatSummaryOf(rows[3]!);
    expect(mine.last).toMatchObject({ author: "you", mine: true });
    expect(mine.canReply).toBe(true);
    const theirs = seatSummaryOf(rows[0]!);
    expect(theirs.last).toMatchObject({ author: "alpha", mine: false });
    expect(theirs.unread).toBe(2);
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
  });

  it("keys a row by its seat and its thread", () => {
    expect(threadRowKey(rows[0]!)).not.toBe(threadRowKey({ ...rows[0]!, seat: { ...rows[0]!.seat, nodeId: "b" } }));
  });

  it("hands a selection that left to its next neighbour, else the one before, else the first", () => {
    expect(reconcileThreadSelection(["a", "b", "c"], ["a", "c"], "b")).toBe("c");
    expect(reconcileThreadSelection(["a", "b", "c"], ["a", "b"], "c")).toBe("b");
    expect(reconcileThreadSelection(["a"], ["x", "y"], "a")).toBe("x");
    expect(reconcileThreadSelection([], ["x"], null)).toBe("x");
    expect(reconcileThreadSelection(["a"], [], "a")).toBeNull();
  });
});
