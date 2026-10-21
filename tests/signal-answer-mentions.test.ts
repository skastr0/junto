import { describe, expect, it } from "vitest";
import { asNodeId, type NodeId } from "../src/shared/physics/schema";
import type { NodeKind } from "../src/shared/model/kinds";
import { mentionLink } from "../src/shared/mention";
import { answerCopies, answerCopyId, composeAnswerCopy } from "../src/main/junto/signals/answer-mentions";

const asker = asNodeId("agent-asker");
const wired = asNodeId("agent-wired");
const loose = asNodeId("agent-loose");
const page = asNodeId("page-1");
const kinds: Record<string, NodeKind> = { [asker]: "agent", [wired]: "agent", [loose]: "agent", [page]: "page" };
const kindOf = (nodeId: NodeId): NodeKind | undefined => kinds[nodeId];
const connected = new Set<string>([wired]);
const at = (nodeId: NodeId, label: string) => mentionLink({ kind: "seat", nodeId }, label, "factory");

describe("an answer's mentioned seats", () => {
  it("copies each seat wired to the signalling seat, once, and never the asker", () => {
    const text = `ok, ${at(wired, "@wired")} takes it; ${at(asker, "@asker")} and ${at(wired, "@wired again")} again`;
    expect(answerCopies(text, asker, kindOf, connected)).toEqual({ ok: true, seats: [wired] });
  });

  it("leaves pages and plain words as references", () => {
    const text = `see ${mentionLink({ kind: "page", nodeId: page }, "@docs", "factory")} and @wired in words`;
    expect(answerCopies(text, asker, kindOf, connected)).toEqual({ ok: true, seats: [] });
  });

  it("refuses an answer that mentions a seat not wired to the asker", () => {
    const text = `${at(wired, "@wired")} and ${at(loose, "@loose")}`;
    expect(answerCopies(text, asker, kindOf, connected)).toEqual({ ok: false, outside: [loose] });
  });

  it("tells the copied seat whose signal it is", () => {
    expect(composeAnswerCopy({ signalId: "s1", text: "which look?" }, "product-feed", " the second \n")).toBe(
      'The operator answered product-feed\'s signal (s1): "which look?", and copied you:\n\nthe second',
    );
  });

  it("names a copy by its answer and seat, the same every time", () => {
    const answer = "01M5EX70KVXRS8C2A5XJG87YW1";
    expect(answerCopyId(answer, wired)).toBe(answerCopyId(answer, wired));
    expect(answerCopyId(answer, wired)).not.toBe(answerCopyId(answer, loose));
    expect(answerCopyId(answer, wired)).not.toBe(answerCopyId("01M5EX70KVXRS8C2A5XJG87YW2", wired));
    expect(answerCopyId(answer, wired).slice(0, 10)).toBe(answer.slice(0, 10));
    expect(answerCopyId(answer, wired)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
