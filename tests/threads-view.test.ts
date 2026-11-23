import { describe, expect, it } from "vitest";
import { SeatUrgency } from "../src/shared/wire/urgency";
import type { FeedRegion } from "../src/shared/operator-feed";
import type { Seat } from "../src/shared/model";
import {
  keepSeat,
  reconcileThreadSelection,
  seatSummaryOf,
  threadRegionChips,
  threadSeatChips,
  threadsFilterOn,
  threadsStatusLine,
  threadsStoreView,
  urgentSeatsFirst,
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
  row("b", "bravo", CANVAS, "t2", 300),
  row("c", "charlie", OPEN, "t3", 200, 1),
  row("a", "alpha", PRODUCT, "t1", 100, 2),
  row("a", "alpha", PRODUCT, "t4", 50, 0, true),
];

const seat = (id: string, title: string): Seat => ({ id, kind: "agent", title }) as unknown as Seat;

describe("threads view", () => {
  it("puts the urgent seats first in the rail's order and leaves the calm out", () => {
    const groups: Record<string, ReturnType<typeof SeatUrgency.groupOf>> = {
      a: SeatUrgency.group.waiting,
      b: SeatUrgency.group.working,
      c: SeatUrgency.group.blocked,
      d: SeatUrgency.group.resting,
      e: SeatUrgency.group.review,
    };
    const seats = ["a", "b", "c", "d", "e"].map((id) => seat(id, id));
    expect(urgentSeatsFirst(seats, (one) => groups[one.id]!)).toEqual(["c", "a", "e"]);
  });

  it("asks the store for the region, the words, Unread and the urgent seats, only on this canvas", () => {
    const base = { region: undefined, query: "  ", unread: false, order: "newest" as const };
    expect(threadsStoreView(base, "factory", ["a"])).toEqual({ canvasName: "factory" });
    expect(
      threadsStoreView(
        { region: { canvasName: "factory", path: ["Junto"] }, query: " fix tabs ", unread: true, order: "urgency" },
        "factory",
        ["c", "a"],
      ),
    ).toEqual({ canvasName: "factory", region: ["Junto"], search: "fix tabs", unread: true, urgentFirst: ["c", "a"] });
    expect(threadsStoreView({ ...base, region: { canvasName: "other", path: ["Junto"] } }, "factory", [])).toEqual({
      canvasName: "factory",
    });
    // Most urgent first with no urgent seat is newest first: the store is not asked for an empty order.
    expect(threadsStoreView({ ...base, order: "urgency" }, "factory", [])).toEqual({ canvasName: "factory" });
  });

  it("keeps one seat, a seat a review copied in included", () => {
    expect(keepSeat(rows, "a").map((one) => one.threadId)).toEqual(["t1", "t4"]);
    const copied = { ...rows[0]!, alsoSeats: [{ nodeId: "c", name: "charlie", portraitIdentity: "c" }] };
    expect(keepSeat([copied], "c")).toHaveLength(1);
    expect(keepSeat(rows, undefined)).toHaveLength(4);
  });

  it("counts the words, Unread and a seat as filters, a blank search not", () => {
    expect(threadsFilterOn({ query: " fix ", unread: false, seat: undefined })).toBe(true);
    expect(threadsFilterOn({ query: "  ", unread: false, seat: undefined })).toBe(false);
    expect(threadsFilterOn({ query: "", unread: true, seat: undefined })).toBe(true);
    expect(threadsFilterOn({ query: "", unread: false, seat: "a" })).toBe(true);
  });

  it("hands the chat a summary it can answer, with the operator as you", () => {
    const mine = seatSummaryOf(rows[3]!);
    expect(mine.last).toMatchObject({ author: "you", mine: true });
    expect(mine.canReply).toBe(true);
    const theirs = seatSummaryOf(rows[2]!);
    expect(theirs.last).toMatchObject({ author: "alpha", mine: false });
    expect(theirs.unread).toBe(2);
  });

  it("draws region chips from the store's innermost regions, a parent adding its children up", () => {
    const chips = threadRegionChips([
      { region: PRODUCT, total: 2, unread: 2 },
      { region: CANVAS, total: 1, unread: 0 },
      { region: OPEN, total: 1, unread: 1 },
    ]);
    expect(chips.map((chip) => chip.label)).toEqual(["Junto", "Product", "Canvas", "open field"]);
    expect(chips.find((chip) => chip.label === "Junto")?.count).toBe(2);
    expect(chips.find((chip) => chip.label === "Product")?.color).toBe("2");
    expect(chips.find((chip) => chip.label === "Canvas")?.count).toBe(0);
    // A pick with nothing left in it stays on the strip.
    expect(threadRegionChips([], ["Junto", "Gone"]).map((chip) => chip.label)).toEqual(["Gone"]);
  });

  it("draws one seat chip per seat, the most threads first", () => {
    expect(threadSeatChips(rows).map((chip) => [chip.name, chip.count])).toEqual([
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

  it("hands a selection that left to its next neighbour, else the one before, else the first", () => {
    expect(reconcileThreadSelection(["a", "b", "c"], ["a", "c"], "b")).toBe("c");
    expect(reconcileThreadSelection(["a", "b", "c"], ["a", "b"], "c")).toBe("b");
    expect(reconcileThreadSelection(["a"], ["x", "y"], "a")).toBe("x");
    expect(reconcileThreadSelection([], ["x"], null)).toBe("x");
    expect(reconcileThreadSelection(["a"], [], "a")).toBeNull();
  });
});
