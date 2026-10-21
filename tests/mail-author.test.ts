import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import {
  AUTOMATION_SEAT_ID,
  AutomationNodeId,
  NOTICE_SEAT_ID,
  automationActorRef,
  mailAuthorOf,
  noticeActorRef,
  type MailAuthor,
  type MailAuthorKind,
} from "../src/shared/mail-author";
import { OPERATOR_SEAT_ID, operatorActorRef } from "../src/shared/work-reference";

const seat = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"2".repeat(64)}`);
const nightly = Schema.decodeUnknownSync(AutomationNodeId)("nightly");

describe("mail authors", () => {
  it("reads a seat, the operator and an automation from identity and node together", () => {
    expect(mailAuthorOf({ seatId: seat, nodeId: "peer" })).toEqual({ kind: "seat", seatId: seat, nodeId: "peer" });
    expect(mailAuthorOf(operatorActorRef("factory"))).toEqual({ kind: "operator" });
    expect(mailAuthorOf(automationActorRef("factory", nightly))).toEqual({ kind: "automation", nodeId: "nightly" });
  });

  it("names no author for the operator's or an automation's identity off its own node", () => {
    expect(mailAuthorOf({ seatId: OPERATOR_SEAT_ID, nodeId: "peer" })).toEqual({ kind: "malformed" });
    expect(mailAuthorOf({ seatId: seat, nodeId: "operator" })).toEqual({ kind: "malformed" });
    expect(mailAuthorOf({ seatId: AUTOMATION_SEAT_ID, nodeId: "operator" })).toEqual({ kind: "malformed" });
  });

  it("reads a notice only inside a mailbox other than its own node", () => {
    expect(mailAuthorOf(noticeActorRef("factory", "board"), "peer")).toEqual({ kind: "notice", nodeId: "board", mailbox: "peer" });
    // Outside a mailbox (a receipt, a command), into its own node, or on the operator's node: no one's.
    expect(mailAuthorOf(noticeActorRef("factory", "board"))).toEqual({ kind: "malformed" });
    expect(mailAuthorOf(noticeActorRef("factory", "board"), "board")).toEqual({ kind: "malformed" });
    expect(mailAuthorOf({ seatId: NOTICE_SEAT_ID, nodeId: "operator" }, "peer")).toEqual({ kind: "malformed" });
    expect(new Set([NOTICE_SEAT_ID, AUTOMATION_SEAT_ID, OPERATOR_SEAT_ID]).size).toBe(3);
  });

  it("refuses the operator's node as an automation's", () => {
    expect(Schema.decodeUnknownResult(AutomationNodeId)("operator")._tag).toBe("Failure");
    expect(AUTOMATION_SEAT_ID).not.toBe(OPERATOR_SEAT_ID);
  });

  it("is a closed union of five kinds", () => {
    expectTypeOf<MailAuthorKind>().toEqualTypeOf<"seat" | "operator" | "automation" | "notice" | "malformed">();
    // An automation's node is branded: a plain string is not one.
    expectTypeOf<Extract<MailAuthor, { kind: "automation" }>["nodeId"]>().not.toEqualTypeOf<string>();
    // @ts-expect-error a plain string is not an automation's node
    automationActorRef("factory", "nightly");
  });
});
