/**
 * Today's reach of a comment on a resource (plan 0.10 02, item (1)): a
 * comment is a `message.append` held at the resource's own node, which holds
 * no seat. It crosses to the machine that edits the canvas and nowhere else,
 * so a third machine never holds a task's thread, even when its seat is the
 * task's assignee. That seat hears of a comment only through the notice in
 * its own mailbox. Item (1) makes comments ruled thread facts that cross like
 * resource facts; this test is the baseline it turns over.
 */
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import { InstallationId } from "../src/shared/installation-id";
import { ExchangeFact, entitledTo, writtenByItsAuthor, type CanvasPlacement } from "../src/shared/work-exchange";
import { WORK_PROTOCOL } from "../src/shared/work-protocol";

const id = Schema.decodeUnknownSync(InstallationId);
const editor = id("macbook");
const mini = id("mini");
const other = id("other-mini");
const timestamp = "2026-10-21T12:00:00.000Z";
const seat = (digit: string) => Schema.decodeUnknownSync(ActorSeatId)(`seat_${digit.repeat(64)}`);

/** `lead` on the editing machine, `peer` on the mini, `far` on a third machine; `task-1` holds no seat. */
const placement: CanvasPlacement = {
  canvasId: "canvas-factory",
  editor,
  holds: (machine) => machine === editor || machine === mini || machine === other,
  seatOf: (nodeId) =>
    ({
      lead: { seatId: seat("1"), machine: editor },
      peer: { seatId: seat("2"), machine: mini },
      far: { seatId: seat("3"), machine: other },
    })[nodeId],
};

const lead = { seatId: seat("1"), nodeId: "lead" };
const peer = { seatId: seat("2"), nodeId: "peer" };

const row = (writer: string, sentBy: { seatId: string; nodeId: string }, sink: string, seq = "1") =>
  Schema.decodeUnknownSync(ExchangeFact, { onExcessProperty: "error" })({
    protocol: WORK_PROTOCOL,
    id: { route: { eventHome: writer, entityHome: writer }, seq },
    recordType: "fact",
    basis: { kind: "canvas", canvasName: "factory", seq: 7 },
    item: { kind: "message", itemId: `comment-${seq}`, sink: { canvasName: "factory", nodeId: sink } },
    operation: "message.append",
    contentSha256: "a".repeat(64),
    originAt: timestamp,
    predecessor: null,
    body: {
      operation: "message.append",
      message: { messageId: `comment-${seq}`, role: "user", parts: [{ kind: "text", text: "looks good" }] },
      sentBy: { ...sentBy, canvasName: "factory" },
      destination: { kind: "mailbox" },
    },
  });

const reach = (fact: ExchangeFact) => [editor, mini, other].filter((machine) => entitledTo(machine, fact, placement));

describe("a comment on a task, as it crosses today", () => {
  it("is a row the exchange carries, written where its author lives", () => {
    const comment = row(mini, peer, "task-1");
    expect(Result.isSuccess(Schema.decodeUnknownResult(ExchangeFact)(comment))).toBe(true);
    expect(writtenByItsAuthor(comment, placement)).toBe(true);
  });

  it("reaches the editing machine only: a third machine never holds the thread, even the assignee's", () => {
    expect(reach(row(mini, peer, "task-1"))).toEqual([editor]);
    expect(reach(row(editor, lead, "task-1"))).toEqual([editor]);
  });

  it("tells the third machine's seat only through the notice the commenter's machine writes into its mailbox", () => {
    // subject-comment.ts: the commenter's own machine writes the notice, as the commenter.
    const notice = row(mini, peer, "far", "2");
    expect(writtenByItsAuthor(notice, placement)).toBe(true);
    expect(reach(notice)).toEqual([editor, other]);
  });
});
