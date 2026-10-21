/**
 * Subject threads and their notices: the subject a row carries reads back as
 * written, a bad one reads as mailbox mail, and a notice's id is derived from
 * its cause so a second write is the same row.
 */
import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { isMailMessageId, mailThreadOf, type MailMessageId, type MailSenderStamp } from "../src/shared/crew";
import { asNodeId, type NodeId } from "../src/shared/physics/schema";
import {
  noticeTakesReply,
  refusalText,
  subjectNoticeId,
  subjectNoticeKindOf,
  subjectNoticeRecipients,
  subjectNoticeRow,
  type SubjectNoticeInput,
  type SubjectNoticeKind,
} from "../src/shared/subject-notice";
import {
  Anchor,
  LINES_FILE_MAX,
  sameSubject,
  subjectLabel,
  subjectAnchorOf,
  subjectNodeOf,
  threadSubjectMetadata,
  threadSubjectOf,
  type ResourceSubject,
  type ThreadSubject,
} from "../src/shared/thread-subject";
import { ItemId, OpId } from "../src/shared/work-ids";

const TASK_ID = ItemId.make("01M5ESKX20QX0HA3Y6SHEPXBCX");
const OP_ID = OpId.make("01M5ESMJV6GNZ0891YFFWS0S3P");
const THREAD = "01M5ESQ6X9VS1GKZHNAS6BKJ49" as MailMessageId;
const BOARD = asNodeId("task-board");
const SEAT_A = asNodeId("agent-a");
const SEAT_B = asNodeId("agent-b");
const task: ResourceSubject = { kind: "task", nodeId: BOARD, taskId: TASK_ID };

const sender: MailSenderStamp = {
  fromSeat: "seat_a" as MailSenderStamp["fromSeat"],
  senderNodeId: SEAT_A,
  senderName: "pty-a",
  senderGeneration: "ep_1",
  senderHarness: "claude",
};

