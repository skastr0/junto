import { describe, expect, it } from "vitest";
import { mapSearchMatches, sortAndMapSessions, trimExcerpt } from "../src/main/vellum/adapters/quasar";

describe("sortAndMapSessions", () => {
  const rows = [
    { sessionId: "a", provider: "claude", title: null, agentName: "claude-code", updatedAt: "2026-01-01T00:00:00Z", messageCount: 3, toolCallCount: 5 },
    { sessionId: "b", provider: "codex", title: "Named session", agentName: null, updatedAt: null, startedAt: "2026-03-01T00:00:00Z", messageCount: 1, toolCallCount: 0 },
    { sessionId: "c", provider: "claude", title: null, updatedAt: "2026-02-01T00:00:00Z", messageCount: 2, toolCallCount: 1 },
  ];

  it("sorts desc by updatedAt falling back to startedAt", () => {
    const sorted = sortAndMapSessions(rows, 10);
    expect(sorted.map((r) => r.sessionId)).toEqual(["b", "c", "a"]);
  });

  it("maps null title/agentName/updatedAt to undefined", () => {
    const sorted = sortAndMapSessions(rows, 10);
    const a = sorted.find((r) => r.sessionId === "a")!;
    expect(a.title).toBeUndefined();
    const b = sorted.find((r) => r.sessionId === "b")!;
    expect(b.agentName).toBeUndefined();
    expect(b.updatedAt).toBeUndefined();
  });

  it("respects the limit after sorting", () => {
    expect(sortAndMapSessions(rows, 1)).toHaveLength(1);
    expect(sortAndMapSessions(rows, 1)[0]?.sessionId).toBe("b");
  });

  it("passes a defined title through unchanged", () => {
    const sorted = sortAndMapSessions(rows, 10);
    expect(sorted.find((r) => r.sessionId === "b")?.title).toBe("Named session");
  });
});

describe("trimExcerpt", () => {
  it("collapses whitespace/newlines to single spaces", () => {
    expect(trimExcerpt("line one\n  line   two\t\tend")).toBe("line one line two end");
  });

  it("passes short text through unchanged", () => {
    expect(trimExcerpt("short text")).toBe("short text");
  });

  it("truncates to 220 chars with a trailing ellipsis", () => {
    const long = "x".repeat(300);
    const trimmed = trimExcerpt(long);
    expect(trimmed.length).toBe(220);
    expect(trimmed.endsWith("…")).toBe(true);
  });
});

describe("mapSearchMatches (quasar)", () => {
  it("flattens row fields and trims text", () => {
    const matches = [
      {
        score: 0.5,
        row: { sessionId: "s1", role: "assistant", provider: "claude", text: "  hello   world  " },
      },
    ];
    expect(mapSearchMatches(matches)).toEqual([
      { sessionId: "s1", role: "assistant", provider: "claude", text: "hello world", score: 0.5 },
    ]);
  });
});
