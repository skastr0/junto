import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { Message } from "../src/shared/work-model";
import {
  countMailViews,
  crewMailViewOf,
  mailDeliveryLabel,
  parseMailEvidenceRef,
  resolveMailSenderNodeId,
  resolveMailSenderStamp,
  stripMailEnvelope,
} from "../src/renderer/lib/crew-mail-view";

const message = (metadata: Message["metadata"], text = "hello"): Message => ({
  messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  role: "user",
  parts: [{ kind: "text", text }],
  metadata,
});

describe("crewMailViewOf", () => {
  it("is delivered once the text was written into the seat, waiting before", () => {
    const waiting = crewMailViewOf(message({ mailKind: "prompt", subject: "Wake" }));
    expect(waiting.delivery).toBe("waiting");
    expect(mailDeliveryLabel(waiting.delivery)).toBe("waiting for seat");
    expect(waiting.kind).toBe("prompt");
    expect(waiting.subject).toBe("Wake");
    expect(waiting.read).toBe(false);

    const delivered = crewMailViewOf(message({ deliveredAt: 10 }));
    expect(delivered.delivery).toBe("delivered");
    expect(mailDeliveryLabel(delivered.delivery)).toBe("delivered");
  });

  it("keeps read apart from delivery and never invents either", () => {
    const readOnly = crewMailViewOf(message({ readAt: 20 }));
    expect(readOnly.read).toBe(true);
    expect(readOnly.delivery).toBe("waiting");
    expect(crewMailViewOf(message({ deliveredAt: "soon" })).delivery).toBe("waiting");
    expect(crewMailViewOf(message({ mailKind: "nope" })).kind).toBeUndefined();
  });

  it("parses typed refs and drops unknown shapes", () => {
    const view = crewMailViewOf(
      message({
        refs: [
          { kind: "commit", sha: "abc123def456" },
          { kind: "file", path: "src/a.ts", line: 12 },
          { kind: "mystery", sha: "nope" },
        ],
      }),
    );
    expect(view.refs).toEqual([
      { kind: "commit", sha: "abc123def456" },
      { kind: "file", path: "src/a.ts", line: 12 },
    ]);
    expect(parseMailEvidenceRef({ kind: "url", url: "https://example.com" })).toEqual({
      kind: "url",
      url: "https://example.com",
    });
  });
});

describe("resolveMailSenderNodeId", () => {
  const doc: CanvasDoc = {
    nodes: [
      {
        id: "bravo",
        type: "text",
        text: "Bravo",
        x: 0,
        y: 0,
        width: 100,
        height: 80,
      },
    ],
    edges: [],
  };

  it("prefers senderNodeId and only uses fromSeat when it is a node id", () => {
    expect(
      resolveMailSenderNodeId(doc, {
        fromSeat: "seat_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        senderNodeId: "bravo",
      }),
    ).toBe("bravo");
    expect(resolveMailSenderNodeId(doc, { fromSeat: "bravo" })).toBe("bravo");
    expect(
      resolveMailSenderNodeId(doc, {
        fromSeat: "seat_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    ).toBeUndefined();
    expect(
      resolveMailSenderStamp({
        fromSeat: "seat_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    ).toBe(
      "seat_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
  });
});

describe("stripMailEnvelope", () => {
  it("strips only a stamp-matched envelope and leaves ordinary body", () => {
    const stamped = message({ fromSeat: "planner" });
    expect(
      stripMailEnvelope("mail from planner please read 01A", stamped),
    ).toBe("please read 01A");
    expect(
      stripMailEnvelope("[factory mail from planner] please read 01A", stamped),
    ).toBe("please read 01A");
    expect(
      stripMailEnvelope("mail from the future is here", stamped),
    ).toBe("mail from the future is here");
    expect(stripMailEnvelope("plain", stamped)).toBe("plain");
    expect(
      stripMailEnvelope("[factory mail from planner] leftover", stamped),
    ).toBe("leftover");
  });
});

describe("mail counts", () => {
  it("counts inbound unread mail only", () => {
    const rows = [
      { direction: "in" as const, read: false },
      { direction: "in" as const, read: true },
      { direction: "note" as const, read: false },
    ];
    expect(countMailViews(rows)).toEqual({ total: 3, unread: 1 });
  });
});
