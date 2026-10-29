import { describe, expect, it } from "vitest";
import { signalWordCount as wordCountOf } from "../src/shared/word-count";
import { afterEach, vi } from "vitest";
import { dueWords, handInSignalWork, replyRefusalOf, sentenceOf, wordProgressOf, wordProgressWords, workIsDue } from "../src/renderer/lib/signal-work";
import { artifactLabelsOf } from "../src/shared/artifact-labels";

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
    expect(workIsDue({}, now)).toBe(false);
    expect(workIsDue({ dueAt: now + 1 }, now)).toBe(false);
    expect(workIsDue({ dueAt: now }, now)).toBe(true);
    expect(workIsDue({ urgent: true, dueAt: now + 1 }, now)).toBe(true);
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

describe("handing in, by main's rule", () => {
  const replyId = "01M62RNQ72ZFW5NRP2AJXQVN1Z";
  const form = { kind: "artifact", nodeId: "shelf-1", title: "Pages", labels: artifactLabelsOf([])!, minWords: 3 } as const;
  afterEach(() => vi.unstubAllGlobals());

  it("says main's refusal as a sentence, and nothing when it would be taken", () => {
    expect(sentenceOf("the document holds 2 words of 3")).toBe("The document holds 2 words of 3.");
    expect(sentenceOf("ftp://x: only http and https addresses can be attached.")).toBe("Ftp://x: only http and https addresses can be attached.");
    expect(replyRefusalOf(form, { kind: "artifact", markdown: "one two", replyId })).toBe("The document holds 2 words of 3.");
    expect(replyRefusalOf(form, { kind: "artifact", markdown: "one two three", replyId })).toBeUndefined();
    expect(replyRefusalOf({ kind: "proof" }, { kind: "proof", text: " ", links: ["https://a.b"], replyId })).toBe("Proof needs a sentence saying what it shows.");
  });

  it("sends the reply through agentSignalReply, and a refusal comes back as a sentence", async () => {
    const reply = vi.fn(async () => ({ ok: false as const, message: "the document holds 212 words of 500" }));
    vi.stubGlobal("window", { junto: { agentSignalReply: reply } });
    const sent = { kind: "artifact", markdown: "x", replyId } as const;
    expect(await handInSignalWork("s1", sent)).toEqual({ ok: false, message: "The document holds 212 words of 500." });
    expect(reply).toHaveBeenCalledWith("s1", sent);
  });
});
