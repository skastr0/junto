import { describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/model";
import type { ArtifactHead } from "../src/shared/resource-ipc";
import type { TaskView } from "../src/shared/task-model";
import { mentionItemsOf } from "../src/renderer/lib/mention-items";

// Only the fields mentionItemsOf reads.
const task = (taskId: string, node: string, state: string, number?: number): TaskView =>
  ({ taskId, title: `task ${taskId}`, ...(number === undefined ? {} : { number }), current: { state, node } }) as unknown as TaskView;

const artifact = (artifactId: string, nodeId: string, archived = false): ArtifactHead =>
  ({ artifact: { artifactId, nodeId, title: `doc ${artifactId}`, archived } }) as unknown as ArtifactHead;

describe("mention items", () => {
  it("groups tasks by their board, numbered with their state, and leaves archived ones out", () => {
    const items = mentionItemsOf([task("a", "T1", "working", 42), task("b", "T1", "archived", 43), task("c", "T2", "backlog")], []);
    expect(items.tasksOf?.(asNodeId("T1"))).toEqual([{ id: "a", title: "task a", number: 42, note: "working" }]);
    expect(items.tasksOf?.(asNodeId("T2"))).toEqual([{ id: "c", title: "task c", note: "backlog" }]);
    expect(items.tasksOf?.(asNodeId("T3"))).toEqual([]);
  });

  it("groups artifacts by their node and leaves archived ones out", () => {
    const items = mentionItemsOf([], [artifact("x", "R1"), artifact("y", "R1", true), artifact("z", "R2")]);
    expect(items.artifactsOf?.(asNodeId("R1"))).toEqual([{ id: "x", title: "doc x" }]);
    expect(items.artifactsOf?.(asNodeId("R2"))).toEqual([{ id: "z", title: "doc z" }]);
  });
});
