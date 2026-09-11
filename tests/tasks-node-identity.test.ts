import { describe, expect, it } from "vitest";
import type { TextNode } from "../src/shared/canvas";
import {
  tasksNodeIdentity,
  tasksNodeName,
} from "../src/shared/tasks-node-identity";

const board = (
  text: string,
  instructions?: string,
  id = "task-01M0BOARD12345678",
  name?: string,
): TextNode => ({
  id,
  type: "text",
  text,
  x: 0,
  y: 0,
  width: 220,
  height: 84,
  ether: {
    entity: { kind: "task" },
    tasks: {
      items: [],
      ...(name ? { name } : {}),
      ...(instructions ? { contract: { instructions } } : {}),
    },
  },
});

describe("Tasks-node identity", () => {
  it("uses the authored Tasks name instead of the mutable text mirror", () => {
    const identity = tasksNodeIdentity(
      board("first task\nsecond task", "Turn intent into proof.", undefined, "  Build  "),
    );
    expect(identity).toEqual({
      name: "Build",
      source: "name",
    });
  });

  it("falls back to instructions without an authored Tasks name", () => {
    expect(
      tasksNodeName(board("tasks", "Review release evidence before shipping.")),
    ).toBe("Review release evidence before shipping.");
  });

  it("uses a short id and teaches how to name the board when no name or instructions exist", () => {
    expect(tasksNodeIdentity(board("tasks", undefined))).toEqual({
      name: "Tasks 12345678",
      source: "id",
      namingHint: "Name this node to name the board.",
    });
  });

  it("resolves missing boards through the same short-id fallback", () => {
    expect(tasksNodeName(undefined, "missing-board-ABCDEF12")).toBe("Tasks ABCDEF12");
  });

  it("does not stack the Tasks prefix on a generic id", () => {
    for (const generic of ["task", "tasks", "TASKS", " tasks "]) {
      expect(tasksNodeIdentity(board("tasks", undefined, generic)).name).toBe("Tasks");
      expect(tasksNodeIdentity(undefined, generic).name).toBe("Tasks");
    }
  });

  it("keeps the id suffix for meaningful short ids", () => {
    expect(tasksNodeIdentity(board("tasks", undefined, "qa")).name).toBe("Tasks qa");
    expect(tasksNodeIdentity(undefined, "build").name).toBe("Tasks build");
  });
});