describe("thread subject", () => {
  it("reads back the subject a row carries", () => {
    const subjects: ReadonlyArray<ResourceSubject> = [
      task,
      { kind: "artifact", nodeId: BOARD, artifactId: TASK_ID, anchor: { kind: "text", quote: "the cap", offset: 4 } },
      { kind: "page", nodeId: BOARD, anchor: { kind: "lines", file: "a.ts", from: 3, to: 9 } },
      { kind: "page", nodeId: BOARD, anchor: { kind: "box", x: 1, y: 2, w: 3, h: 4, url: "https://x" } },
    ];
    for (const subject of subjects) {
      const metadata = JSON.parse(JSON.stringify(threadSubjectMetadata(subject))) as Record<string, unknown>;
      expect(threadSubjectOf({ metadata })).toEqual(subject);
    }
  });

  it("reads a row with no subject, or one that does not decode, as mailbox mail", () => {
    expect(threadSubjectOf({})).toBeUndefined();
    expect(threadSubjectOf({ metadata: { threadSubject: { kind: "task", nodeId: BOARD, taskId: "not-a-ulid" } } })).toBeUndefined();
    expect(threadSubjectOf({ metadata: { threadSubject: { kind: "mailbox", seat: SEAT_A } } })).toBeUndefined();
    expect(threadSubjectOf({ metadata: { threadSubject: { ...task, extra: 1 } } })).toBeUndefined();
  });

  it("refuses an anchor with no extent: lines that end before they start, a box with no area, cells not in A1", () => {
    const isAnchor = Schema.is(Anchor);
    expect(isAnchor({ kind: "lines", file: "a.ts", from: 9, to: 3 })).toBe(false);
    expect(isAnchor({ kind: "lines", file: "a.ts", from: 3, to: 3 })).toBe(true);
    expect(isAnchor({ kind: "box", x: 0, y: 0, w: 0, h: 4 })).toBe(false);
    expect(isAnchor({ kind: "box", x: 0, y: 0, w: 1, h: 4 })).toBe(true);
    expect(isAnchor({ kind: "cells", range: "B2" })).toBe(true);
    expect(isAnchor({ kind: "cells", range: "A1:C4" })).toBe(true);
    expect(isAnchor({ kind: "cells", range: "C4:A1" })).toBe(false);
    expect(isAnchor({ kind: "cells", range: "row 2" })).toBe(false);
  });

  it("spells the whole resource one way: no anchor", () => {
    expect(subjectAnchorOf({ kind: "whole" })).toBeUndefined();
    expect(subjectAnchorOf({ kind: "cells", range: "B2" })).toEqual({ kind: "cells", range: "B2" });
    const whole = { kind: "artifact", nodeId: BOARD, artifactId: TASK_ID, anchor: { kind: "whole" } };
    expect(threadSubjectOf({ metadata: { threadSubject: whole } })).toBeUndefined();
    const lines = { kind: "artifact", nodeId: BOARD, artifactId: TASK_ID, anchor: { kind: "lines", file: "a", from: 1, to: 1 } };
    expect(threadSubjectOf({ metadata: { threadSubject: lines } })).toBeUndefined();
    // Key order is not identity.
    expect(sameSubject({ taskId: TASK_ID, nodeId: BOARD, kind: "task" }, task)).toBe(true);
  });

  it("posts to the resource's node, and names it", () => {
    expect(subjectNodeOf(task)).toBe(BOARD);
    expect(subjectNodeOf({ kind: "mailbox", seat: SEAT_A })).toBe(SEAT_A);
    expect(subjectLabel(task)).toBe(`task ${TASK_ID} at ${BOARD}`);
    const long = `${"d/".repeat(100)}a.ts`;
    expect(subjectLabel({ kind: "page", nodeId: BOARD, anchor: { kind: "lines", file: long, from: 2, to: 2 } }))
      .toBe(`page ${BOARD} (...${long.slice(-80)}:2)`);
    expect(Schema.is(Anchor)({ kind: "lines", file: "a".repeat(LINES_FILE_MAX + 1), from: 1, to: 1 })).toBe(false);
    expect(sameSubject(task, { kind: "task", nodeId: BOARD, taskId: TASK_ID })).toBe(true);
    expect(sameSubject(task, { kind: "page", nodeId: BOARD })).toBe(false);
  });

  it("types: a resource subject is never a mailbox, and ids are branded", () => {
    expectTypeOf<Extract<ResourceSubject, { kind: "mailbox" }>>().toBeNever();
    expectTypeOf<ThreadSubject["kind"]>().toEqualTypeOf<"mailbox" | "task" | "artifact" | "page">();
    // @ts-expect-error a bare string is not a NodeId
    const _node: ResourceSubject = { kind: "page", nodeId: "task-board" };
    // @ts-expect-error a bare string is not an ItemId
    const _task: ResourceSubject = { kind: "task", nodeId: BOARD, taskId: "01M5ESKX20QX0HA3Y6SHEPXBCX" };
    // @ts-expect-error the whole resource is no anchor, never {kind:"whole"}
    const _whole: ResourceSubject = { kind: "page", nodeId: BOARD, anchor: { kind: "whole" } };
    // @ts-expect-error an artifact is never anchored to lines
    const _lines: ResourceSubject = { kind: "artifact", nodeId: BOARD, artifactId: TASK_ID, anchor: { kind: "lines", file: "a", from: 1, to: 1 } };
    void _node;
    void _task;
    void _whole;
    void _lines;
  });
});

describe("subject notice id", () => {
  const source = { installationId: "inst-1", sourceId: OP_ID, kind: "assignment" as const, recipient: SEAT_B };

  it("is a ULID with its cause's time", () => {
    const id = subjectNoticeId(source);
    expect(isMailMessageId(id)).toBe(true);
    expect(id.slice(0, 10)).toBe(OP_ID.slice(0, 10));
  });

  it("is the same for the same cause, and differs on every part of it", () => {
    const id = subjectNoticeId(source);
    expect(subjectNoticeId({ ...source })).toBe(id);
    const others = [
      subjectNoticeId({ ...source, installationId: "inst-2" }),
      subjectNoticeId({ ...source, sourceId: OpId.make("01M5ESMJV6GNZ0891YFFWS0S3Q") }),
      subjectNoticeId({ ...source, kind: "mention" }),
      subjectNoticeId({ ...source, recipient: SEAT_A }),
    ];
    expect(new Set([id, ...others]).size).toBe(5);
  });
});

