import { describe, expect, it } from "vitest";
import {
  broadcastReceipt,
  broadcastReceiptSpoken,
  chooseRegion,
  confirmDetail,
  confirmSpoken,
  crossLine,
  groupByRegion,
  leftOutLine,
  limitWord,
  regionTokenText,
  toggleLimit,
  typedLimit,
} from "../src/window/lib/quick-thread-broadcast";

const seat = (nodeId: string) => ({ canvasName: "c", nodeId, name: nodeId, running: true, elsewhere: false });

describe("limit words", () => {
  it("are the feed's own", () => {
    expect(limitWord({ group: "needs", value: "escalate" })).toBe("waiting on you");
    expect(limitWord({ group: "needs", value: "feedback" })).toBe("ready for review");
    expect(limitWord({ group: "doing", value: "off" })).toBe("off");
  });
  it("end a typed query as a whole word, the longest first", () => {
    expect(typedLimit("junto working")).toEqual({ limit: { group: "doing", value: "working" }, rest: "junto" });
    expect(typedLimit("junto ready for review")?.limit).toEqual({ group: "needs", value: "feedback" });
    expect(typedLimit("junto waiting on you")?.rest).toBe("junto");
    expect(typedLimit("network")).toBeUndefined();
    expect(typedLimit("junto")).toBeUndefined();
    expect(typedLimit("working")?.rest).toBe("");
  });
});

describe("picks", () => {
  it("choosing a region again adds to its pick, never a second one", () => {
    const one = chooseRegion([], "r", { group: "doing", value: "working" });
    const two = chooseRegion(one, "r", { group: "needs", value: "feedback" });
    expect(two).toHaveLength(1);
    expect(two[0]).toMatchObject({ doing: ["working"], needs: ["feedback"] });
    expect(chooseRegion(two, "r")).toBe(two);
    expect(chooseRegion(two, "r", { group: "doing", value: "working" })).toBe(two);
  });
  it("a limit toggles off and its words keep their order", () => {
    let pick = chooseRegion([], "r", { group: "needs", value: "feedback" })[0]!;
    pick = toggleLimit(pick, { group: "doing", value: "idle" });
    pick = toggleLimit(pick, { group: "doing", value: "working" });
    pick = toggleLimit(pick, { group: "needs", value: "blocked" });
    expect(regionTokenText("Junto", pick)).toBe("Junto, working, idle, blocked, ready for review");
    expect(regionTokenText("Junto", toggleLimit(pick, { group: "doing", value: "idle" }))).toBe("Junto, working, blocked, ready for review");
  });
});

describe("the seats partly inside a region", () => {
  it("say one seat in the singular and several in the plural, with the region's name", () => {
    expect(crossLine("Big", 6)).toBe("6 seats are partly inside Big and are not included.");
    expect(crossLine("Big", 1)).toBe("1 seat is partly inside Big and is not included.");
  });
  it("are said with the confirm when it opens, before what is left out", () => {
    expect(confirmSpoken(12, 0, 2, [crossLine("Big", 6)])).toBe(
      "Send to 12 seats? Each gets its own thread. 6 seats are partly inside Big and are not included. 2 are left out: their machine is out of reach right now, so what they are doing is not known.",
    );
    expect(confirmSpoken(1, 0, 0)).toBe("Send to 1 seat? Each gets its own thread.");
  });
});

describe("the confirm and the receipt", () => {
  it("say the second sentence only when some get it later", () => {
    expect(confirmDetail(0)).toBe("Each gets its own thread.");
    expect(confirmDetail(1)).toBe("Each gets its own thread. 1 gets it when it is back.");
    expect(confirmDetail(3)).toBe("Each gets its own thread. 3 get it when they are back.");
  });
  it("count the left-out seats", () => {
    expect(leftOutLine(2)).toBe("2 are left out: their machine is out of reach right now, so what they are doing is not known.");
    expect(leftOutLine(1)).toContain("1 is left out: its machine");
  });
  it("groups names by region in the order given", () => {
    const groups = groupByRegion([seat("a"), seat("b"), seat("c")], (id) => (id === "b" ? "Two" : "One"));
    expect(groups.map((group) => [group.region, group.seats.map((s) => s.nodeId)])).toEqual([["One", ["a", "c"]], ["Two", ["b"]]]);
  });
  it("reads a send as three counted lines", () => {
    const receipt = broadcastReceipt([seat("a"), seat("b"), seat("c"), seat("d")], {
      sent: [
        { seatId: "a", arrival: "arrived" },
        { seatId: "b", arrival: "waiting" },
        { seatId: "c", arrival: "arrived" },
      ],
      failed: [{ seatId: "d", message: "Not reachable." }],
    });
    expect([receipt.notSent.length, receipt.have.length, receipt.later.length]).toEqual([1, 2, 1]);
    expect(receipt.reasons).toEqual([{ reason: "Not reachable.", names: "@d" }]);
    expect(broadcastReceiptSpoken(receipt)).toBe("1 not sent. 2 have it. 1 get it when they are back.");
  });
});
