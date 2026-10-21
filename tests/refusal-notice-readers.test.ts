/**
 * How a resource's notice reads (R2 step 4, point 6): from the refused node
 * as the canvas names it, never by a name or id the writing machine stamped,
 * with no reply command, and with no operator files.
 */
import { describe, expect, it } from "vitest";
import { NOTICE_SEAT_ID } from "../src/shared/mail-author";
import { operatorFilesOf, seatMailThreadMessages, type MailThreadsInput } from "../src/shared/mail-threads";
import { composeMessageDeliveryPayload, REMOVED_RESOURCE } from "../src/shared/message-delivery";
import { makeUserMessage } from "../src/shared/task";

const notice = (senderNodeId: string, senderName = "Operator") =>
  makeUserMessage({
    messageId: "01M5EX9000000000000000000N",
    text: "task assign was refused",
    contextId: "factory",
    metadata: {
      factoryMail: true,
      fromSeat: NOTICE_SEAT_ID,
      senderNodeId,
      senderName,
      mailKind: "notice",
      subjectNotice: "refusal",
      attachments: [{ sha256: "a".repeat(64), byteLength: 1, mediaType: "text/plain" }],
    },
  });

const threads = (row: ReturnType<typeof notice>, names: Record<string, string>): MailThreadsInput => ({
  mailboxes: [{ nodeId: "peer", messages: [row] }],
  nameOf: (nodeId) => names[nodeId],
});

describe("a resource's notice", () => {
  it("is named by the canvas, or as a removed resource, never by its stamped name or id", () => {
    const header = composeMessageDeliveryPayload(notice("board-1")).split("\n")[0]!;
    expect(header).toBe(`mail from ${REMOVED_RESOURCE}, id 01M5EX9000000000000000000N`);
    expect(header).not.toContain("Operator");
    expect(header).not.toContain("reply");
  });

  it("is in the thread from its node as the canvas names it, and from a removed resource otherwise", () => {
    const named = seatMailThreadMessages(threads(notice("board-1"), { "board-1": "Tasks" }), "peer", "01M5EX9000000000000000000N");
    expect(named?.[0]?.from).toEqual({ kind: "seat", nodeId: "board-1", name: "Tasks" });
    const gone = seatMailThreadMessages(threads(notice("board-1"), {}), "peer", "01M5EX9000000000000000000N");
    expect(gone?.[0]?.from).toEqual({ kind: "seat", nodeId: "board-1", name: REMOVED_RESOURCE });
  });

  it("naming the operator's node is no thread mail", () => {
    expect(seatMailThreadMessages(threads(notice("operator"), {}), "peer", "01M5EX9000000000000000000N") ?? []).toEqual([]);
  });

  it("carries no operator files", () => {
    expect(operatorFilesOf(notice("board-1", "operator"))).toEqual([]);
  });
});
