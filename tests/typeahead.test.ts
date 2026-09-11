import { describe, expect, it } from "vitest";
import {
  TYPEAHEAD_EXPIRY_MS,
  typeaheadAccept,
  typeaheadIndex,
} from "../src/renderer/lib/typeahead";

const empty = { text: "", at: 0 };

describe("typeaheadAccept", () => {
  it("appends within the expiry window and lowercases", () => {
    const first = typeaheadAccept(empty, "Z", 1_000);
    expect(first).toEqual({ text: "z", at: 1_000 });
    expect(typeaheadAccept(first, "e", 1_000 + TYPEAHEAD_EXPIRY_MS).text).toBe("ze");
  });

  it("resets after the expiry window", () => {
    const first = typeaheadAccept(empty, "z", 1_000);
    expect(typeaheadAccept(first, "e", 1_000 + TYPEAHEAD_EXPIRY_MS + 1).text).toBe("e");
  });

  it("keeps a one-character buffer for rapid repeated keys", () => {
    const first = typeaheadAccept(empty, "a", 1_000);
    const second = typeaheadAccept(first, "a", 1_100);
    const third = typeaheadAccept(second, "a", 1_200);
    expect(second.text).toBe("a");
    expect(third.text).toBe("a");
  });
});

describe("typeaheadIndex", () => {
  const labels = ["Opus 4.6", "Sonnet", "Haiku", "Zephyr 1", "high", "xhigh"];

  it("takes the first prefix hit after the current item, then wraps", () => {
    expect(typeaheadIndex(labels, "s", 0)).toBe(1);
    expect(typeaheadIndex(labels, "h", 4)).toBe(2);
    expect(typeaheadIndex(["Haiku", "high", "xhigh"], "h", 1)).toBe(0);
  });

  it("cycles repeated single-character prefix hits", () => {
    const names = ["alpha", "alpine", "beta"];
    const first = typeaheadIndex(names, "a", -1);
    expect(first).toBe(0);
    expect(typeaheadIndex(names, "a", first!)).toBe(1);
    expect(typeaheadIndex(names, "a", 1)).toBe(0);
  });

  it("uses fuzzy fallback only when the buffer has two or more characters", () => {
    expect(typeaheadIndex(["Claude Code", "Codex"], "cc", -1)).toBe(0);
    expect(typeaheadIndex(["Claude Code", "Codex"], "x", -1)).toBeNull();
  });

  it("keeps traversal order on equal fuzzy scores and leaves focus on a miss", () => {
    expect(typeaheadIndex(["ab", "ac"], "zz", 0)).toBeNull();
    expect(typeaheadIndex(["Kite", "Kate"], "kt", -1)).toBe(0);
  });
});
