import { describe, expect, it } from "vitest";
import type { Message } from "../src/shared/work-model";
import {
  countMailViews,
  crewMailViewOf,
  deriveMailDisplay,
  parseMailEvidenceRef,
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
      queuedAt: 1,
      notifiedAt: 2,
      unresolvedAt: 3,
      refusedAt: undefined,
      refusedReason: undefined,
      readAt: 4,
      repliedAt: undefined,
      reactedAt: undefined,
      generation: "g1",
    };
    expect(deriveMailDisplay(facts)).toBe("read");
    expect(deriveMailDisplay({ ...facts, readAt: undefined })).toBe("unresolved");
    expect(
      deriveMailDisplay({
        ...facts,
        readAt: undefined,
        refusedAt: 5,
      }),
    ).toBe("unresolved");
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
});

describe("crewMailViewOf", () => {
  it("maps legacy deliveredAt to notified and refuses invented kinds", () => {
    const view = crewMailViewOf(
      message({ deliveredAt: 10, mailKind: "prompt", subject: "Wake" }),
      1,
    );
    expect(view.display).toBe("notified");
    expect(view.kind).toBe("prompt");
    expect(view.subject).toBe("Wake");
    expect(crewMailViewOf(message({ mailKind: "nope" }), 1).kind).toBeUndefined();
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

describe("stripMailEnvelope", () => {
  it("strips both current and legacy envelopes", () => {
    expect(stripMailEnvelope("mail from planner please read 01A")).toBe(
      "please read 01A",
    );
    expect(stripMailEnvelope("[factory mail from planner] please read 01A")).toBe(
      "please read 01A",
    );
    expect(stripMailEnvelope("plain")).toBe("plain");
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
