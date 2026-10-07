import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { Task } from "../src/shared/work-model";
import { retainClaimedTask } from "../src/main/junto/kernel/service";

const task = (id: string, state: string): Task => ({ id, state }) as unknown as Task;

const board = (id: string, items: ReadonlyArray<Task>) => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  ether: { entity: { kind: "task" }, tasks: { items } },
});

const world = () =>
  new Map<string, CanvasDoc>([
    [
      "factory",
      {
        nodes: [board("a", [task("t1", "submitted"), task("t2", "submitted")]), board("b", [task("t1", "submitted")])],
        edges: [],
      } as unknown as CanvasDoc,
    ],
  ]);

const stateAt = (docs: Map<string, CanvasDoc>, boardId: string, taskId: string) =>
  docs
    .get("factory")
    ?.nodes.find((node) => node.id === boardId)
    ?.ether?.tasks?.items.find((item) => item.id === taskId)?.state;

describe("the kernel keeps a claimed row", () => {
  it("replaces that board's row and no other", () => {
    const docs = world();
    const before = docs.get("factory");
    expect(retainClaimedTask(docs, "factory", "a", task("t1", "working"))).toBe(true);
    expect(stateAt(docs, "a", "t1")).toBe("working");
    expect(stateAt(docs, "a", "t2")).toBe("submitted");
    expect(stateAt(docs, "b", "t1")).toBe("submitted");
    expect(docs.get("factory")).not.toBe(before);
  });

  it("leaves the world alone when the canvas, board or row is not held", () => {
    const docs = world();
    const before = docs.get("factory");
    expect(retainClaimedTask(docs, "elsewhere", "a", task("t1", "working"))).toBe(false);
    expect(retainClaimedTask(docs, "factory", "c", task("t1", "working"))).toBe(false);
    expect(retainClaimedTask(docs, "factory", "a", task("t9", "working"))).toBe(false);
    expect(docs.get("factory")).toBe(before);
  });
});
