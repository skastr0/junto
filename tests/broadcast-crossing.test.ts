/**
 * Seats that straddle a chosen region's edge (the frame overlaps the region's
 * but is not wholly inside it) are not members, so they are not in the send;
 * the set tells them apart per region so the confirm can say so. The nodes
 * that cross come from the model (`regionCrossers`), handed in.
 */
import { describe, expect, it } from "vitest";
import { broadcastSet, type BroadcastPick } from "../src/shared/broadcast";
import { canvasOf, region, seat } from "./support/model-nodes";
import { THIS_MACHINE } from "./support/machines";

const box = (x: number, y: number) => ({ x, y, width: 100, height: 40 });
const canvas = canvasOf([
  region("r-big", { x: 0, y: 0, width: 500, height: 500 }, { label: "Big" }),
  region("r-small", { x: 600, y: 0, width: 300, height: 300 }, { label: "Small" }),
  seat("s-in", box(100, 100)),
  seat("s-edge-1", box(450, 100)),
  seat("s-edge-2", box(450, 300)),
  seat("s-small", box(650, 100)),
]);

const pick = (regionId: string): BroadcastPick => ({ kind: "region", regionId, doing: [], needs: [] });
/** What the model says crosses each region's edge, in its order. */
const crossers: Record<string, ReadonlyArray<string>> = { "r-big": ["s-edge-1", "s-edge-2", "r-small"], "r-small": ["s-edge-2"] };
const read = (picks: ReadonlyArray<BroadcastPick>, more: { leaveOut?: string; without?: true } = {}) =>
  broadcastSet({
    canvasName: "factory",
    canvas,
    machineName: THIS_MACHINE,
    picks,
    readingOf: () => ({ needs: [] }),
    ...(more.without === true ? {} : { crossersOf: (node) => (crossers[node.id] ?? []).flatMap((id) => canvas.nodes.get(id as never) ?? []) }),
    ...(more.leaveOut === undefined ? {} : { leaveOut: more.leaveOut }),
  });
const names = (set: ReturnType<typeof read>) => set.crossing.map((entry) => [entry.regionId, entry.seats.map((one) => one.nodeId)]);

describe("the seats that cross a chosen region's edge", () => {
  it("are told apart per region, only seats, and are not in the send", () => {
    const set = read([pick("r-big")]);
    expect(set.seats.map((one) => one.nodeId)).toEqual(["s-in"]);
    expect(names(set)).toEqual([["r-big", ["s-edge-1", "s-edge-2"]]]);
  });

  it("is said per region, in the order picked, and a region picked twice is said once", () => {
    const set = read([pick("r-small"), pick("r-big"), pick("r-small")]);
    expect(names(set)).toEqual([
      ["r-small", ["s-edge-2"]],
      ["r-big", ["s-edge-1", "s-edge-2"]],
    ]);
  });

  it("leaves out a seat the choice reaches another way: it is included, so it does not cross", () => {
    const set = read([pick("r-big"), { kind: "seat", nodeId: "s-edge-2" }]);
    expect(set.seats.map((one) => one.nodeId).sort()).toEqual(["s-edge-2", "s-in"]);
    expect(names(set)).toEqual([["r-big", ["s-edge-1"]]]);
  });

  it("names no region when nothing crosses, or when the model is not asked, and never the overseer's own seat", () => {
    expect(names(read([pick("r-small")], { leaveOut: "s-edge-2" }))).toEqual([]);
    expect(names(read([pick("r-big")], { without: true }))).toEqual([]);
    expect(names(read([{ kind: "seat", nodeId: "s-in" }]))).toEqual([]);
    expect(names(read([pick("r-big")], { leaveOut: "s-edge-1" }))).toEqual([["r-big", ["s-edge-2"]]]);
  });
});
