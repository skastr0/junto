/** A card's glance reads the separately queried work counts. */
import { describe, expect, it } from "vitest";
import { asCanvasName, NODE_KINDS } from "../src/shared/model";
import { holdsWork, kindMayBeBlocked, kindWord, nodeAttention, physicsKind, roleOfKind, taskCounts, type SinkCounts } from "../src/renderer/lib/model-kind";
import type { TaskState, TaskView } from "../src/shared/task-model";
import { canvasOfState } from "../src/renderer/lib/model-store";
import { note } from "./support/model-nodes";

const NOTHING: SinkCounts = { count: 0, needsHuman: false, allTerminal: true };

const glanceOf = (states: ReadonlyArray<string>): SinkCounts => ({
  count: states.length,
  needsHuman: states.some((state) => state === "input-required" || state === "auth-required"),
  allTerminal: states.every((state) => ["completed", "canceled", "failed", "rejected"].includes(state)),
});

describe("a card's glance", () => {
  const queues: ReadonlyArray<ReadonlyArray<string>> = [
    [], ["submitted"], ["working", "input-required"], ["auth-required"], ["completed"], ["completed", "canceled"], ["completed", "working"],
  ];

  it.each(queues)("a task board holding %j follows its work counts", (...states) => {
    const expected = states.length === 0 ? "empty" : states.some(state => ["input-required", "auth-required"].includes(state)) ? "fire" : states.every(state => ["completed", "canceled", "failed", "rejected"].includes(state)) ? "ice" : "idle";
    expect(nodeAttention("task", glanceOf(states), false)).toBe(expected);
  });

  it("artifacts are empty or idle by count", () => {
    expect(nodeAttention("artifacts", glanceOf([]), false)).toBe("empty");
    expect(nodeAttention("artifacts", { count: 2, needsHuman: false, allTerminal: false }, false)).toBe("idle");
  });

  it("only actors can be blocked; other kinds stay idle regardless of a blocked flag", () => {
    for (const kind of ["agent", "terminal", "note", "label", "region"] as const) {
      expect(kindMayBeBlocked(kind)).toBe(kind === "agent");
      expect(nodeAttention(kind, NOTHING, true)).toBe(kind === "agent" ? "fire" : "idle");
      expect(nodeAttention(kind, NOTHING, false)).toBe(kind === "agent" ? "ice" : "idle");
    }
  });
});

describe("kind words", () => {
  it("keeps the words the stylesheet was written with", () => {
    expect(kindWord("note")).toBe("text");
    expect(kindWord("region")).toBe("group");
    expect(kindWord("agent")).toBe("agent");
    expect(kindWord("file")).toBe("file");
  });

  it("gives the verb tables nothing for a card that only sits there", () => {
    for (const kind of ["note", "file", "link", "region"] as const) expect(physicsKind(kind)).toBeUndefined();
    expect(physicsKind("agent")).toBe("agent");
    expect(roleOfKind("agent")).toBe("actor");
    expect(roleOfKind("region")).toBe("geography");
  });

  it("reads work for the two kinds that hold it", () => {
    expect(NODE_KINDS.filter(holdsWork)).toEqual(["task", "artifacts"]);
    expect(holdsWork(undefined)).toBe(false);
  });
});

describe("the canvas the window holds, as shared logic reads it", () => {
  it("has the nodes and wires by id, and the seq", () => {
    const node = note("note", "Note", { z: 3 });
    const canvas = canvasOfState("factory", { seq: 9, nodes: { note: node }, wires: {} });
    expect(canvas.name).toBe(asCanvasName("factory"));
    expect(canvas.seq).toBe(9);
    expect(canvas.nodes.get(node.id)).toBe(node);
    expect(canvas.wires.size).toBe(0);
  });
});

describe("taskCounts", () => {
  const on = (...states: ReadonlyArray<TaskState>) =>
    states.map((state) => ({ current: { state } }) as unknown as TaskView);
  it("counts the tasks on a node and how they stand", () => {
    expect(taskCounts(undefined)).toEqual({ count: 0, needsHuman: false, allTerminal: false });
    expect(taskCounts(on("working", "input-required"))).toEqual({ count: 2, needsHuman: true, allTerminal: false });
    expect(taskCounts(on("done", "canceled"))).toEqual({ count: 2, needsHuman: false, allTerminal: true });
    expect(nodeAttention("task", taskCounts(on("input-required")), false)).toBe("fire");
    expect(nodeAttention("task", taskCounts(on("done")), false)).toBe("ice");
    expect(nodeAttention("task", taskCounts(undefined), false)).toBe("empty");
  });
});
