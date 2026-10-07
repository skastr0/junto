import { describe, expect, it } from "vitest";
import type { Task } from "../src/shared/work-model";
import { retainClaimedTask } from "../src/main/junto/kernel/service";
import type { World } from "../src/main/junto/kernel/world";
import { canvasOf, taskBoard, worldOf } from "./support/model-nodes";

const task = (id: string, state: string): Task => ({ id, state }) as unknown as Task;

const world = () =>
  new Map<string, World>([
    [
      "factory",
      worldOf(canvasOf([taskBoard("a"), taskBoard("b")]), {
        tasks: new Map([
          ["a", [task("t1", "submitted"), task("t2", "submitted")]],
          ["b", [task("t1", "submitted")]],
        ]),
      }),
    ],
  ]);

const stateAt = (held: Map<string, World>, boardId: string, taskId: string) =>
  held
    .get("factory")
    ?.work.tasks.get(boardId)
    ?.find((item) => item.id === taskId)?.state;

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
