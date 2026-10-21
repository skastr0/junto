/**
 * A ruled task command's mail: each TaskEffect that owes a seat mail becomes
 * one subject notice in the task's thread, never to the actor; a refused
 * command becomes one refusal notice from the task node.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type { MailSenderStamp } from "../src/shared/crew";
import { asNodeId } from "../src/shared/physics/schema";
import { subjectNoticeId, subjectNoticeRow } from "../src/shared/subject-notice";
import { formatTaskNumber, seatNodeId, taskNodeId, taskRefusal, type TaskEffect } from "../src/shared/task-model";
import {
  taskCommentNotice,
  taskName,
  taskRefusalLostTo,
  taskRefusalNotice,
  taskRulingNotices,
  taskThreadOf,
  type AppliedTaskRuling,
} from "../src/shared/task-notices";
import { threadSubjectOf } from "../src/shared/thread-subject";
import { ItemId, OpId, TaskNumber } from "../src/shared/work-ids";

const TASK = ItemId.make("01M5ESKX20QX0HA3Y6SHEPXBCX");
const OP = OpId.make("01M5ESMJV6GNZ0891YFFWS0S3P");
const NODE = taskNodeId(asNodeId("task-board"));
const LEAD = seatNodeId(asNodeId("agent-lead"));
const WORKER = seatNodeId(asNodeId("agent-worker"));
const REVIEWER = seatNodeId(asNodeId("agent-reviewer"));
const names: Record<string, string> = { [LEAD]: "pty-lead", [WORKER]: "pty-mail", [REVIEWER]: "pty-inject" };
const nameOf = (seat: string): string => names[seat] ?? seat;
const T42 = formatTaskNumber(TaskNumber.make(42));

const sender: MailSenderStamp = {
  fromSeat: "seat_lead" as MailSenderStamp["fromSeat"],
  senderNodeId: LEAD,
  senderName: "pty-lead",
  senderGeneration: "ep_1",
  senderHarness: "claude",
};

const ruling = (effects: ReadonlyArray<TaskEffect>, over: Partial<AppliedTaskRuling> = {}): AppliedTaskRuling => ({
  installationId: "inst-1",
  opId: OP,
  task: { node: NODE, taskId: TASK, number: TaskNumber.make(42), title: "fix tabs", assignee: WORKER },
  sender,
  actor: LEAD,
  effects,
  nameOf,
  ...over,
});

describe("task ruling notices", () => {
  it("mails the assigned seat and the asked reviewer, in the task's one thread", () => {
    const notices = taskRulingNotices(ruling([
      { kind: "number-minted", number: TaskNumber.make(42) },
      { kind: "assignment-notice", seat: WORKER },
      { kind: "stamp-request", reviewer: { kind: "seat", seat: REVIEWER } },
      { kind: "stamp-request", reviewer: { kind: "operator" } },
    ]));
    expect(notices.map((notice) => [notice.kind, notice.recipient, notice.text])).toEqual([
      ["assignment", WORKER, `pty-lead assigned you ${T42} fix tabs`],
      ["stamp-request", REVIEWER, `pty-lead asks for your stamp on ${T42} fix tabs`],
    ]);
    for (const notice of notices) {
      const row = subjectNoticeRow(notice);
      expect(threadSubjectOf(row)).toEqual({ kind: "task", nodeId: NODE, taskId: TASK });
      expect(row.metadata.threadId).toBe(TASK);
      expect(row.messageId).toBe(subjectNoticeId(notice));
    }
    expect(taskThreadOf({ taskId: TASK })).toBe(TASK);
  });

  it("tells the assignee about a defect, with the reviewer's words", () => {
    const [defect] = taskRulingNotices(ruling(
      [{ kind: "defect", epoch: 3, by: { kind: "seat", seat: REVIEWER }, text: "the cap is off by one" }],
      { actor: REVIEWER },
    ));
    expect(defect).toMatchObject({ kind: "defect", recipient: WORKER, text: `pty-inject asked for changes on ${T42} fix tabs\nthe cap is off by one` });
  });

  it("never tells the actor about its own act, and owes nothing for records", () => {
    expect(taskRulingNotices(ruling([{ kind: "assignment-notice", seat: LEAD }]))).toEqual([]);
    expect(taskRulingNotices(ruling([{ kind: "sent-on", from: NODE, to: NODE, layer: {
      state: "done", node: NODE, epoch: 1, stampPolicy: { required: 0 }, reviewers: [], stamps: [],
    } }]))).toEqual([]);
  });

  it("names a pending task by its title alone", () => {
    expect(taskName({ title: "fix tabs" })).toBe("fix tabs");
  });
});

describe("task refusal notice", () => {
  it("is written from the task node to the actor, naming what it lost to", () => {
    const notice = taskRefusalNotice({
      installationId: "inst-1",
      opId: OP,
      task: { node: NODE, taskId: TASK, number: TaskNumber.make(42), title: "fix tabs" },
      command: "assign",
      refusal: taskRefusal({ kind: "already-assigned", assignee: REVIEWER }),
      actor: LEAD,
      nodeName: "Tasks",
      nextStep: `run junto task show ${T42}`,
      nameOf,
    });
    expect(notice).toMatchObject({ kind: "refusal", recipient: LEAD, from: { nodeId: NODE, name: "Tasks" } });
    expect(notice.text).toBe([
      `task assign on ${T42} fix tabs was refused: someone else holds it (ClaimConflict)`,
      "lost to: pty-inject already holds the task",
      `next step: run junto task show ${T42}`,
    ].join("\n"));
  });

  it("reads a reason above reach as a sentence", () => {
    const notice = taskRefusalNotice({
      installationId: "inst-1",
      opId: OP,
      task: { node: NODE, taskId: TASK, number: TaskNumber.make(42), title: "fix tabs" },
      command: "assign",
      refusal: { reason: "not_permitted", detail: { kind: "not-assignee" } },
      actor: LEAD,
      nodeName: "Tasks",
      nameOf,
    });
    expect(notice.text.split("\n")[0]).toBe(`task assign on ${T42} fix tabs was refused: a rule above reach withholds it (ScopeError)`);
  });

  it("says something for every refusal detail", () => {
    expect(taskRefusalLostTo({ kind: "stale-epoch", expected: 4 }, nameOf)).toBe("the task moved on to epoch 4");
    expectTypeOf(taskRefusalLostTo).returns.toEqualTypeOf<string | undefined>();
  });
});

describe("task comment notice", () => {
  const comment = {
    installationId: "inst-1",
    commentId: "01M5ESQ6X9VS1GKZHNAS6BKJ49",
    text: "the cap is off by one",
    node: NODE,
    taskId: TASK as string,
    recipient: WORKER,
    sender,
  };

  it("puts a 0.10 task's comment in the task's thread, its id derived from (comment, seat)", () => {
    const row = taskCommentNotice(comment);
    expect(row.messageId).toBe(taskCommentNotice({ ...comment }).messageId);
    expect(row.messageId).not.toBe(taskCommentNotice({ ...comment, recipient: REVIEWER }).messageId);
    expect(row.text).toBe("the cap is off by one");
    expect(threadSubjectOf(row)).toEqual({ kind: "task", nodeId: NODE, taskId: TASK });
    expect(row.metadata).toMatchObject({ subjectNotice: "comment", threadId: TASK, senderNodeId: LEAD });
  });

  it("keeps a task from before item ids out of threads, with the old reply hint", () => {
    const row = taskCommentNotice({ ...comment, taskId: "t1" });
    expect(threadSubjectOf(row)).toBeUndefined();
    expect(row.metadata).toEqual({ factoryMail: true, taskComment: true, taskId: "t1", sinkNodeId: NODE });
    expect(row.text).toContain(`reply: junto msg send '{"target":"${NODE}","taskId":"t1","text":"..."}'`);
  });
});