describe("subject notice row", () => {
  const assignment: SubjectNoticeInput = {
    kind: "assignment",
    installationId: "inst-1",
    sourceId: OP_ID,
    subject: task,
    threadId: THREAD,
    recipient: SEAT_B,
    text: "pty-a assigned you this task",
    sender,
  };

  it("is a factory notice in the subject's thread, stamped by its sender", () => {
    const row = subjectNoticeRow(assignment);
    expect(row.messageId).toBe(subjectNoticeId(assignment));
    expect(row.metadata).toMatchObject({
      factoryMail: true,
      mailKind: "notice",
      fromSeat: sender.fromSeat,
      senderNodeId: SEAT_A,
      subjectNotice: "assignment",
      threadId: THREAD,
    });
    expect(threadSubjectOf(row)).toEqual(task);
    expect(subjectNoticeKindOf(row)).toBe("assignment");
    expect(mailThreadOf(row)).toBe(THREAD);
  });

  it("writes a refusal from the refused node, with no seat stamp and no reply", () => {
    const row = subjectNoticeRow({
      kind: "refusal",
      installationId: "inst-1",
      sourceId: OP_ID,
      subject: task,
      threadId: THREAD,
      recipient: SEAT_A,
      text: "refused",
      from: { nodeId: BOARD, name: "Tasks" },
    });
    expect(row.metadata).toMatchObject({ senderNodeId: BOARD, senderName: "Tasks", subjectNotice: "refusal" });
    expect(row.metadata.fromSeat).toBeUndefined();
    expect(noticeTakesReply("refusal")).toBe(false);
    expect(noticeTakesReply("mention")).toBe(true);
  });

  it("types: a refusal has no seat sender, and an op notice needs an opId", () => {
    expectTypeOf<SubjectNoticeKind>().toEqualTypeOf<"comment" | "mention" | "assignment" | "stamp-request" | "defect" | "refusal">();
    const base = { installationId: "i", subject: task, threadId: THREAD, recipient: SEAT_B, text: "t" };
    // @ts-expect-error a refusal comes from a node, not a seat stamp
    const _refusal: SubjectNoticeInput = { ...base, kind: "refusal", sourceId: OP_ID, sender };
    // @ts-expect-error an assignment's cause is an opId, not a comment id
    const _assign: SubjectNoticeInput = { ...base, kind: "assignment", sourceId: THREAD, sender };
    void _refusal;
    void _assign;
  });

  it("goes to each seat once, never to the sender", () => {
    const seats: ReadonlyArray<NodeId> = [SEAT_B, SEAT_A, SEAT_B];
    expect(subjectNoticeRecipients(seats, SEAT_A)).toEqual([SEAT_B]);
    expect(subjectNoticeRecipients(seats, undefined)).toEqual([SEAT_B, SEAT_A]);
  });
});

describe("refusal text", () => {
  it("names the command, the error, what it lost to, its dependents and the next step", () => {
    expect(
      refusalText({
        command: "task assign",
        error: { type: "Stale", message: "the task moved on", details: { retryable: false, next_step: "run junto task show" } },
        lostTo: "pty-b took it at epoch 4",
        dependents: [OpId.make("01M5ESMJV6GNZ0891YFFWS0S3Q")],
      }),
    ).toBe(
      [
        "task assign was refused: the task moved on (Stale)",
        "lost to: pty-b took it at epoch 4",
        "refused with it: 01M5ESMJV6GNZ0891YFFWS0S3Q",
        "next step: run junto task show",
      ].join("\n"),
    );
  });
});
