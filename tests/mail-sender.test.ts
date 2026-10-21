/**
 * Who a mail is from: a seat, the operator, or a node. A node writes under a
 * reserved, non-executable seat id, is read back from the admitted
 * `fromSeat` alone, and its header can carry no reply target.
 */
import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import {
  NODE_SENDER_SEAT_ID,
  mailFromKindOf,
  mailWriterOf,
  nodeSenderMetadata,
  type MailFrom,
  type MailFromKind,
  type MailHeaderSender,
} from "../src/shared/mail-sender";
import { asNodeId } from "../src/shared/model/base";
import { OPERATOR_SEAT_ID, type ActorRef } from "../src/shared/work-reference";

const SEAT: ActorRef = {
  seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${"a".repeat(64)}`),
  canvasName: "factory",
  nodeId: "agent-1",
};
const TASK = { kind: "node", canvasName: "factory", nodeId: asNodeId("task-1"), name: "Tasks" } as const satisfies MailFrom;

describe("the writer a row is written under", () => {
  it("is the seat's own actor for a seat", () => {
    expect(mailWriterOf({ kind: "seat", actor: SEAT })).toEqual(SEAT);
  });

  it("is the operator's actor for the operator", () => {
    expect(mailWriterOf({ kind: "operator", canvasName: "factory" })).toEqual({
      seatId: OPERATOR_SEAT_ID,
      canvasName: "factory",
      nodeId: "operator",
    });
  });

  it("is the node sender id with the node for a node", () => {
    expect(mailWriterOf(TASK)).toEqual({ seatId: NODE_SENDER_SEAT_ID, canvasName: "factory", nodeId: "task-1" });
    expect(nodeSenderMetadata(TASK)).toEqual({ senderName: "Tasks" });
  });

  it("reserves an id that is a valid actor seat id and is neither the operator's nor a seat's", () => {
    expect(Schema.is(ActorSeatId)(NODE_SENDER_SEAT_ID)).toBe(true);
    expect(NODE_SENDER_SEAT_ID).not.toBe(OPERATOR_SEAT_ID);
    expect(NODE_SENDER_SEAT_ID).not.toBe(SEAT.seatId);
  });
});

describe("whose a stored row is", () => {
  it("reads the admitted fromSeat: a node, the operator, or a seat", () => {
    expect(mailFromKindOf({ metadata: { fromSeat: NODE_SENDER_SEAT_ID, senderNodeId: "task-1" } })).toBe("node");
    expect(mailFromKindOf({ metadata: { fromSeat: OPERATOR_SEAT_ID, senderNodeId: "operator" } })).toBe("operator");
    expect(mailFromKindOf({ metadata: { fromSeat: SEAT.seatId, senderNodeId: "agent-1" } })).toBe("seat");
  });

  it("is a seat whatever else the metadata claims", () => {
    expect(mailFromKindOf({ metadata: { fromSeat: SEAT.seatId, senderName: "Tasks", senderKind: "node" } })).toBe("seat");
    expect(mailFromKindOf({})).toBe("seat");
  });

  it("round-trips the writer: what a sender writes under reads back as its kind", () => {
    for (const from of [{ kind: "seat", actor: SEAT }, { kind: "operator", canvasName: "factory" }, TASK] satisfies MailFrom[]) {
      expect(mailFromKindOf({ metadata: { fromSeat: mailWriterOf(from).seatId } })).toBe(from.kind);
    }
  });
});

describe("types", () => {
  it("closes the sender kinds", () => {
    expectTypeOf<MailFromKind>().toEqualTypeOf<"seat" | "operator" | "node">();
    expectTypeOf<MailHeaderSender["kind"]>().toEqualTypeOf<MailFromKind>();
  });

  it("refuses a reply target on a node's header", () => {
    const seat: MailHeaderSender = { kind: "seat", label: "cli-lead", replyTarget: "agent-1" };
    const node: MailHeaderSender = { kind: "node", label: "Tasks" };
    // @ts-expect-error a node takes no reply
    const replied: MailHeaderSender = { kind: "node", label: "Tasks", replyTarget: "task-1" };
    void [seat, node, replied];
  });

  it("takes a branded node id for a node sender", () => {
    // @ts-expect-error a bare string is not a NodeId
    const bare: MailFrom = { kind: "node", canvasName: "factory", nodeId: "task-1", name: "Tasks" };
    void bare;
  });
});
