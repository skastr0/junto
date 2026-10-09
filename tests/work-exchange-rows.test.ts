import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
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
const seat = (digit: string) => Schema.decodeUnknownSync(ActorSeatId)(`seat_${digit.repeat(64)}`);

/** `lead` lives on the editing machine, `peer` on the mini, `far` on a third machine. */
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

  it("refuses a row that names another canvas anywhere inside it", () => {
    const sent = mail(mini, peer, "lead");
    expect(crosses({ ...sent, body: { ...sent.body, sentBy: { ...sent.body.sentBy, canvasName: "private" } } })).toBe(false);
    const taken = receipt(mini, peer);
    const elsewhere = { canvasName: "private", nodeId: "peer" };
    // A receipt for the `factory` canvas that points at mail and a mailbox on another canvas.
    expect(
      crosses({
        ...taken,
        body: {
          ...taken.body,
          receipt: { ...taken.body.receipt, actor: { ...taken.body.receipt.actor, canvasName: "private" }, deliveredItem: { ...taken.body.receipt.deliveredItem, sink: elsewhere } },
        },
      }),
    ).toBe(false);
    expect(
      crosses({ ...taken, body: { ...taken.body, receipt: { ...taken.body.receipt, deliveredItem: { ...taken.body.receipt.deliveredItem, sink: elsewhere } } } }),
    ).toBe(false);
    expect(
      crosses({ ...taken, body: { ...taken.body, receipt: { ...taken.body.receipt, actor: { ...taken.body.receipt.actor, canvasName: "private" } } } }),
    ).toBe(false);
    // A receipt whose own item sits in another seat's mailbox.
    expect(crosses({ ...taken, item: { ...taken.item, sink: { canvasName: "factory", nodeId: "lead" } } })).toBe(false);
  });

  it("bounds a frame and refuses a frame it does not know", () => {
    const one = mail(editor, lead, "peer");
    const frame = (facts: unknown[]) => ({ kind: "rows", canvasName: "factory", canvasId: "canvas-factory", writer: editor, facts, through: "1" });
    expect(Result.isSuccess(decodeExchangeFrame(frame([one])))).toBe(true);
    expect(Result.isSuccess(decodeExchangeFrame(frame(Array.from({ length: EXCHANGE_MAX_FACTS_PER_FRAME + 1 }, () => one))))).toBe(false);
    expect(Result.isSuccess(decodeExchangeFrame({ ...frame([]), through: "007" }))).toBe(false);
    expect(Result.isSuccess(decodeExchangeFrame({ ...frame([]), extra: true }))).toBe(false);
    expect(Result.isSuccess(decodeExchangeFrame({ kind: "claim", canvasName: "factory" }))).toBe(false);
    expect(
      Result.isSuccess(
        decodeExchangeFrame({ kind: "have", canvases: [{ canvasName: "factory", canvasId: "canvas-factory", writers: [{ writer: mini, through: "0" }] }] }),
      ),
    ).toBe(true);
    // A frame names its canvas by id as well as by name.
    const { canvasId: _id, ...unnamed } = frame([]);
    expect(Result.isSuccess(decodeExchangeFrame(unnamed))).toBe(false);
    expect(Result.isSuccess(decodeExchangeFrame({ kind: "have", canvases: [{ canvasName: "factory", writers: [] }] }))).toBe(false);
  });

  it("knows a copy and its refusal, each exactly as written", () => {
    const copy = {
      canvasName: "factory",
      canvasId: "canvas-factory",
      seq: 3,
      editor,
      target: mini,
      seats: [],
      peers: [],
      terminals: [],
      regions: [],
      wires: [],
      guidance: [],
      references: [],
      playing: true,
    };
    expect(Result.isSuccess(decodeExchangeFrame({ kind: "copy", copy }))).toBe(true);
    expect(Result.isSuccess(decodeExchangeFrame({ kind: "copy", copy: { ...copy, notes: [] } }))).toBe(false);
    expect(Result.isSuccess(decodeExchangeFrame({ kind: "copy", copy: { ...copy, target: undefined } }))).toBe(false);
    const refusal = { kind: "copy-refused", canvasName: "factory", canvasId: "canvas-factory", seq: 3, reason: "a-canvas-of-that-name" };
    expect(Result.isSuccess(decodeExchangeFrame(refusal))).toBe(true);
    expect(Result.isSuccess(decodeExchangeFrame({ ...refusal, reason: "busy" }))).toBe(false);
    expect(Result.isSuccess(decodeExchangeFrame({ ...refusal, detail: "x" }))).toBe(false);
  });

  it("carries a secret only as its reference, at every depth of a copy and of a row", () => {
    const region = (source: object) => ({
      kind: "region",
      id: "remote",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      z: 0,
      hold: false,
      environment: { sources: [source] },
    });
    const copy = (regions: unknown[], seats: unknown[] = []) => ({
      kind: "copy",
      copy: {
        canvasName: "factory",
        canvasId: "canvas-factory",
        seq: 3,
        editor,
        target: mini,
        seats,
        peers: [],
        terminals: [],
        regions,
        wires: [],
        guidance: [],
        references: [],
        playing: true,
      },
    });
    const reference = { id: "token", kind: "secret", name: "TOKEN", secretId: "token-1" };
    expect(Result.isSuccess(decodeExchangeFrame(copy([region(reference)])))).toBe(true);
    // The same source with the secret itself beside its reference, under any name.
    for (const leaked of [{ value: "s3cr3t" }, { secret: "s3cr3t" }, { resolved: "s3cr3t" }]) {
      expect(Result.isSuccess(decodeExchangeFrame(copy([region({ ...reference, ...leaked })])))).toBe(false);
    }
    // A seat or a peer with an environment, or anything else it does not have.
    const peerSeat = { kind: "peer", id: "lead", x: 0, y: 0, width: 100, height: 60, z: 0, label: "lead", host: "macbook", seatId: seat("1") };
    expect(Result.isSuccess(decodeExchangeFrame({ ...copy([]), copy: { ...copy([]).copy, peers: [peerSeat] } }))).toBe(true);
    for (const extra of [{ env: { TOKEN: "s3cr3t" } }, { bindingId: "binding-lead" }, { launch: { kind: "harness", argv: ["claude"] } }]) {
      expect(
        Result.isSuccess(decodeExchangeFrame({ ...copy([]), copy: { ...copy([]).copy, peers: [{ ...peerSeat, ...extra }] } })),
      ).toBe(false);
    }

    // A row: nothing rides inside its body or its receipt beyond what the row is.
    const sent = mail(editor, lead, "peer");
    const frame = (fact: unknown) => ({ kind: "rows", canvasName: "factory", canvasId: "canvas-factory", writer: editor, facts: [fact], through: "1" });
    expect(Result.isSuccess(decodeExchangeFrame(frame(sent)))).toBe(true);
    expect(Result.isSuccess(decodeExchangeFrame(frame({ ...sent, body: { ...sent.body, environment: { TOKEN: "s3cr3t" } } })))).toBe(false);
    expect(Result.isSuccess(decodeExchangeFrame(frame({ ...sent, body: { ...sent.body, sentBy: { ...sent.body.sentBy, credential: "s3cr3t" } } })))).toBe(false);
    const taken = receipt(mini, peer);
    expect(
      Result.isSuccess(
        decodeExchangeFrame({ ...frame({ ...taken, body: { ...taken.body, receipt: { ...taken.body.receipt, token: "s3cr3t" } } }), writer: mini }),
      ),
    ).toBe(false);
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
    // A machine with no seat on the canvas passes on nothing, not even its own rows.
    const stranger = id("stranger");
    expect(peerMayPassOn(stranger, stranger, placement)).toBe(false);
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

  it("holds a row to the exact identity of the seat at its author's node", () => {
    // The mini writes from its own node under the seat identity of another seat.
    expect(writtenByItsAuthor(decode(mail(mini, { seatId: seat("1"), nodeId: "peer" }, "lead")), placement)).toBe(false);
    expect(writtenByItsAuthor(decode(receipt(mini, { seatId: seat("1"), nodeId: "peer" })), placement)).toBe(false);
  });

  it("holds the operator's mail to the machine that edits the canvas", () => {
    const operator = operatorActorRef("factory");
    expect(writtenByItsAuthor(decode(mail(editor, operator, "peer")), placement)).toBe(true);
    expect(writtenByItsAuthor(decode(mail(mini, operator, "peer")), placement)).toBe(false);
    // The operator's node under a seat's identity, a seat's node under the operator's, and an operator receipt.
    expect(writtenByItsAuthor(decode(mail(editor, { seatId: seat("1"), nodeId: "operator" }, "peer")), placement)).toBe(false);
    expect(writtenByItsAuthor(decode(mail(editor, { seatId: operator.seatId, nodeId: "lead" }, "peer")), placement)).toBe(false);
    expect(writtenByItsAuthor(decode(receipt(editor, operator)), placement)).toBe(false);
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
