/**
 * A subject thread in a seat's mailbox: a notice on a task is thread mail,
 * grouped in the task's one thread and carrying its subject, where it was
 * once dropped as not conversation.
 */
import { describe, expect, it } from "vitest";
import type { MailSenderStamp } from "../src/shared/crew";
import { seatMailThreadMessages, seatMailThreads, type MailThreadsInput } from "../src/shared/mail-threads";
import { asNodeId } from "../src/shared/physics/schema";
import { subjectNoticeRow } from "../src/shared/subject-notice";
import { makeUserMessage } from "../src/shared/task";
import { formatTaskNumber, seatNodeId, taskNodeId } from "../src/shared/task-model";
import { taskRulingNotices } from "../src/shared/task-notices";
import { ItemId, OpId, TaskNumber } from "../src/shared/work-ids";

const TASK = ItemId.make("01M5ESKX20QX0HA3Y6SHEPXBCX");
const NODE = taskNodeId(asNodeId("task-board"));
const LEAD = seatNodeId(asNodeId("agent-lead"));
const WORKER = seatNodeId(asNodeId("agent-worker"));
const sender: MailSenderStamp = {
  fromSeat: "seat_lead" as MailSenderStamp["fromSeat"],
  senderNodeId: LEAD,
  senderName: "pty-lead",
  senderGeneration: "ep_1",
  senderHarness: "claude",
};

const notices = (opIds: ReadonlyArray<string>) =>
  opIds.flatMap((opId) =>
    taskRulingNotices({
      installationId: "inst-1",
      opId: OpId.make(opId),
      task: { node: NODE, taskId: TASK, number: TaskNumber.make(7), title: "fix tabs", assignee: WORKER },
      sender,
      actor: LEAD,
      effects: [{ kind: "assignment-notice", seat: WORKER }],
      nameOf: String,
    }).map((input) => {
      const row = subjectNoticeRow(input);
      return makeUserMessage({ messageId: row.messageId, text: row.text, contextId: "factory", metadata: row.metadata });
    }),
  );

describe("subject threads in a mailbox", () => {
  it("reads task notices as one thread on the task, with its subject", () => {
    const input: MailThreadsInput = {
      mailboxes: [{ nodeId: WORKER, messages: notices(["01M5ESMJV6GNZ0891YFFWS0S3P", "01M5ESMJV6GNZ0891YFFWS0S3Q"]) }],
      nameOf: (nodeId) => (nodeId === LEAD ? "pty-lead" : undefined),
    };
    const [thread, ...rest] = seatMailThreads(input, WORKER);
    expect(rest).toEqual([]);
    expect(thread).toMatchObject({
      threadId: TASK,
      messageCount: 2,
      subject: { kind: "task", nodeId: NODE, taskId: TASK },
      participants: [{ kind: "seat", nodeId: LEAD, name: "pty-lead" }, { kind: "seat", nodeId: WORKER, name: WORKER }],
    });
    const messages = seatMailThreadMessages(input, WORKER, TASK);
    expect(messages.map((message) => message.subject?.kind)).toEqual(["task", "task"]);
    expect(messages[0]?.text).toBe(`pty-lead assigned you ${formatTaskNumber(TaskNumber.make(7))} fix tabs`);
  });

  it("drops a task comment from before subjects: a taskId and no subject", () => {
    const [notice] = notices(["01M5ESMJV6GNZ0891YFFWS0S3P"]);
    const { threadSubject: _subject, ...bare } = notice!.metadata ?? {};
    const legacy = { ...notice!, taskId: TASK, metadata: bare };
    const input: MailThreadsInput = { mailboxes: [{ nodeId: WORKER, messages: [legacy] }], nameOf: () => undefined };
    expect(seatMailThreads(input, WORKER)).toEqual([]);
    expect(seatMailThreads({ ...input, mailboxes: [{ nodeId: WORKER, messages: [{ ...notice!, taskId: TASK }] }] }, WORKER)).toHaveLength(1);
  });

  it("lists a task thread as the task, and its label when the task has no name to read", () => {
    const mailboxes = [{ nodeId: WORKER, messages: notices(["01M5ESMJV6GNZ0891YFFWS0S3P"]) }];
    const named = seatMailThreads({ mailboxes, nameOf: () => undefined, subjectNameOf: (subject) => (subject.kind === "task" ? "#7 fix tabs" : undefined) }, WORKER);
    expect(named[0]?.title).toBe("#7 fix tabs");
    const unnamed = seatMailThreads({ mailboxes, nameOf: () => undefined }, WORKER);
    expect(unnamed[0]?.title).toBe(`task ${TASK} at ${NODE}`);
  });
});
