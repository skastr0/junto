import { describe, expect, it } from "vitest";
import { verbSentence } from "../src/renderer/lib/verb-sentence";
import { VERBS } from "../src/shared/physics";

describe("verbSentence", () => {
  it("reads works in stored task-to-agent order", () => {
    expect(verbSentence("works", "Intake", "Devin")).toBe("Intake works Devin");
  });

  it("keeps every verb as from-then-to", () => {
    for (const verb of VERBS) {
      const sentence = verbSentence(verb, "Alpha", "Beta");
      const fromAt = sentence.indexOf("Alpha");
      const toAt = sentence.indexOf("Beta");
      expect(fromAt).toBeGreaterThan(-1);
      expect(toAt).toBeGreaterThan(-1);
      expect(fromAt).toBeLessThan(toAt);
    }
  });
});
