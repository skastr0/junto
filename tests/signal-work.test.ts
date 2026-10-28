import { describe, expect, it } from "vitest";
import { signalWordCount as wordCountOf } from "../src/shared/word-count";
import { dueWords, wordProgressOf, wordProgressWords, workLevel } from "../src/renderer/lib/signal-work";

describe("word count", () => {
  it("counts what a reader reads: markdown's own marks are not words", () => {
    expect(wordCountOf("")).toBe(0);
    expect(wordCountOf("# Morning pages\n\n- one\n- two\n\n> a **bold** claim")).toBe(7);
    expect(wordCountOf("Read [the long spec](https://example.com/a/b) today.")).toBe(5);
    // An address is not a word, nor is a fence line; the code between counts.
    expect(wordCountOf("see https://example.com and <https://a.b> or www.example.com")).toBe(3);
    expect(wordCountOf("```ts\nconst a = 1;\n```")).toBe(3);
    expect(wordCountOf("well-known café, 2026")).toBe(3);
    expect(wordCountOf("--- *** ## >")).toBe(0);
    expect(wordCountOf("kept <!-- not this --> kept")).toBe(2);
  });
});

describe("the condition as it fills", () => {
  it("says words so far of the minimum, and is met only at it", () => {
    const some = wordProgressOf("one two three", 500);
    expect(wordProgressWords(some)).toBe("3 words of 500");
    expect(some.met).toBe(false);
    expect(wordProgressOf(Array.from({ length: 500 }, () => "w").join(" "), 500).met).toBe(true);
    expect(wordProgressWords(wordProgressOf("one", 1))).toBe("1 word");
    // The default minimum is one: any written word meets it, an empty reply never does.
    expect(wordProgressOf("one", 1).met).toBe(true);
    expect(wordProgressOf("  ", 1).met).toBe(false);
  });
});

describe("work on the ladder", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  it("is todo until urgent or past due", () => {
    expect(workLevel({}, now)).toBe("todo");
    expect(workLevel({ dueAt: now + 1 }, now)).toBe("todo");
    expect(workLevel({ dueAt: now }, now)).toBe("due");
    expect(workLevel({ urgent: true, dueAt: now + 1 }, now)).toBe("due");
  });

  it("says when it is due in the operator's day", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(dueWords(undefined, now, "UTC")).toBeUndefined();
    expect(dueWords(at("2026-10-28T18:00:00Z"), now, "UTC")).toBe("due 18:00");
    expect(dueWords(at("2026-10-28T09:00:00Z"), now, "UTC")).toBe("was due 09:00");
    expect(dueWords(at("2026-10-29T09:00:00Z"), now, "UTC")).toBe("due tomorrow 09:00");
    expect(dueWords(at("2026-10-27T09:00:00Z"), now, "UTC")).toBe("was due yesterday 09:00");
    expect(dueWords(at("2026-10-30T09:00:00Z"), now, "UTC")).toBe("due Fri 09:00");
    expect(dueWords(at("2026-11-12T09:00:00Z"), now, "UTC")).toBe("due 12 Nov");
  });
});
