import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  WORK_PROTOCOL,
  WORK_PROTOCOL_MAX_RECORD_BYTES,
  decodeWorkRecord,
  decodeWorkResult,
  workRecordEncodedByteLength,
} from "../src/shared/work-protocol";

const writer = "writer-installation";
const other = "other-installation";
const timestamp = "2026-07-27T18:00:00.000Z";
const seatId = `seat_${"d".repeat(64)}`;

const sink = { canvasName: "factory", nodeId: "recipient" };
const actor = { seatId, canvasName: "factory", nodeId: "builder" };

const mail = {
  messageId: "message-1",
  role: "agent" as const,
  parts: [{ kind: "text" as const, text: "sent from this seat" }],
};

const messageBody = {
  operation: "message.append",
  message: mail,
  sentBy: actor,
  destination: { kind: "mailbox" },
};

const messageFact = {
  protocol: WORK_PROTOCOL,
  id: { route: { eventHome: writer, entityHome: writer }, seq: "1" },
  recordType: "fact",
  basis: { kind: "canvas", canvasName: "factory", seq: 11 },
  item: { kind: "message", itemId: mail.messageId, sink },
  operation: "message.append",
  contentSha256: "b".repeat(64),
  originAt: timestamp,
  predecessor: null,
  body: messageBody,
};

const accepts = (record: unknown): boolean => Result.isSuccess(decodeWorkRecord(record));

describe("work record contract", () => {
  it("decodes a mail fact under the canvas its writer saw, and a fact kept from before that basis", () => {
    expect(accepts(messageFact)).toBe(true);
    expect(accepts({ ...messageFact, basis: { kind: "historical" } })).toBe(true);
    expect(accepts({ ...messageFact, id: { ...messageFact.id, seq: "9007199254740993" } })).toBe(true);
    // Zero is not a record sequence.
    expect(accepts({ ...messageFact, id: { ...messageFact.id, seq: "0" } })).toBe(false);
  });

  it("requires exactly one known basis", () => {
    const { basis: _basis, ...basisLess } = messageFact;
    expect(accepts(basisLess)).toBe(false);
    expect(accepts({ ...messageFact, basis: { kind: "canvas", canvasName: "factory" } })).toBe(false);
    expect(accepts({ ...messageFact, basis: { kind: "projected-intent", generation: "1", contentSha256: "a".repeat(64) } })).toBe(false);
    expect(accepts({ ...messageFact, basis: { kind: "historical", seq: 1 } })).toBe(false);
  });

  it("admits facts only: a record is written by its own installation and is never a command", () => {
    expect(accepts({ ...messageFact, id: { route: { eventHome: other, entityHome: writer }, seq: "1" } })).toBe(false);
    expect(accepts({ ...messageFact, recordType: "command" })).toBe(false);
    expect(accepts({ ...messageFact, recordType: "disposition" })).toBe(false);
  });

  it("binds the record to its body: same operation, same item", () => {
    expect(accepts({ ...messageFact, operation: "delivery.accepted" })).toBe(false);
    expect(accepts({ ...messageFact, item: { ...messageFact.item, itemId: "another-message" } })).toBe(false);
    expect(accepts({ ...messageFact, item: { ...messageFact.item, kind: "task" } })).toBe(false);
  });

  it("rejects excess properties on the record and inside its body", () => {
    expect(accepts({ ...messageFact, extra: true })).toBe(false);
    expect(accepts({ ...messageFact, body: { ...messageBody, extra: true } })).toBe(false);
    expect(Result.isSuccess(decodeWorkResult(messageBody))).toBe(true);
    expect(Result.isFailure(decodeWorkResult({ ...messageBody, operation: "message.unknown" }))).toBe(true);
  });

  it("bounds one record by its encoded size", () => {
    const oversized = {
      ...messageFact,
      body: {
        ...messageBody,
        message: { ...mail, parts: [{ kind: "text", text: "x".repeat(WORK_PROTOCOL_MAX_RECORD_BYTES) }] },
      },
    };
    expect(workRecordEncodedByteLength(messageFact)).toBeLessThan(WORK_PROTOCOL_MAX_RECORD_BYTES);
    expect(accepts(oversized)).toBe(false);
  });
});
