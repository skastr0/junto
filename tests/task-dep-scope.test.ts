import { describe, expect, it } from "vitest";
import { dependencyScopeNodeIds } from "../src/shared/task-dep-scope";
import { canvasOf, region, taskBoard } from "./support/model-nodes";

// Two sibling regions inside one outer region; a board in each, one in the
// outer region, and one loose on the root.
const at = (x: number, y: number) => ({ x, y, width: 100, height: 40 });
const canvas = canvasOf([
  region("outer", { x: 0, y: 0, width: 1000, height: 600 }),
  region("left", { x: 20, y: 20, width: 400, height: 400 }),
  region("right", { x: 520, y: 20, width: 400, height: 400 }),
  taskBoard("mine", at(40, 40)),
  taskBoard("neighbour", at(200, 40)),
  taskBoard("theirs", at(540, 40)),
  taskBoard("parent", at(450, 500)),
  taskBoard("loose", at(2000, 2000)),
]);

const scope = (sink: string) => [...dependencyScopeNodeIds(canvas, sink)].sort();

describe("task dependency scope is region reach", () => {
  it("a board reaches its own region and every region around it, never a sibling", () => {
    expect(scope("mine")).toEqual(["loose", "mine", "neighbour", "parent"]);
  });

  it("a board in the outer region reaches both regions inside it", () => {
    expect(scope("parent")).toEqual(["loose", "mine", "neighbour", "parent", "theirs"]);
  });

  it("a loose board is on one line with every board", () => {
    expect(scope("loose")).toEqual(["loose", "mine", "neighbour", "parent", "theirs"]);
  });

  it("a sink that is not on the canvas has no scope", () => {
    expect(scope("gone")).toEqual([]);
  });
});
