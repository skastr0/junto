/**
 * A region's Broadcast reaches every seat whose whole rectangle lies inside
 * it, however close the seats sit to each other: seats that overlap are still
 * members, and a region of 60 seats 170 px apart counts 60, as the same seats
 * 300 px apart do. Membership is geometry and nothing lays seats out on its
 * own, so only a seat the region does not wholly hold is missed.
 */
import { describe, expect, it } from "vitest";
import { regionMembers } from "../src/shared/model/canvas";
import { broadcastSet } from "../src/shared/broadcast";
import { canvasOf, region, seat } from "./support/model-nodes";
import { THIS_MACHINE } from "./support/machines";

const SEAT = { width: 240, height: 96 } as const;
const COLUMNS = 10;

/** `count` seats in `COLUMNS` columns, `gap` apart (left edge to left edge, top edge to top edge), from (60, 80). */
const grid = (count: number, gap: number, rowGap = 160) =>
  Array.from({ length: count }, (_, i) => seat(`s${String(i).padStart(2, "0")}`, { x: 60 + (i % COLUMNS) * gap, y: 80 + Math.floor(i / COLUMNS) * rowGap, ...SEAT }));

const reach = (nodes: ReturnType<typeof grid>, regionFrame: { x: number; y: number; width: number; height: number }) => {
  const canvas = canvasOf([region("r-big", regionFrame, { label: "Big" }), ...nodes]);
  const read = broadcastSet({
    canvasName: "factory",
    canvas,
    machineName: THIS_MACHINE,
    picks: [{ kind: "region", regionId: "r-big", doing: [], needs: [] }],
    readingOf: () => ({ needs: [] }),
  });
  return { canvas, read };
};

describe("a region of many close seats", () => {
  it.each([170, 300])("counts all 60 seats %i px apart, overlapping or not", (gap) => {
    const { read } = reach(grid(60, gap), { x: 0, y: 0, width: 3200, height: 1100 });
    expect(read.count).toBe(60);
    expect(read.picks).toEqual([{ count: 60, unread: 0 }]);
  });

  it("reaches the same seats at 170 px as at 300 px", () => {
    const close = reach(grid(60, 170), { x: 0, y: 0, width: 3200, height: 1100 }).read.seats.map((one) => one.nodeId);
    const wide = reach(grid(60, 300), { x: 0, y: 0, width: 3200, height: 1100 }).read.seats.map((one) => one.nodeId);
    expect(close).toEqual(wide);
  });

  it("misses a seat the region does not wholly hold, and only that seat", () => {
    // The tenth column's right edge at 170 px is 60 + 9 * 170 + 240 = 1830: a region 1800 wide drops it, in every row.
    const { canvas, read } = reach(grid(60, 170), { x: 0, y: 0, width: 1800, height: 1100 });
    expect(read.count).toBe(54);
    const members = regionMembers(canvas, canvas.nodes.get("r-big" as never) as never);
    expect(members.length).toBe(54);
  });
});
