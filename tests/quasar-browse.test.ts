import { describe, expect, it } from "vitest";
import {
  buildSessionBookends,
  mapSearchMatches,
  parseProviderFromSessionId,
  sortAndMapSessions,
  topToolNames,
  trimExcerpt,
} from "../src/main/vellum/adapters/quasar";

describe("sortAndMapSessions", () => {
  // Server order is most-recent-first already; kimi is the only provider that
  // reliably populates updatedAt/startedAt, so a client-side re-sort keyed on
  // those fields floats kimi to the top and sinks claude/codex/antigravity
  // (null dates) to the bottom. Preserve server row order verbatim.
  const rows = [
    { sessionId: "a", provider: "claude", title: null, agentName: "claude-code", updatedAt: "2026-01-01T00:00:00Z", messageCount: 3, toolCallCount: 5 },
    { sessionId: "b", provider: "codex", title: "Named session", agentName: null, updatedAt: null, startedAt: "2026-03-01T00:00:00Z", messageCount: 1, toolCallCount: 0 },
    { sessionId: "c", provider: "claude", title: null, updatedAt: "2026-02-01T00:00:00Z", messageCount: 2, toolCallCount: 1 },
  ];

  it("preserves server row order (no re-sort)", () => {
    const mapped = sortAndMapSessions(rows, 10);
    expect(mapped.map((r) => r.sessionId)).toEqual(["a", "b", "c"]);
  });

  it("maps null title/agentName/updatedAt to undefined", () => {
    const mapped = sortAndMapSessions(rows, 10);
    const a = mapped.find((r) => r.sessionId === "a")!;
    expect(a.title).toBeUndefined();
    const b = mapped.find((r) => r.sessionId === "b")!;
    expect(b.agentName).toBeUndefined();
    expect(b.updatedAt).toBeUndefined();
  });

  it("passes updatedAt through unchanged when present", () => {
    const mapped = sortAndMapSessions(rows, 10);
    expect(mapped.find((r) => r.sessionId === "a")?.updatedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("respects the limit by taking the first N rows", () => {
    expect(sortAndMapSessions(rows, 1)).toHaveLength(1);
    expect(sortAndMapSessions(rows, 1)[0]?.sessionId).toBe("a");
  });

  it("passes a defined title through unchanged", () => {
    const mapped = sortAndMapSessions(rows, 10);
    expect(mapped.find((r) => r.sessionId === "b")?.title).toBe("Named session");
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

describe("buildSessionBookends", () => {
  it("picks the first user message and the last assistant message", () => {
    const rows = [
      { role: "user", text: "first ask", ts: "2026-07-12T05:17:09.000Z" },
      { role: "assistant", text: "first reply", ts: "2026-07-12T05:18:00.000Z" },
      { role: "user", text: "second ask", ts: "2026-07-12T05:19:00.000Z" },
      { role: "assistant", text: "final reply", ts: "2026-07-12T05:20:00.000Z" },
    ];
    const bookends = buildSessionBookends(rows);
    expect(bookends.firstUser).toBe("first ask");
    expect(bookends.lastAssistant).toBe("final reply");
    expect(bookends.startedAt).toBe("2026-07-12T05:17:09.000Z");
    expect(bookends.endedAt).toBe("2026-07-12T05:20:00.000Z");
  });

  it("trims firstUser to 600 chars and lastAssistant to 900 chars with an ellipsis", () => {
    const rows = [
      { role: "user", text: "u".repeat(700), ts: "2026-01-01T00:00:00Z" },
      { role: "assistant", text: "a".repeat(1000), ts: "2026-01-01T00:01:00Z" },
    ];
    const bookends = buildSessionBookends(rows);
    expect(bookends.firstUser).toHaveLength(600);
    expect(bookends.firstUser?.endsWith("…")).toBe(true);
    expect(bookends.lastAssistant).toHaveLength(900);
    expect(bookends.lastAssistant?.endsWith("…")).toBe(true);
  });

  it("returns all-undefined for an empty row set", () => {
    expect(buildSessionBookends([])).toEqual({
      firstUser: undefined,
      lastAssistant: undefined,
      startedAt: undefined,
      endedAt: undefined,
    });
  });

  it("skips rows with no text/ts instead of throwing", () => {
    const rows = [
      { role: "user", text: null, ts: null },
      { role: "assistant", text: "reply", ts: "2026-01-01T00:00:00Z" },
    ];
    const bookends = buildSessionBookends(rows);
    expect(bookends.firstUser).toBeUndefined();
    expect(bookends.lastAssistant).toBe("reply");
    expect(bookends.startedAt).toBe("2026-01-01T00:00:00Z");
  });
});

describe("topToolNames", () => {
  it("ranks tool names by frequency, capped at 3", () => {
    const rows = [
      { toolName: "Bash" }, { toolName: "Bash" }, { toolName: "Bash" },
      { toolName: "Write" }, { toolName: "Write" },
      { toolName: "Edit" },
      { toolName: "Read" },
    ];
    expect(topToolNames(rows)).toEqual(["Bash", "Write", "Edit"]);
  });

  it("skips rows with no toolName", () => {
    expect(topToolNames([{ toolName: null }, { toolName: "Bash" }])).toEqual(["Bash"]);
  });

  it("returns an empty array for no rows", () => {
    expect(topToolNames([])).toEqual([]);
  });
});

describe("parseProviderFromSessionId", () => {
  it("takes the prefix before the first colon", () => {
    expect(parseProviderFromSessionId("codex:725dff0e74177a0148bbb4bc5bb0178f")).toBe("codex");
    expect(parseProviderFromSessionId("claude:4f3e61be4e66a78f20b3290c1fd46bbd")).toBe("claude");
  });

  it("returns the whole string when there is no colon", () => {
    expect(parseProviderFromSessionId("no-colon-here")).toBe("no-colon-here");
  });
});
