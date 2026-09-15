import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { Message } from "../src/shared/work-model";
import {
  countMailViews,
  crewMailViewOf,
  deriveMailDisplay,
  parseMailEvidenceRef,
  resolveMailSenderNodeId,
  resolveMailSenderStamp,
  stripMailEnvelope,
  unresolvedMailByPeer,
} from "../src/renderer/lib/crew-mail-view";

const message = (metadata: Message["metadata"], text = "hello"): Message => ({
  messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  role: "user",
  parts: [{ kind: "text", text }],
  metadata,
});

describe("deriveMailDisplay", () => {
  it("keeps transport and receipt facts distinct, receipt winning the chip", () => {
    const facts = {
      queuedAt: "2026-01-01T00:00:01.000Z",
      notifiedAt: "2026-01-01T00:00:02.000Z",
      unresolvedAt: "2026-01-01T00:00:03.000Z",
      refusedAt: undefined,
      refusedReason: undefined,
      readAt: "2026-01-01T00:00:04.000Z",
      repliedAt: undefined,
      reactedAt: undefined,
      generation: "g1",
    };
    expect(deriveMailDisplay(facts)).toBe("read");
    expect(deriveMailDisplay({ ...facts, readAt: undefined })).toBe("notified");
    expect(
      deriveMailDisplay({
        ...facts,
        readAt: undefined,
        refusedAt: "2026-01-01T00:00:05.000Z",
      }),
    ).toBe("notified");
    expect(deriveMailDisplay({ ...facts, unresolvedAt: undefined, readAt: undefined })).toBe(
      "notified",
    );
    expect(
      deriveMailDisplay({
        ...facts,
        notifiedAt: undefined,
        unresolvedAt: undefined,
        readAt: undefined,
      }),
    ).toBe("queued");
  });

  it("shows an acknowledged retry as notified while preserving prior refusal and uncertainty", () => {
    const metadata = {
      generation: "g1",
      queuedAt: "2026-01-01T00:00:01.000Z",
      refusedAt: "2026-01-01T00:00:02.000Z",
      refusedReason: "not-settled",
      unresolvedAt: "2026-01-01T00:00:03.000Z",
      notifiedAt: "2026-01-01T00:00:04.000Z",
    };
    const view = crewMailViewOf(message(metadata), 1);
    expect(view.display).toBe("notified");
    expect(view.facts.refusedAt).toBe(metadata.refusedAt);
    expect(view.facts.unresolvedAt).toBe(metadata.unresolvedAt);
    expect(view.facts.readAt).toBeUndefined();
    const { notifiedAt: _notifiedAt, ...unacknowledged } = metadata;
    expect(crewMailViewOf(message(unacknowledged), 1).display).toBe("unresolved");
  });
});

describe("crewMailViewOf", () => {
  it("maps legacy deliveredAt to notifiedAt only, never from readAt", () => {
    const legacy = crewMailViewOf(
      message({ deliveredAt: 10, mailKind: "prompt", subject: "Wake" }),
      1,
    );
    expect(legacy.display).toBe("notified");
    expect(legacy.kind).toBe("prompt");
    expect(legacy.subject).toBe("Wake");
    expect(legacy.facts.notifiedAt).toBe(new Date(10).toISOString());
    const transportWins = crewMailViewOf(
      message({
        generation: "g-live",
        queuedAt: "2026-01-01T00:00:00.000Z",
        notifiedAt: "2026-01-01T00:00:01.000Z",
        deliveredAt: 99,
      }),
      1,
    );
    expect(transportWins.facts.notifiedAt).toBe("2026-01-01T00:00:01.000Z");
    const readOnly = crewMailViewOf(message({ readAt: 20 }), 1);
    expect(readOnly.display).toBe("read");
    expect(readOnly.facts.notifiedAt).toBeUndefined();
    expect(crewMailViewOf(message({ mailKind: "nope" }), 1).kind).toBeUndefined();
  });

  it("reads loadInbox reactions as the react receipt and attempt facts when stamped", () => {
    const receipts = crewMailViewOf(
      message({
        reactions: [{ kind: "ack", at: 1_704_067_200_000 }],
        readAt: 1_704_067_100_000,
      }),
      1,
    );
    expect(receipts.display).toBe("reacted");
    expect(receipts.facts.readAt).toBe(new Date(1_704_067_100_000).toISOString());
    const transport = crewMailViewOf(
      message({
        generation: "g-live",
        queuedAt: "2026-01-01T00:00:00.000Z",
        notifiedAt: "2026-01-01T00:00:01.000Z",
      }),
      1,
    );
    expect(transport.display).toBe("notified");
    expect(transport.facts.generation).toBe("g-live");
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
      1,
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

describe("mailAttemptFactsOf via crewMailViewOf", () => {
  it("ignores refuseReason and only reads refusedReason", () => {
    const ignored = crewMailViewOf(
      message({
        generation: "gen-1",
        queuedAt: "2026-01-01T00:00:00.000Z",
        refusedAt: "2026-01-01T00:00:04.000Z",
        refuseReason: "seat-busy",
      }),
      1,
    );
    expect(ignored.display).toBe("refused");
    expect(ignored.displayReason).toBeUndefined();
    expect(ignored.facts.refusedReason).toBeUndefined();
    const named = crewMailViewOf(
      message({
        generation: "gen-1",
        queuedAt: "2026-01-01T00:00:00.000Z",
        refusedAt: "2026-01-01T00:00:04.000Z",
        refusedReason: "seat-busy",
      }),
      1,
    );
    expect(named.facts.refusedReason).toBe("seat-busy");
    expect(named.displayReason).toBe("seat-busy");
  });

  it("reads flat MailAttemptFacts names and ranks notified above unresolved above refusal", () => {
    const view = crewMailViewOf(
      message({
        generation: "gen-1",
        queuedAt: "2026-01-01T00:00:00.000Z",
        unresolvedAt: "2026-01-01T00:00:03.000Z",
        refusedAt: "2026-01-01T00:00:04.000Z",
        refusedReason: "written-no-evidence",
      }),
      1,
    );
    expect(view.display).toBe("unresolved");
    expect(view.displayReason).toBeUndefined();
    expect(view.facts.generation).toBe("gen-1");
    expect(view.facts.refusedReason).toBe("written-no-evidence");
    expect(
      crewMailViewOf(
        message({
          ...view.facts,
          notifiedAt: "2026-01-01T00:00:05.000Z",
        }),
        1,
      ).display,
    ).toBe("notified");
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
  it("counts unresolved separately from unread", () => {
    const rows = [
      { direction: "in" as const, display: "unresolved" as const, read: false },
      { direction: "in" as const, display: "read" as const, read: true },
      { direction: "note" as const, display: "queued" as const, read: false },
    ];
    expect(countMailViews(rows)).toEqual({ total: 3, unread: 1, unresolved: 1 });
    expect(
      unresolvedMailByPeer([
        { direction: "in", display: "unresolved", fromNodeId: "bravo" },
        { direction: "in", display: "read", fromNodeId: "bravo" },
      ]).get("bravo"),
    ).toBe(1);
  });
});
