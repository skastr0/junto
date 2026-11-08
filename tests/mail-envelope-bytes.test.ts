/**
 * A mail's row, less its text, at its longest, measured as the row cap
 * measures it (workRowBytes), against the room the composer leaves for it
 * (MAIL_ENVELOPE_BYTES, src/shared/mail-text-bound.ts).
 *
 * Every field with a bound is at its bound: installation ids 128, canvas name
 * and node ids 256, a seq of 32 digits, ten content refs with a 255 media type
 * and display name. Subject, sender name, region names and evidence refs have
 * no bound on the wire; they are taken at 256 characters, eight regions
 * (MAX_REGION_DEPTH) and ten refs. Text fields are measured plain and with
 * every character a control character, which JSON escapes to six bytes (a
 * display name, which refuses those, at three-byte characters).
 */
import { Schema } from "effect";
import { expect, it } from "vitest";
import { workRowBytes } from "../src/shared/exchange-bounds";
import { MAIL_ENVELOPE_BYTES } from "../src/shared/mail-text-bound";
import { OPERATOR_ATTACHMENTS_MAX } from "../src/shared/operator-attachments";
import { MAX_REGION_DEPTH } from "../src/shared/graph";
import { WorkFact, WORK_PROTOCOL } from "../src/shared/work-protocol";

const decode = Schema.decodeUnknownSync(WorkFact);
const ulid = "01M5EWVM667T795TKQBXA5NCTD";
const ascii = (n: number) => "a".repeat(n);

const envelope = (escaped: boolean) => {
  const text = (n: number) => (escaped ? "\u0001".repeat(n) : ascii(n));
  // A display name refuses control characters; its costliest character is three bytes of UTF-8.
  const name = (n: number) => (escaped ? "\u20ac".repeat(n) : ascii(n));
  const installation = ascii(128);
  const canvas = text(256);
  const node = text(256);
  const seat = `seat_${"1".repeat(64)}`;
  return decode({
    protocol: WORK_PROTOCOL,
    id: { route: { eventHome: installation, entityHome: installation }, seq: "9".repeat(32) },
    recordType: "fact",
    basis: { kind: "canvas", canvasName: canvas, seq: Number.MAX_SAFE_INTEGER },
    item: { kind: "message", itemId: ulid, sink: { canvasName: canvas, nodeId: node } },
    operation: "message.append",
    contentSha256: "a".repeat(64),
    originAt: "2026-10-21T12:00:00.000Z",
    predecessor: null,
    body: {
      operation: "message.append",
      message: {
        messageId: ulid,
        role: "agent",
        contextId: canvas,
        parts: [
          { kind: "text", text: "" },
          ...Array.from({ length: OPERATOR_ATTACHMENTS_MAX }, () => ({
            kind: "content",
            ref: { sha256: "b".repeat(64), byteLength: 26_214_400, mediaType: ascii(255), displayName: name(255) },
          })),
        ],
        metadata: {
          factoryMail: true,
          mailKind: "notice",
          subject: text(256),
          refs: Array.from({ length: 10 }, () => ({ kind: "url", url: ascii(256) })),
          fromSeat: seat,
          senderNodeId: node,
          senderName: text(256),
          senderRegions: Array.from({ length: MAX_REGION_DEPTH }, () => ({ id: node, name: text(256) })),
          senderGeneration: ascii(64),
          senderHarness: ascii(32),
          inReplyTo: ulid,
          threadId: ulid,
        },
      },
      sentBy: { seatId: seat, canvasName: canvas, nodeId: node },
      destination: { kind: "mailbox" },
    },
  });
};

it("fits the room a mail leaves for its envelope in plain text, and not with escaped text", () => {
  const plain = workRowBytes(envelope(false));
  const escaped = workRowBytes(envelope(true));
  // Measured 2026-10-21: 17,495 plain, 54,595 escaped, against 24,576.
  expect(plain).toBeLessThan(MAIL_ENVELOPE_BYTES);
  // Subject, sender name, region names and refs have no bound, and the wire takes canvas and node
  // names of 256 any characters: no fixed room covers them. This holds until they are bounded.
  expect(escaped).toBeGreaterThan(MAIL_ENVELOPE_BYTES);
});
