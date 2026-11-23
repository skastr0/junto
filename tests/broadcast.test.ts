/**
 * The seats a Broadcast choice reaches (src/shared/broadcast.ts): regions
 * hold the seats inside them, nested regions' among them; what a seat is
 * doing and what it needs are read apart; within a limit any, across limits
 * all, nothing chosen no limit; each seat once, in a stable order; a seat no
 * doing limit can read is named apart, never dropped.
 */
import { describe, expect, it } from "vitest";
import { broadcastSet, seatReading, type BroadcastPick, type SeatDoing, type SeatNeed, type SeatReading } from "../src/shared/broadcast";
import type { AgentSignal } from "../src/shared/wire/agent-signals";
import { canvasOf, peer, region, seat } from "./support/model-nodes";
import { THIS_MACHINE } from "./support/machines";

const at = (x: number, y: number) => ({ x, y, width: 100, height: 40 });

// Outer holds Inner; s-a and s-b sit in Outer, s-c in Inner, s-d outside both.
// s-far runs on the mini; p-copy is another machine's seat as a copy holds it.
const nodes = [
  region("r-outer", { x: 0, y: 0, width: 1000, height: 1000 }, { label: "Outer" }),
  region("r-inner", { x: 500, y: 500, width: 400, height: 400 }, { label: "Inner" }),
  seat("s-b", at(100, 100)),
  seat("s-a", at(100, 200)),
  seat("s-c", at(600, 600)),
  seat("s-d", at(2000, 2000)),
  seat("s-far", { ...at(100, 300), host: "mini" as never }),
  peer("p-copy", { ...at(100, 400), host: "mini" as never }),
];
const canvas = canvasOf(nodes);

const readings: Record<string, SeatReading> = {
  "s-a": { doing: "working", needs: ["escalate"] },
  "s-b": { doing: "idle", needs: [] },
  "s-c": { doing: "working", needs: ["feedback", "blocked"] },
  "s-d": { doing: "off", needs: [] },
  "s-far": { needs: [] },
  "p-copy": { doing: "working", needs: [] },
};

const set = (picks: ReadonlyArray<BroadcastPick>, more: { leaveOut?: string; on?: typeof canvas } = {}) =>
  broadcastSet({
    canvasName: "factory",
    canvas: more.on ?? canvas,
    machineName: THIS_MACHINE,
    picks,
    readingOf: (nodeId) => readings[nodeId] ?? { needs: [] },
    ...(more.leaveOut === undefined ? {} : { leaveOut: more.leaveOut }),
  });
const ids = (seats: ReadonlyArray<{ readonly nodeId: string }>) => seats.map((one) => one.nodeId);
const outer = (doing: ReadonlyArray<SeatDoing> = [], needs: ReadonlyArray<SeatNeed> = []): BroadcastPick => ({
  kind: "region",
  regionId: "r-outer",
  doing,
  needs,
});

describe("the seats a region reaches", () => {
  it("holds every seat inside it, a nested region's too, by node id, with no limit", () => {
    const read = set([outer()]);
    expect(ids(read.seats)).toEqual(["p-copy", "s-a", "s-b", "s-c", "s-far"]);
    expect(read.picks).toEqual([{ count: 5, unread: 0 }]);
    expect(read.unread).toEqual([]);
  });

  it("reads what a seat is doing apart from what it needs, so a working seat waiting on you matches both", () => {
    expect(ids(set([outer(["working"], ["escalate"])]).seats)).toEqual(["s-a"]);
    // Within a limit any of the chosen: working or idle.
    expect(ids(set([outer(["working", "idle"], [])]).seats)).toEqual(["p-copy", "s-a", "s-b", "s-c"]);
    // Across limits all: working and ready for review.
    expect(ids(set([outer(["working"], ["feedback"])]).seats)).toEqual(["s-c"]);
    // A needs limit alone: blocked or waiting on you.
    expect(ids(set([outer([], ["blocked", "escalate"])]).seats)).toEqual(["s-a", "s-c"]);
  });

  it("names a seat no doing limit can read apart, and counts it when there is no doing limit", () => {
    const read = set([outer(["working"])]);
    expect(ids(read.seats)).toEqual(["p-copy", "s-a", "s-c"]);
    expect(ids(read.unread)).toEqual(["s-far"]);
    expect(read.picks).toEqual([{ count: 3, unread: 1 }]);
    // A needs limit it does not meet leaves it out plainly, not as unread.
    expect(set([outer(["working"], ["blocked"])]).unread).toEqual([]);
    // Picked as a single seat too, it is in the set and not left out.
    const added = set([outer(["working"]), { kind: "seat", nodeId: "s-far" }]);
    expect(ids(added.seats)).toEqual(["p-copy", "s-a", "s-c", "s-far"]);
    expect(added.unread).toEqual([]);
  });
});

