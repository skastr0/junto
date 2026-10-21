import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import type { QueuedCommand, RulingRefusedResult } from "../src/shared/command-row";
import { InstallationId } from "../src/shared/installation-id";
import { commandWords, refusalNoticeOf, refusedWith, refusalSubjectOf, type QueuedLink } from "../src/shared/refusal-notice";
import { subjectNoticeId, subjectNoticeKindOf } from "../src/shared/subject-notice";
import { threadSubjectOf } from "../src/shared/thread-subject";
import { ItemId, OpId } from "../src/shared/work-ids";

const op = (tail: string) => Schema.decodeUnknownSync(OpId)(`01M5ESR3G8AN1BA0AVVQC2X${tail}`);
const ROOT = op("4W0");
const CHILD = op("4W1");
const GRANDCHILD = op("4W2");
const UNRELATED = op("4W3");
const MINI = Schema.decodeUnknownSync(InstallationId)("mini");
const EDITOR = Schema.decodeUnknownSync(InstallationId)("macbook");
const seatId = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"2".repeat(64)}`);
const TASK = Schema.decodeUnknownSync(ItemId)("01M5ESR3G8AN1BA0AVVQC2XTSK");
const seatActor = { kind: "seat" as const, seatId, nodeId: "peer" };

const command = (overrides: Partial<QueuedCommand> = {}): QueuedCommand =>
  ({
    opId: ROOT,
    canvasName: "factory",
    actor: seatActor,
    target: { kind: "task", nodeId: "board", itemId: TASK },
    basis: { editor: EDITOR, seq: "12" },
    after: [],
    op: { kind: "assign" },
    ...overrides,
  }) as QueuedCommand;

const refused = (overrides: Partial<RulingRefusedResult> = {}): RulingRefusedResult =>
  ({
    operation: "ruling.refused",
    writer: MINI,
    opId: ROOT,
    actor: seatActor,
    reason: "already_held",
    expected: "epoch:7",
    root: ROOT,
    ...overrides,
  }) as RulingRefusedResult;

const queue: ReadonlyArray<QueuedLink> = [
  { opId: ROOT, after: [] },
  { opId: CHILD, after: [ROOT] },
  { opId: GRANDCHILD, after: [UNRELATED, CHILD] },
  { opId: UNRELATED, after: [] },
];

describe("the commands refused with a root", () => {
  it("are every command whose after chain reaches it, oldest first, without the root", () => {
    expect(refusedWith(ROOT, queue)).toEqual([CHILD, GRANDCHILD]);
  });

  it("are none for a command nothing builds on, and any one that builds on it through another root", () => {
    expect(refusedWith(GRANDCHILD, queue)).toEqual([]);
    expect(refusedWith(UNRELATED, queue)).toEqual([GRANDCHILD]);
  });

  it("follow a chain listed in any order", () => {
    expect(refusedWith(ROOT, [...queue].reverse())).toEqual([CHILD, GRANDCHILD]);
  });
});

describe("the refusal notice", () => {
  const notice = () => refusalNoticeOf({ installationId: MINI, ruling: refused(), command: command(), queue });

  it("goes to the actor seat, under the id derived from (installation, opId, refusal, recipient)", () => {
    const written = notice()!;
    expect(written.recipient).toBe("peer");
    expect(written.row.messageId).toBe(subjectNoticeId({ installationId: MINI, sourceId: ROOT, kind: "refusal", recipient: "peer" as never }));
    expect(notice()!.row).toEqual(written.row);
  });

  it("is from the refused resource's node, never a seat or the operator, and takes no reply", () => {
    const { metadata } = notice()!.row;
    expect(metadata).toMatchObject({ senderNodeId: "board", senderName: "Tasks", mailKind: "notice", subjectNotice: "refusal" });
    expect(metadata.fromSeat).toBeUndefined();
    expect(subjectNoticeKindOf(notice()!.row)).toBe("refusal");
  });

  it("names the command, its error, what it lost to, its dependents and the next step", () => {
    const { text } = notice()!.row;
    expect(text).toContain("task assign was refused: Another command was ruled first (ClaimConflict)");
    expect(text).toContain("lost to: epoch:7");
    expect(text).toContain(`refused with it: ${CHILD}, ${GRANDCHILD}`);
    const dependent = refusalNoticeOf({
      installationId: MINI,
      ruling: refused({ reason: "stale", root: ROOT, opId: UNRELATED }),
      command: command({ opId: UNRELATED }),
      queue,
    });
    expect(dependent).toBeUndefined();
  });

  it("says the next step when the error has one", () => {
    const chained = refusalNoticeOf({
      installationId: MINI,
      ruling: refused({ reason: "stale" }),
      command: command(),
      queue: [],
    })!;
    expect(chained.row.text).toContain("(Stale)");
    expect(chained.row.text).not.toContain("refused with it");
  });

  it("carries the resource's subject, so it lands in that resource's thread", () => {
    expect(threadSubjectOf(notice()!.row)).toEqual({ kind: "task", nodeId: "board", taskId: TASK });
    const artifact = refusalNoticeOf({
      installationId: MINI,
      ruling: refused(),
      command: command({ target: { kind: "artifact", nodeId: "shelf", itemId: TASK } as never }),
      queue: [],
    })!;
    expect(threadSubjectOf(artifact.row)).toEqual({ kind: "artifact", nodeId: "shelf", artifactId: TASK });
  });

  it("goes to the mailbox with no subject when the command names no item", () => {
    const bare = refusalNoticeOf({
      installationId: MINI,
      ruling: refused(),
      command: command({ target: { kind: "task", nodeId: "board" } as never }),
      queue: [],
    })!;
    expect(threadSubjectOf(bare.row)).toBeUndefined();
    expect(bare.row.metadata).toMatchObject({ senderNodeId: "board", subjectNotice: "refusal" });
  });

  it("is written only for the root of a chain, and only for a seat", () => {
    expect(refusalNoticeOf({ installationId: MINI, ruling: refused({ opId: CHILD, reason: "depends_on_refused" }), command: command({ opId: CHILD }), queue })).toBeUndefined();
    expect(refusalNoticeOf({ installationId: MINI, ruling: refused({ actor: { kind: "operator" } }), command: command(), queue })).toBeUndefined();
  });
});

describe("the command in words", () => {
  it("is the resource kind and the op's own kind, and only the kind for an op it cannot name", () => {
    expect(commandWords(command())).toBe("task assign");
    expect(commandWords(command({ op: { kind: "Assign Everything Now" } }))).toBe("task");
    expect(commandWords(command({ op: ["assign"] }))).toBe("task");
  });

  it("names a subject only for a command with an item", () => {
    expect(refusalSubjectOf({ kind: "task", nodeId: "board" } as never)).toBeUndefined();
    expect(refusalSubjectOf({ kind: "automation", nodeId: "nightly", itemId: TASK } as never)).toBeUndefined();
  });
});
