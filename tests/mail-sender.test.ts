/**
 * Who a stored mail is from, read back from its admitted stamps and its
 * mailbox, and whether it takes a reply: a seat and the operator do; an
 * automation, a resource's notice and a malformed row do not, and their
 * header can carry no reply target.
 */
import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import { AutomationNodeId, automationActorRef, noticeActorRef, type MailAuthorKind } from "../src/shared/mail-author";
import { authorTakesReply, mailHeaderSender, storedMailAuthorKindOf, type MailHeaderSender } from "../src/shared/mail-sender";
import { OPERATOR_SEAT_ID, operatorActorRef, type ActorRef } from "../src/shared/work-reference";

const SEAT: ActorRef = {
  seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${"2".repeat(64)}`),
  canvasName: "factory",
  nodeId: "agent-1",
};
const NIGHTLY = Schema.decodeUnknownSync(AutomationNodeId)("nightly");

/** A row as admission stamps it: `fromSeat` and `senderNodeId` from the writer. */
const writtenBy = (actor: ActorRef, extra: Record<string, unknown> = {}) => ({
  metadata: { ...extra, fromSeat: actor.seatId, senderNodeId: actor.nodeId },
});

describe("whose a stored row is", () => {
  it("reads each author from the writer admission stamped", () => {
    expect(storedMailAuthorKindOf(writtenBy(SEAT), "agent-2")).toBe("seat");
    expect(storedMailAuthorKindOf(writtenBy(operatorActorRef("factory")), "agent-1")).toBe("operator");
    expect(storedMailAuthorKindOf(writtenBy(automationActorRef("factory", NIGHTLY)), "agent-1")).toBe("automation");
    expect(storedMailAuthorKindOf(writtenBy(noticeActorRef("factory", "task-1")), "agent-1")).toBe("notice");
  });

  it("is a seat whatever else the metadata claims", () => {
    expect(storedMailAuthorKindOf(writtenBy(SEAT, { senderName: "Tasks", subjectNotice: "refusal" }), "agent-2")).toBe("seat");
  });

  it("names no one for a notice in its own node or an identity off its node", () => {
    expect(storedMailAuthorKindOf(writtenBy(noticeActorRef("factory", "agent-1")), "agent-1")).toBe("malformed");
    expect(storedMailAuthorKindOf({ metadata: { fromSeat: OPERATOR_SEAT_ID, senderNodeId: "agent-9" } }, "agent-1")).toBe("malformed");
    expect(storedMailAuthorKindOf({}, "agent-1")).toBe("malformed");
  });

  it("reads a row from before seat ids, whose fromSeat names a node, as a seat's", () => {
    expect(storedMailAuthorKindOf({ metadata: { fromSeat: "agent-1" } }, "agent-2")).toBe("seat");
    expect(storedMailAuthorKindOf({ metadata: { senderNodeId: "agent-1" } }, "agent-2")).toBe("seat");
  });
});

describe("replies", () => {
  it("are taken only from a seat or the operator", () => {
    const kinds: ReadonlyArray<MailAuthorKind> = ["seat", "operator", "automation", "notice", "malformed"];
    expect(kinds.filter(authorTakesReply)).toEqual(["seat", "operator"]);
  });
});

describe("a header sender", () => {
  it("keeps the reply target only for a seat or the operator", () => {
    expect(mailHeaderSender("seat", "cli-lead", "agent-1")).toEqual({ kind: "seat", label: "cli-lead", replyTarget: "agent-1" });
    expect(mailHeaderSender("operator", "the operator", "operator")).toEqual({ kind: "operator", label: "the operator", replyTarget: "operator" });
    expect(mailHeaderSender("notice", "Tasks", "task-1")).toEqual({ kind: "notice", label: "Tasks" });
    expect(mailHeaderSender("automation", "nightly", "nightly")).toEqual({ kind: "automation", label: "nightly" });
    expect(mailHeaderSender("seat", "cli-lead")).toEqual({ kind: "seat", label: "cli-lead" });
  });

  it("reads a notice without its mailbox as no one's, still with no reply", () => {
    const kind = storedMailAuthorKindOf(writtenBy(noticeActorRef("factory", "task-1")));
    expect(kind).toBe("malformed");
    expect(authorTakesReply(kind)).toBe(false);
  });
});

describe("types", () => {
  it("names every author kind in a header", () => {
    expectTypeOf<MailHeaderSender["kind"]>().toEqualTypeOf<MailAuthorKind>();
  });

  it("refuses a reply target on a header no one can answer", () => {
    const seat: MailHeaderSender = { kind: "seat", label: "cli-lead", replyTarget: "agent-1" };
    const notice: MailHeaderSender = { kind: "notice", label: "Tasks" };
    // @ts-expect-error a resource's notice takes no reply
    const toNotice: MailHeaderSender = { kind: "notice", label: "Tasks", replyTarget: "task-1" };
    // @ts-expect-error an automation takes no reply
    const toAutomation: MailHeaderSender = { kind: "automation", label: "nightly", replyTarget: "nightly" };
    void [seat, notice, toNotice, toAutomation];
  });
});