describe("the set a choice reaches", () => {
  it("holds each seat once, in the order picked, with single seats beside regions", () => {
    const read = set([{ kind: "seat", nodeId: "s-d" }, { kind: "region", regionId: "r-inner", doing: [], needs: [] }, outer()]);
    expect(ids(read.seats)).toEqual(["s-d", "s-c", "p-copy", "s-a", "s-b", "s-far"]);
    expect(read.picks.map((pick) => pick.count)).toEqual([1, 1, 5]);
    expect(read.count).toBe(6);
  });

  it("says which seats are not running and which sit on another machine", () => {
    const read = set([outer(), { kind: "seat", nodeId: "s-d" }]);
    const by = new Map(read.seats.map((one) => [one.nodeId, one]));
    expect(by.get("s-a")).toMatchObject({ running: true, elsewhere: false, name: "s-a", canvasName: "factory" });
    expect(by.get("s-d")).toMatchObject({ running: false, elsewhere: false });
    expect(by.get("s-far")).toMatchObject({ running: false, elsewhere: true });
    expect(by.get("p-copy")).toMatchObject({ running: true, elsewhere: true });
    expect(read.notRunning).toBe(2);
    expect(read.elsewhere).toBe(2);
  });

  it("never holds the seat left out, nor a node that is not a seat or not there", () => {
    expect(ids(set([outer()], { leaveOut: "s-a" }).seats)).toEqual(["p-copy", "s-b", "s-c", "s-far"]);
    const read = set([{ kind: "seat", nodeId: "r-inner" }, { kind: "seat", nodeId: "gone" }, { kind: "region", regionId: "s-a", doing: [], needs: [] }]);
    expect(read.seats).toEqual([]);
    expect(read.picks).toEqual([{ count: 0, unread: 0 }, { count: 0, unread: 0 }, { count: 0, unread: 0 }]);
  });

  it("reads the same set whatever order the canvas holds its nodes in", () => {
    const reversed = canvasOf([...nodes].reverse());
    const picks = [outer(["working", "idle"]), { kind: "seat", nodeId: "s-d" } as const];
    expect(set(picks, { on: reversed })).toEqual(set(picks));
  });
});

describe("a seat's reading", () => {
  const signal = (signalId: string, more: Partial<AgentSignal>): AgentSignal => ({
    signalId,
    canvasName: "factory",
    nodeId: "s-a",
    kind: "escalate",
    text: signalId,
    createdAt: 1,
    state: "open",
    ...more,
  });

  it("takes every open signal of the seat's own, and none closed, an automation's, or another seat's", () => {
    const read = seatReading({
      canvasName: "factory",
      nodeId: "s-a",
      event: { state: "working" },
      current: true,
      signals: [
        signal("1", { kind: "escalate" }),
        signal("2", { kind: "feedback" }),
        signal("3", { kind: "escalate" }),
        signal("4", { kind: "blocked", state: "answered" }),
        signal("5", { kind: "blocked", source: { kind: "automation" } as never }),
        signal("6", { kind: "blocked", nodeId: "s-b" }),
        signal("7", { kind: "notice" }),
      ],
    });
    expect(read).toEqual({ doing: "working", needs: ["escalate", "feedback"] });
  });

  it("reads working, idle and off from the seat's state, and nothing when the reading is not current", () => {
    const doing = (state: "idle" | "working" | "attention" | "unknown" | "gone", current = true) =>
      seatReading({ canvasName: "factory", nodeId: "s-a", event: { state }, current, signals: [] }).doing;
    expect(doing("working")).toBe("working");
    expect(doing("attention")).toBe("working");
    expect(doing("idle")).toBe("idle");
    expect(doing("unknown")).toBe("off");
    expect(doing("gone")).toBe("off");
    expect(doing("working", false)).toBeUndefined();
    expect(seatReading({ canvasName: "factory", nodeId: "s-a", event: undefined, current: true, signals: [] }).doing).toBeUndefined();
  });
});
