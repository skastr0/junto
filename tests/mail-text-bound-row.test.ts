/**
 * A text of exactly MAIL_TEXT_INLINE_MAX_BYTES, in a mail whose envelope is
 * at its longest, still makes a row the machine writes (remote-lead's ask,
 * on a194abcc2).
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import { assertWorkRowBound, workRowBytes } from "../src/shared/exchange-bounds";
import { mailExtensionMetadata } from "../src/shared/crew";
import { MAIL_ENVELOPE_BYTES, MAIL_TEXT_INLINE_MAX_BYTES, mailTextBytes } from "../src/shared/mail-text-bound";
import { OPERATOR_ATTACHMENTS_MAX } from "../src/shared/operator-attachments";
import { ExchangeFact } from "../src/shared/work-exchange";
import { WORK_PROTOCOL } from "../src/shared/work-protocol";

const decodeFact = Schema.decodeUnknownSync(ExchangeFact);
const ulid = "01M5EWVMGBCK0SD7DAZK23GXZG";
const seat = Schema.decodeSync(ActorSeatId)(`seat_${"1".repeat(64)}`);
/** A name at its 255 bound in the costliest characters it may hold: three UTF-8 bytes each. */
const widestName = "語".repeat(255);
const fileRef = {
  sha256: "a".repeat(64),
  byteLength: Number.MAX_SAFE_INTEGER,
  mediaType: widestName,
  displayName: widestName,
};
const regions = Array.from({ length: 8 }, (_, depth) => ({ id: `region-${ulid}`, name: `${depth}${"語".repeat(79)}` }));

const mailWith = (text: string) =>
  decodeFact({
    protocol: WORK_PROTOCOL,
    id: { route: { eventHome: "m".repeat(128), entityHome: "m".repeat(128) }, seq: "9".repeat(32) },
    recordType: "fact",
    basis: { kind: "canvas", canvasName: "c".repeat(256), seq: Number.MAX_SAFE_INTEGER },
    item: { kind: "message", itemId: ulid, sink: { canvasName: "c".repeat(256), nodeId: `agent-${ulid}` } },
    operation: "message.append",
    contentSha256: "a".repeat(64),
    originAt: "2026-10-21T12:00:00.000Z",
    predecessor: null,
    body: {
      operation: "message.append",
      message: {
        messageId: ulid,
        role: "user",
        parts: [{ kind: "text", text }],
        contextId: "c".repeat(256),
        metadata: {
          factoryMail: true,
          agentSignalId: ulid,
          threadId: ulid,
          inReplyTo: ulid,
          attachments: Array.from({ length: OPERATOR_ATTACHMENTS_MAX }, () => fileRef),
          ...mailExtensionMetadata({
            mailKind: "prompt",
            fromSeat: seat,
            senderNodeId: `agent-${ulid}`,
            senderName: "語".repeat(80),
            senderGeneration: "operator",
            senderHarness: "unknown",
            senderRegions: regions,
          }),
        },
      },
      sentBy: { seatId: seat, canvasName: "c".repeat(256), nodeId: `agent-${ulid}` },
      destination: { kind: "mailbox" },
    },
  });

describe("a mail's inline text bound", () => {
  it("leaves room for the longest envelope", () => {
    const envelope = workRowBytes(mailWith(""));
    const text = "x".repeat(MAIL_TEXT_INLINE_MAX_BYTES);
    expect(mailTextBytes(text)).toBe(MAIL_TEXT_INLINE_MAX_BYTES);
    expect({ envelope, fits: envelope <= MAIL_ENVELOPE_BYTES }).toEqual({ envelope, fits: true });
    expect(assertWorkRowBound(mailWith(text))).toBeUndefined();
  });
});
