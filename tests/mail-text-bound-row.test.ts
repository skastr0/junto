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
import { MAIL_SENDER_REGIONS_MAX, REGION_NAME_MAX } from "../src/shared/region-bounds";
import { MAIL_ENVELOPE_BYTES, MAIL_TEXT_INLINE_MAX_BYTES, mailTextBytes } from "../src/shared/mail-text-bound";
import { OPERATOR_ATTACHMENTS_MAX } from "../src/shared/operator-attachments";
import { asNodeId } from "../src/shared/physics/schema";
import { PAGE_BOX_URL_MAX_BYTES, TEXT_QUOTE_MAX, type ResourceSubject, textAnchorOf, threadSubjectMetadata } from "../src/shared/thread-subject";
import { ContentRef } from "../src/shared/wire/content-ref";
import { ItemId } from "../src/shared/work-ids";
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
const regions = Array.from({ length: MAIL_SENDER_REGIONS_MAX }, (_, depth) => ({
  id: `region-${ulid}`,
  name: `${depth % 10}${"語".repeat(REGION_NAME_MAX - 1)}`,
}));

/** A page's widest address: a host, then three-byte characters percent-encoded, to its bound. */
const widestPageUrl = (() => {
  const head = "https://x.example/";
  const room = PAGE_BOX_URL_MAX_BYTES - head.length;
  const encoded = "%E8%AA%9E";
  return `${head}${encoded.repeat(Math.floor(room / encoded.length))}${"a".repeat(room % encoded.length)}`;
})();

/** A subject's widest anchors: a quote in three-byte characters, and a page box with its url and shot at their bounds. */
const subjects: ReadonlyArray<ResourceSubject> = [
  { kind: "artifact", nodeId: asNodeId(`artifacts-${ulid}`), artifactId: Schema.decodeSync(ItemId)(ulid), anchor: textAnchorOf("語".repeat(TEXT_QUOTE_MAX + 50), Number.MAX_SAFE_INTEGER) },
  {
    kind: "page",
    nodeId: asNodeId(`page-${ulid}`),
    anchor: {
      kind: "box",
      x: -Number.MAX_SAFE_INTEGER,
      y: -Number.MAX_SAFE_INTEGER,
      w: Number.MAX_SAFE_INTEGER,
      h: Number.MAX_SAFE_INTEGER,
      url: widestPageUrl,
      scroll: { x: -Number.MAX_SAFE_INTEGER, y: Number.MAX_SAFE_INTEGER },
      shot: Schema.decodeSync(ContentRef)({ sha256: "a".repeat(64), byteLength: Number.MAX_SAFE_INTEGER, mediaType: "image/png" }),
    },
  },
];

const mailWith = (text: string, subject: ResourceSubject = subjects[0]!) =>
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
          ...threadSubjectMetadata(subject),
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
  it.each(subjects.map((subject) => ["anchor" in subject ? subject.anchor?.kind : "no", subject] as const))("leaves room for the longest envelope, %s anchored", (_kind, subject) => {
    const envelope = workRowBytes(mailWith("", subject));
    const text = "x".repeat(MAIL_TEXT_INLINE_MAX_BYTES);
    expect(mailTextBytes(text)).toBe(MAIL_TEXT_INLINE_MAX_BYTES);
    expect({ envelope, fits: envelope <= MAIL_ENVELOPE_BYTES }).toEqual({ envelope, fits: true });
    expect(assertWorkRowBound(mailWith(text, subject))).toBeUndefined();
  });

  it("quotes a long selection from its start, to the bound", () => {
    expect(textAnchorOf("a".repeat(TEXT_QUOTE_MAX + 1), 3)).toEqual({ kind: "text", quote: "a".repeat(TEXT_QUOTE_MAX), offset: 3 });
  });
});
