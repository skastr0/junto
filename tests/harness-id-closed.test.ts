import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Seat } from "../src/shared/model";
import { HARNESS_IDS, type HarnessId } from "../src/shared/managed-terminal-templates";
import { seat } from "./support/model-nodes";

describe("seat harness", () => {
  it("accepts every harness the template table declares", () => {
    for (const harness of HARNESS_IDS) {
      expect(Schema.is(Seat)(seat("subject", { harness }))).toBe(true);
    }
  });

  it("refuses a harness that names no template", () => {
    expect(Schema.is(Seat)({ ...seat("subject"), harness: "banana" })).toBe(false);
  });

  it("requires both a binding and a harness", () => {
    const { bindingId: _binding, ...unbound } = seat("subject");
    const { harness: _harness, ...harnessless } = seat("subject");
    expect(Schema.is(Seat)(unbound)).toBe(false);
    expect(Schema.is(Seat)(harnessless)).toBe(false);
  });

  it("closes the harness type", () => {
    const claude: HarnessId = "claude";
    // @ts-expect-error: no template is named banana.
    const banana: HarnessId = "banana";
    // @ts-expect-error: an open string cannot stand in for the closed set.
    const open: HarnessId = String("claude");
    expect([claude, banana, open]).toHaveLength(3);
  });
});
