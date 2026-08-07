import { describe, expect, it } from "vitest";
import type { Task } from "../src/shared/work-model";
import {
  compareTasksByLatestActivityDesc,
  taskActivityNewestFirst,
  taskLatestActivityKey,
} from "../src/shared/task";

const task = (
  id: string,
  messageIds: ReadonlyArray<string>,
): Task => ({
  id,
  state: "completed",
  history: messageIds.map((messageId, index) => ({
    messageId,
    role: index === 0 ? ("user" as const) : ("agent" as const),
    parts: [{ kind: "text" as const, text: index === 0 ? `brief ${id}` : `update ${index}` }],
    taskId: id,
  })),
});

describe("task latest-activity ordering", () => {
  it("uses the last history messageId as the activity key", () => {
    const t = task("01OLDER", ["01OLDER", "01MID", "01NEWEST"]);
    expect(taskLatestActivityKey(t)).toBe("01NEWEST");
  });

  it("sorts tasks newest activity first", () => {
    const older = task("01A", ["01A", "01B"]);
    const newer = task("01C", ["01C", "01Z"]);
    const ordered = [older, newer].sort(compareTasksByLatestActivityDesc);
    expect(ordered.map((t) => t.id)).toEqual(["01C", "01A"]);
  });

  it("lists activity messages newest first (skipping the brief)", () => {
    const t = task("01T", ["01BRIEF", "01U1", "01U2", "01U3"]);
    expect(taskActivityNewestFirst(t).map((m) => m.messageId)).toEqual([
      "01U3",
      "01U2",
      "01U1",
    ]);
  });
});
