/**
 * The loom's routes are a property of the board, not of how the router reads
 * it: the indexed plan (nearby cards only) must equal the plan the full scan
 * produced for the same fixture, down to every point and corridor.
 *
 * The golden was written from the pre-index plan (33ed258c8's wire-loom), so a
 * difference here is a route that changed, not a snapshot refreshed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planLoom } from "../src/window/lib/wire-loom";
import { loomParityEdges, loomParityObstacles } from "./loom-parity-fixture";

const golden = JSON.parse(readFileSync(join(__dirname, "fixtures/loom-parity.json"), "utf8"));

describe("loom routing parity", () => {
  it("plans the same strands, corridors and bands as the full-scan plan", () => {
    const plan = planLoom({ edges: loomParityEdges(), obstacles: loomParityObstacles() });
    const out = {
      strands: [...plan.strands.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
      corridors: plan.corridors,
    };
    expect(out).toEqual(golden);
    expect(plan.strands.size).toBe(60);
  });
});
