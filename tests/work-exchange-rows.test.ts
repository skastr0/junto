import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { InstallationId } from "../src/shared/installation-id";
import {
  EXCHANGE_MAX_FACTS_PER_FRAME,
  ExchangeFact,
  compareSequence,
  decodeExchangeFrame,
  entitledTo,
  peerMayPassOn,
  writtenByItsAuthor,
  type CanvasPlacement,
} from "../src/shared/work-exchange";
import { WORK_PROTOCOL } from "../src/shared/work-protocol";
import { operatorActorRef } from "../src/shared/work-reference";

const id = Schema.decodeUnknownSync(InstallationId);
const editor = id("macbook");
const mini = id("mini");
const other = id("other-mini");
const timestamp = "2026-10-09T12:00:00.000Z";
const seat = (digit: string) => `seat_${digit.repeat(64)}`;

/** `lead` lives on the editing machine, `peer` on the mini, `far` on a third machine. */
const placement: CanvasPlacement = {
  editor,
  machineOf: (nodeId) => ({ lead: editor, peer: mini, far: other })[nodeId],
};

const mail = (writer: string, from: { seatId: string; nodeId: string }, to: string, seq = "1") => ({
  protocol: WORK_PROTOCOL,
  id: { route: { eventHome: writer, entityHome: writer }, seq },
  recordType: "fact",
  basis: { kind: "canvas", canvasName: "factory", seq: 7 },
  item: { kind: "message", itemId: `mail-${seq}`, sink: { canvasName: "factory", nodeId: to } },
  operation: "message.append",
  contentSha256: "a".repeat(64),
  originAt: timestamp,
  predecessor: null,
  body: {
    operation: "message.append",
    message: { messageId: `mail-${seq}`, role: "agent", parts: [{ kind: "text", text: "hello" }] },
    sentBy: { ...from, canvasName: "factory" },
    destination: { kind: "mailbox" },
  },
});

const receipt = (writer: string, by: { seatId: string; nodeId: string }, seq = "2") => ({
  protocol: WORK_PROTOCOL,
  id: { route: { eventHome: writer, entityHome: writer }, seq },
  recordType: "fact",
  basis: { kind: "canvas", canvasName: "factory", seq: 7 },
  item: { kind: "delivery", itemId: "delivery-1", sink: { canvasName: "factory", nodeId: by.nodeId } },
  operation: "delivery.accepted",
  contentSha256: "b".repeat(64),
  originAt: timestamp,
  predecessor: null,
  body: {
    operation: "delivery.accepted",
    receipt: {
      deliveryId: "delivery-1",
      deliveredItem: { kind: "message", itemId: "mail-1", sink: { canvasName: "factory", nodeId: by.nodeId } },
      actor: { ...by, canvasName: "factory" },
      acceptedAt: timestamp,
    },
  },
});

const lead = { seatId: seat("1"), nodeId: "lead" };
const peer = { seatId: seat("2"), nodeId: "peer" };
const decode = Schema.decodeUnknownSync(ExchangeFact, { onExcessProperty: "error" });
const crosses = (fact: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(ExchangeFact, { onExcessProperty: "error" })(fact));

