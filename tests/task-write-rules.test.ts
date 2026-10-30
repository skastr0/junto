/**
 * A task write is refused in words before it leaves the window when it is
 * over a wire bound, and any write main refuses at its own boundary comes
 * back as a refusal rather than a rejected promise (0.12: a 240-character
 * retitle vanished from the pane, found by product-verify).
 */
import { expect, it, vi } from "vitest";
import { TASK_TITLE_MAX_LENGTH } from "../src/shared/task-control";
import { mintItemId } from "../src/shared/resource-command";
import { taskNodeId, type TaskCommand, type TaskId } from "../src/shared/task-model";
import { asNodeId } from "../src/shared/model";
import { makeIpcTasksSource } from "../src/renderer/lib/tasks-source";
import { taskWriteRefusalOf } from "../src/renderer/lib/task-write-rules";

const taskId = mintItemId() as TaskId;

it("refuses a title over the wire's bound in words, for a create and an edit", () => {
  const long = "x".repeat(TASK_TITLE_MAX_LENGTH + 1);
  expect(taskWriteRefusalOf({ kind: "create", taskId, title: long })).toBe(
    `A title is at most ${TASK_TITLE_MAX_LENGTH} characters.`,
  );
  expect(taskWriteRefusalOf({ kind: "edit", title: long })).toBe(`A title is at most ${TASK_TITLE_MAX_LENGTH} characters.`);
});

it("lets a title at the bound through, and says nothing of other commands", () => {
  expect(taskWriteRefusalOf({ kind: "create", taskId, title: "x".repeat(TASK_TITLE_MAX_LENGTH) })).toBeUndefined();
  expect(taskWriteRefusalOf({ kind: "edit", title: "short" })).toBeUndefined();
  expect(taskWriteRefusalOf({ kind: "edit", body: "no title here" })).toBeUndefined();
  expect(taskWriteRefusalOf({ kind: "start" })).toBeUndefined();
});

it("answers a write main refuses at its boundary as a refusal, not a rejection", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const source = makeIpcTasksSource({
    list: async () => [],
    all: async () => [],
    context: async () => ({ downstream: () => [], stampDefaultOf: () => ({ required: 0 }), seatReaches: () => false }),
    apply: async () => {
      throw new Error("Expected a value with a length of at least 1 at [title]");
    },
    pending: async () => [],
    onChanged: () => () => undefined,
  });
  const ruling = await source.apply("factory", taskNodeId(asNodeId("board")), taskId, { kind: "start" } as TaskCommand);
  expect(ruling).toEqual({ ok: false, message: "The task could not be changed." });
});
