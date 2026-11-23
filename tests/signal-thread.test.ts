/**
 * The one rule for a signal raised in a thread (src/shared/signal-thread.ts):
 * the seat's own mailbox holds a row the operator wrote in that thread, by
 * its stored author, and the thread is in no task or resource thread.
 */
import { describe, expect, it } from "vitest";
import { signalThreadFault, type SignalThreadRow } from "../src/shared/signal-thread";
import { threadSubjectMetadata } from "../src/shared/thread-subject";
import { OPERATOR_SEAT_ID } from "../src/shared/work-reference";

const ROOT = "01M857SMVM9K9YCVYSA8GWQ7Y8";
const OTHER = "01M857EC19KCM7BP9NQXDY87S4";
const PEER = `seat_${"2".repeat(64)}`;
const SELF = `seat_${"1".repeat(64)}`;

/** A row in the seat's mailbox: `thread` names its thread, absent for a row that starts its own. */
const row = (messageId: string, actorSeatId: string, thread?: string, metadata: Record<string, unknown> = {}): SignalThreadRow => ({
  messageId,
  actorSeatId,
  metadata: { ...(thread === undefined ? {} : { threadId: thread }), ...metadata },
});

describe("a signal raised in a thread", () => {
  const table: ReadonlyArray<readonly [string, ReadonlyArray<SignalThreadRow>, ReturnType<typeof signalThreadFault>]> = [
    ["the operator started the thread", [row(ROOT, OPERATOR_SEAT_ID)], undefined],
    [
      "a seat started it and the operator wrote in it later",
      [row(ROOT, PEER), row("01M857SMVM9K9YCVYSA8GWQ7Y9", OPERATOR_SEAT_ID, ROOT)],
      undefined,
    ],
    ["only seats wrote in it", [row(ROOT, PEER), row("01M857SMVM9K9YCVYSA8GWQ7YA", SELF, ROOT)], "no_operator_row"],
    ["the operator wrote only in another thread", [row(ROOT, PEER), row(OTHER, OPERATOR_SEAT_ID)], "no_operator_row"],
    ["the mailbox holds no row of it", [], "no_operator_row"],
    [
      "a row says it is the operator's, but its stored author is a seat",
      [row(ROOT, PEER, undefined, { fromSeat: OPERATOR_SEAT_ID, senderName: "operator" })],
      "no_operator_row",
    ],
    [
      "the operator wrote in it, and it is a task's thread",
      [row(ROOT, OPERATOR_SEAT_ID, undefined, threadSubjectMetadata({ kind: "task", nodeId: "board", taskId: "01M5ESR42S7P9YNR8FEH0TD2QC" } as never))],
      "subject_thread",
    ],
  ];

  it.each(table)("%s", (_case, mailbox, fault) => {
    expect(signalThreadFault(ROOT, mailbox)).toBe(fault);
  });
});
