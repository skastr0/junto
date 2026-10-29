/**
 * A feed card's sentence, cut for its task chips (0.11.4, task 378): a seat
 * writes "#42" and the card opens task 42, but only when the canvas holds
 * that number. Every other #, and every number the canvas does not hold,
 * stays a word.
 */
import { expect, it } from "vitest";
import { feedTasksByNumber, feedTextPieces, type FeedTaskRef } from "../src/renderer/components/feed/feed-text";

const task = (number: number | undefined, title: string, nodeId = "board"): { taskId: string; number?: number; title: string; current: { node: string } } => ({
  taskId: `task-${title}`,
  title,
  current: { node: nodeId },
  ...(number === undefined ? {} : { number }),
});

const REF: FeedTaskRef = { nodeId: "board", taskId: "task-fix tabs", title: "fix tabs" };
const refs = new Map<number, FeedTaskRef>([[42, REF]]);

it("leaves the sentence one piece when no task is known", () => {
  expect(feedTextPieces("Ship #42 today", undefined)).toEqual([{ kind: "text", text: "Ship #42 today" }]);
  expect(feedTextPieces("Ship #42 today", new Map())).toEqual([{ kind: "text", text: "Ship #42 today" }]);
  expect(feedTextPieces("", refs)).toEqual([]);
});

it("cuts a number the canvas holds into a task piece, with the words around it", () => {
  expect(feedTextPieces("Ship #42 today", refs)).toEqual([
    { kind: "text", text: "Ship " },
    { kind: "task", number: 42, task: REF },
    { kind: "text", text: " today" },
  ]);
  expect(feedTextPieces("#42 is ready", refs)).toEqual([
    { kind: "task", number: 42, task: REF },
    { kind: "text", text: " is ready" },
  ]);
  expect(feedTextPieces("blocked on (#42).", refs)).toEqual([
    { kind: "text", text: "blocked on (" },
    { kind: "task", number: 42, task: REF },
    { kind: "text", text: ")." },
  ]);
});

it("keeps a number the canvas does not hold, and every other word, as words", () => {
  expect(feedTextPieces("Ship #43 today", refs)).toEqual([{ kind: "text", text: "Ship #43 today" }]);
  for (const text of ["issue #42a", "a#42", "path/#42", "#42nd place"]) {
    expect(feedTextPieces(text, refs)).toEqual([{ kind: "text", text }]);
  }
});

it("cuts every number it knows, in order", () => {
  const both = new Map<number, FeedTaskRef>([[42, REF], [7, { nodeId: "board", taskId: "task-7", title: "ship" }]]);
  expect(feedTextPieces("#7 and #42", both)).toEqual([
    { kind: "task", number: 7, task: { nodeId: "board", taskId: "task-7", title: "ship" } },
    { kind: "text", text: " and " },
    { kind: "task", number: 42, task: REF },
  ]);
});

it("indexes tasks by number, and leaves a task still waiting for its number out", () => {
  const byNumber = feedTasksByNumber([task(undefined, "unruled"), task(42, "fix tabs")]);
  expect([...byNumber.keys()]).toEqual([42]);
  expect(byNumber.get(42)).toEqual(REF);
});
