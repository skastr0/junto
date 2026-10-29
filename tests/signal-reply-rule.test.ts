/**
 * The one rule a signal's reply is ruled by: the form's condition against
 * what the operator handed in. The pane fills a meter from the same words and
 * the same addresses, so what the meter says is met is what main accepts, and
 * what main refuses names the shortfall in the same words.
 */
import { describe, expect, it } from "vitest";
import { ruleSignalReply, SIGNAL_PROOF_LINKS_MAX } from "../src/shared/signal-reply";
import { artifactLabelOf } from "../src/shared/artifact-labels";
import type { SignalForm } from "../src/shared/wire/agent-signals";

const document = (minWords: number): SignalForm => ({
  kind: "artifact",
  nodeId: "shelf" as SignalForm extends { kind: "artifact"; nodeId: infer N } ? N : never,
  title: "Morning pages",
  labels: [artifactLabelOf("daily")!],
  minWords,
});

const words = (count: number): string => Array.from({ length: count }, () => "word").join(" ");

describe("a signal's reply is ruled by its form", () => {
  it("a document meets its word condition exactly at it", () => {
    expect(ruleSignalReply(document(5), { kind: "artifact", markdown: words(5), replyId: "r1" })).toEqual({ ok: true, words: 5 });
    expect(ruleSignalReply(document(5), { kind: "artifact", markdown: words(4), replyId: "r2" })).toEqual({
      ok: false,
      message: "the document holds 4 words of 5",
    });
    // The default condition of one word: any written word meets it, an empty document never does.
    expect(ruleSignalReply(document(1), { kind: "artifact", markdown: words(1), replyId: "r3" }).ok).toBe(true);
    expect(ruleSignalReply(document(1), { kind: "artifact", markdown: "   ", replyId: "r4" })).toEqual({
      ok: false,
      message: "the document is empty",
    });
  });

  it("counts words as the one word rule counts them, not by spaces", () => {
    const ruled = ruleSignalReply(document(3), { kind: "artifact", markdown: "# Title\n\n- one\n- two", replyId: "r5" });
    expect(ruled).toEqual({ ok: true, words: 3 });
  });

  it("refuses a reply of the other kind, saying which the signal asks for", () => {
    expect(ruleSignalReply(document(1), { kind: "proof", text: "done", links: [], replyId: "r6" })).toEqual({
      ok: false,
      message: "this signal asks for a document; write it in the signal",
    });
    const proof: SignalForm = { kind: "proof" };
    expect(ruleSignalReply(proof, { kind: "artifact", markdown: "done", replyId: "r7" })).toEqual({
      ok: false,
      message: "this signal asks for proof: its words with links or files",
    });
  });

  it("proof needs a sentence and addresses the wire admits", () => {
    const proof: SignalForm = { kind: "proof" };
    expect(ruleSignalReply(proof, { kind: "proof", text: " ", links: [], replyId: "r8" })).toEqual({
      ok: false,
      message: "proof needs a sentence saying what it shows",
    });
    expect(ruleSignalReply(proof, { kind: "proof", text: "shipped", links: ["https://example.com/run/1"], replyId: "r9" })).toEqual({
      ok: true,
      words: 1,
    });
    expect(ruleSignalReply(proof, { kind: "proof", text: "shipped", links: ["not a link"], replyId: "r10" })).toEqual({
      ok: false,
      message: "not a link: not a web address.",
    });
    expect(
      ruleSignalReply(proof, {
        kind: "proof",
        text: "shipped",
        links: Array.from({ length: SIGNAL_PROOF_LINKS_MAX + 1 }, (_, index) => `https://example.com/${index}`),
        replyId: "r11",
      }),
    ).toEqual({ ok: false, message: `proof carries at most ${SIGNAL_PROOF_LINKS_MAX} links` });
  });

  it("a secret's reply is the vault's, and a text form takes words", () => {
    const secret: SignalForm = {
      kind: "secret",
      name: "CLOUDFLARE_TOKEN",
      requestId: "request-1",
      regionId: "region-1",
      machine: "macbook",
    };
    expect(ruleSignalReply(secret, { kind: "proof", text: "set", links: [], replyId: "r12" })).toEqual({
      ok: false,
      message: "this signal asks for a secret, and the vault answers it, not a reply",
    });
    expect(ruleSignalReply({ kind: "text" }, { kind: "proof", text: "here it is", links: [], replyId: "r13" })).toEqual({
      ok: false,
      message: "this signal asks for a reply, not a document or proof: answer it in words",
    });
    expect(ruleSignalReply({ kind: "text" }, { kind: "artifact", markdown: "done", replyId: "r14" })).toEqual({
      ok: false,
      message: "this signal asks for a reply, not a document or proof: answer it in words",
    });
  });
});