describe("the rows that may cross machines", () => {
  it("admits mail to a seat and a seat's own receipt", () => {
    expect(crosses(mail(editor, lead, "peer"))).toBe(true);
    expect(crosses(receipt(mini, peer))).toBe(true);
  });

  it("refuses every other kind of row, a row that leans on another, and a row with no canvas basis", () => {
    const sent = mail(editor, lead, "peer");
    expect(crosses({ ...sent, basis: { kind: "historical" } })).toBe(false);
    expect(crosses({ ...sent, basis: { kind: "canvas", canvasName: "another", seq: 7 } })).toBe(false);
    expect(crosses({ ...sent, predecessor: { route: { eventHome: editor, entityHome: editor }, seq: "1" } })).toBe(false);
    expect(
      crosses({
        ...sent,
        item: { ...sent.item, kind: "message" },
        body: { ...sent.body, message: { ...sent.body.message, taskId: "task-1" }, destination: { kind: "task", itemId: "task-1" } },
      }),
    ).toBe(false);
    expect(crosses({ ...sent, operation: "task.create" })).toBe(false);
    const taken = receipt(mini, peer);
    expect(
      crosses({
        ...taken,
        body: {
          ...taken.body,
          receipt: { ...taken.body.receipt, deliveredItem: { ...taken.body.receipt.deliveredItem, sink: { canvasName: "factory", nodeId: "lead" } } },
        },
      }),
    ).toBe(false);
  });

  it("bounds a frame and refuses a frame it does not know", () => {
    const one = mail(editor, lead, "peer");
    const frame = (facts: unknown[]) => ({ kind: "rows", canvasName: "factory", writer: editor, facts, through: "1" });
    expect(Result.isSuccess(decodeExchangeFrame(frame([one])))).toBe(true);
    expect(Result.isSuccess(decodeExchangeFrame(frame(Array.from({ length: EXCHANGE_MAX_FACTS_PER_FRAME + 1 }, () => one))))).toBe(false);
    expect(Result.isSuccess(decodeExchangeFrame({ ...frame([]), through: "007" }))).toBe(false);
    expect(Result.isSuccess(decodeExchangeFrame({ ...frame([]), extra: true }))).toBe(false);
    expect(Result.isSuccess(decodeExchangeFrame({ kind: "claim", canvasName: "factory" }))).toBe(false);
    expect(
      Result.isSuccess(decodeExchangeFrame({ kind: "have", canvases: [{ canvasName: "factory", writers: [{ writer: mini, through: "0" }] }] })),
    ).toBe(true);
  });

  it("orders sequences by value, past the range of a number", () => {
    expect(compareSequence("9", "10")).toBeLessThan(0);
    expect(compareSequence("9007199254740993", "9007199254740992")).toBeGreaterThan(0);
    expect(compareSequence("0", "0")).toBe(0);
  });
});

describe("who may hand a row over, and who wrote it", () => {
  it("lets a writer pass on its own rows and the editing machine pass on any writer's", () => {
    expect(peerMayPassOn(mini, mini, placement)).toBe(true);
    expect(peerMayPassOn(editor, mini, placement)).toBe(true);
    expect(peerMayPassOn(mini, editor, placement)).toBe(false);
    expect(peerMayPassOn(other, mini, placement)).toBe(false);
  });

  it("holds a seat's mail and receipts to that seat's machine", () => {
    expect(writtenByItsAuthor(decode(mail(mini, peer, "lead")), placement)).toBe(true);
    expect(writtenByItsAuthor(decode(receipt(mini, peer)), placement)).toBe(true);
    // The mini claims mail from a seat that lives on the editing machine.
    expect(writtenByItsAuthor(decode(mail(mini, lead, "peer")), placement)).toBe(false);
    expect(writtenByItsAuthor(decode(receipt(mini, lead)), placement)).toBe(false);
    // A node that is no seat has no machine to write from.
    expect(writtenByItsAuthor(decode(mail(mini, { seatId: seat("9"), nodeId: "a-note" }, "lead")), placement)).toBe(false);
  });

  it("holds the operator's mail to the machine that edits the canvas", () => {
    const operator = operatorActorRef("factory");
    expect(writtenByItsAuthor(decode(mail(editor, operator, "peer")), placement)).toBe(true);
    expect(writtenByItsAuthor(decode(mail(mini, operator, "peer")), placement)).toBe(false);
  });
});

describe("what a machine is entitled to", () => {
  it("gives the editing machine every row of its canvas", () => {
    expect(entitledTo(editor, decode(mail(mini, peer, "far")), placement)).toBe(true);
    expect(entitledTo(editor, decode(receipt(mini, peer)), placement)).toBe(true);
  });

  it("gives another machine the mail addressed to its seats and nothing else", () => {
    expect(entitledTo(mini, decode(mail(editor, lead, "peer")), placement)).toBe(true);
    expect(entitledTo(mini, decode(mail(editor, lead, "far")), placement)).toBe(false);
    expect(entitledTo(other, decode(mail(editor, lead, "peer")), placement)).toBe(false);
  });

  it("gives another machine the receipts for mail its seats wrote, when the author is known", () => {
    const taken = decode(receipt(editor, lead));
    expect(entitledTo(mini, taken, placement, "peer")).toBe(true);
    expect(entitledTo(mini, taken, placement, "far")).toBe(false);
    expect(entitledTo(mini, taken, placement)).toBe(false);
  });
});
