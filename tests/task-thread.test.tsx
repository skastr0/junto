import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "../src/shared/work-model";
import {
  buildTaskThread,
  TaskThread,
} from "../src/renderer/components/work/TaskThread";

const task: Task = {
  id: "task-1",
  state: "working",
  claimedBy: `seat_${"a".repeat(64)}` as Task["claimedBy"],
  history: [
    {
      messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      role: "user",
      parts: [{ kind: "text", text: "Ship the thread" }],
      taskId: "task-1",
    },
    {
      messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      role: "agent",
      parts: [{ kind: "text", text: `claimed by seat_${"a".repeat(64)}` }],
      taskId: "task-1",
    },
    {
      messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      role: "agent",
      parts: [{ kind: "text", text: 'defect from "review": Missing proof' }],
      taskId: "task-1",
    },
    {
      messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
      role: "user",
      parts: [
        { kind: "text", text: "Use the signed receipt" },
        { kind: "url", url: "https://example.com/proof" },
      ],
      taskId: "task-1",
      metadata: {
        taskComment: true,
        fromSeat: "operator",
        "vellum.taskThread.kind": "comment",
      },
    },
  ],
};

describe("TaskThread", () => {
  it("derives chronological kinds and stable attribution from one task history", () => {
    const entries = buildTaskThread(task, {
      seat: () => "Builder One",
      node: (nodeId) => (nodeId === "review" ? "Review" : undefined),
    });

    expect(entries.map(({ kind }) => kind)).toEqual([
      "brief",
      "update",
      "defect",
      "comment",
    ]);
    expect(entries.map(({ author }) => author)).toEqual([
      "Operator",
      "Builder One",
      "Builder One",
      "Operator",
    ]);
  });

  it("renders the full rail, attachment affordance, times, and compose control", () => {
    const html = renderToStaticMarkup(
      <TaskThread
        task={task}
        pending={false}
        seatName={() => "Builder One"}
        nodeName={(nodeId) => nodeId}
        onComment={vi.fn(async () => true)}
      />,
    );

    expect(html).toContain('aria-label="Task thread"');
    expect(html).toContain('data-kind="brief"');
    expect(html).toContain('data-kind="defect"');
    expect(html).toContain("Builder One");
    expect(html).toContain("https://example.com/proof");
    expect(html).toContain('aria-label="Add a task comment"');
    expect(html.match(/<time/g)).toHaveLength(4);
  });
});
