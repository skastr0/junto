/**
 * The plan for the proof's 1x factory board, hashed: every strand and every
 * route path. The digest is the pre-index plan, rebaselined only for two
 * standalone routes whose fourth growth the index now walks locally instead
 * of over every card (acc8d5f09):
 *
 *   wire-96  same length (1915), one corner chosen at the other of two
 *            equal-cost points (x 2022 -> 1992 on the same leg);
 *   wire-939 shorter by 288 units (2578 -> 2290), three corners more.
 *
 * Any other change to a path fails here. The 60-strand synthetic golden
 * (loom-parity.json) covers the fan planner separately.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planLoom } from "../src/window/lib/wire-loom";
import { routesForTick } from "../src/window/lib/loom-view";
import { factoryBoard, factoryFixturePath } from "./loom-factory-board";

const golden = JSON.parse(readFileSync(join(__dirname, "fixtures/loom-factory-parity.json"), "utf8")) as {
  readonly edges: number;
  readonly obstacles: number;
  readonly strands: number;
  readonly routes: number;
  readonly digest: string;
};

// The board is the operator's, read from a scratch fixture that never enters
// the repo; the golden is only its digest.
const hasFixture = existsSync(factoryFixturePath());

describe("the factory board's plan", () => {
  it.skipIf(!hasFixture)("keeps every strand and every route path, but the two the local growth shortened", () => {
    const board = factoryBoard();
    const plan = planLoom({ edges: board.edges, obstacles: board.obstacles });
    const { routes } = routesForTick({
      dragging: new Set<string>(),
      edges: board.edges,
      obstacles: board.obstacles,
      strandIds: new Set(plan.strands.keys()),
    });
    const strands = [...plan.strands.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const routeEntries = [...routes.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    expect(board.edges.length).toBe(golden.edges);
    expect(board.obstacles.length).toBe(golden.obstacles);
    expect(strands.length).toBe(golden.strands);
    expect(routeEntries.length).toBe(golden.routes);
    expect(createHash("sha256").update(JSON.stringify({ strands, routes: routeEntries })).digest("hex")).toBe(golden.digest);
  });
});
