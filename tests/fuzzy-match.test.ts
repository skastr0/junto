import { describe, expect, it } from "vitest";
import { fuzzyMatch, rankMatches } from "../src/renderer/lib/fuzzy-match";

const scoreOf = (query: string, identity: readonly string[], metadata: readonly string[] = []) =>
  fuzzyMatch(query, { identity, metadata })?.score ?? null;

describe("fuzzyMatch tiers", () => {
  it("scores exact, prefix, word-prefix, acronym, substring, and subsequence", () => {
    expect(scoreOf("claude code", ["Claude Code"])).toBe(5000 + 4000);
    expect(scoreOf("claud", ["Claude Code"])).toBe(5000);
    expect(scoreOf("code", ["Claude Code"])).toBe(4000);
    expect(scoreOf("1m", ["opus[1m]"])).toBe(4000);
    expect(scoreOf("cc", ["Claude Code"])).toBe(3000);
    expect(scoreOf("aude", ["Claude Code"])).toBe(2000);
    expect(scoreOf("claudec", ["Claude Code"])).toBe(1000);
  });

  it("matches the palette queries that substring-on-name missed", () => {
    expect(scoreOf("cc", ["Claude Code", "claude"])).toBe(3000);
    expect(scoreOf("claudec", ["Claude Code", "claude"])).toBe(1000);
    expect(scoreOf("code claude", ["Claude Code", "claude"])).toBe(4000 + 6000);
  });

  it("requires every token to hit, each inside one field", () => {
    expect(scoreOf("code claude", ["Claude Code"])).not.toBeNull();
    expect(scoreOf("code missing", ["Claude Code"])).toBeNull();
    expect(scoreOf("claudecode", ["Claude", "Code"])).toBeNull();
  });

  it("keeps punctuation literal and never treats the query as a regex", () => {
    expect(scoreOf("opus[1m]", ["opus[1m]"])).toBe(6000);
    expect(scoreOf(".*", ["opus"])).toBeNull();
    expect(scoreOf("a+", ["aa"])).toBeNull();
  });

  it("limits metadata to contiguous substring", () => {
    expect(scoreOf("queue", ["Tasks"], ["shared work queue"])).toBe(2000);
    expect(scoreOf("swq", ["Tasks"], ["shared work queue"])).toBeNull();
    expect(scoreOf("swqueue", ["Tasks"], ["shared work queue"])).toBeNull();
  });
});

describe("rankMatches", () => {
  const items = [
    { id: "codex", displayName: "Codex" },
    { id: "claude", displayName: "Claude Code" },
    { id: "grok", displayName: "Grok" },
  ];
  const fieldsOf = (item: (typeof items)[number]) => ({
    identity: [item.displayName, item.id],
  });

  it("preserves input order on an empty query without calling the matcher", () => {
    expect(rankMatches(items, "   ", fieldsOf).map((row) => row.item.id)).toEqual([
      "codex",
      "claude",
      "grok",
    ]);
    expect(rankMatches(items, "", fieldsOf).every((row) => row.score === 0)).toBe(true);
  });

  it("ranks stronger identity hits first and uses original index as a tie-break", () => {
    const ranked = rankMatches(items, "c", fieldsOf);
    expect(ranked.map((row) => row.item.id)).toEqual(["codex", "claude"]);
    expect(ranked[0]?.score).toBe(ranked[1]?.score);
    expect(ranked[0]?.index).toBeLessThan(ranked[1]!.index);
  });

  it("does not mutate the input", () => {
    const copy = [...items];
    rankMatches(items, "claude", fieldsOf);
    expect(items).toEqual(copy);
  });

  it("treats query code as a prefix of Codex", () => {
    expect(scoreOf("code", ["Codex"])).toBe(5000);
  });
});
