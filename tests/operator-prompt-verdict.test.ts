import { describe, expect, it } from "vitest";
import { mapPromptResultToVerdict } from "../src/main/junto/work/operator-prompt-verdict";
import type { PromptResult } from "../src/main/junto/work/message-delivery";

const submitted: PromptResult = {
  policy: "immediate",
  outcome: {
    status: "submitted",
    bindingGeneration: 0,
    writesBefore: 0,
    writesAfter: 1,
    pasteWrites: 1,
    wrotePhysicalBytes: true,
  },
};

const refused = (reason: "seat-busy" | "over-limit" | "written-unresolved"): PromptResult => ({
  policy: "immediate",
  outcome: {
    status: "refused",
    reason,
    bindingGeneration: 0,
    writesBefore: 0,
    writesAfter: reason === "written-unresolved" ? 1 : 0,
    pasteWrites: 0,
    wrotePhysicalBytes: reason === "written-unresolved",
  },
});

describe("mapPromptResultToVerdict", () => {
  it("maps submitted and already-settled rows to submitted", () => {
    expect(mapPromptResultToVerdict(submitted, "m1")).toEqual({
      ok: true,
      disposition: "submitted",
      messageId: "m1",
    });
    expect(mapPromptResultToVerdict({ unavailable: "settled" }, "m1")).toEqual({
      ok: true,
      disposition: "submitted",
      messageId: "m1",
    });
  });

  it("maps busy and paused to queued without failing the send", () => {
    expect(mapPromptResultToVerdict(refused("seat-busy"), "m1")).toEqual({
      ok: true,
      disposition: "queued",
      messageId: "m1",
      reason: "seat-busy",
    });
    expect(mapPromptResultToVerdict({ unavailable: "paused" }, "m1")).toEqual({
      ok: true,
      disposition: "queued",
      messageId: "m1",
      reason: "paused",
    });
  });

  it("maps written-unresolved to unconfirmed and never calls it submitted", () => {
    expect(mapPromptResultToVerdict(refused("written-unresolved"), "m1")).toEqual({
      ok: false,
      disposition: "unresolved",
      messageId: "m1",
      reason: "written-unresolved",
      error:
        "Prompt submission is unconfirmed. Inspect the terminal before retrying.",
    });
  });

  it("maps hard refusals and parked rows to failed", () => {
    expect(mapPromptResultToVerdict(refused("over-limit"), "m1")).toMatchObject({
      ok: false,
      disposition: "failed",
      reason: "over-limit",
    });
    expect(mapPromptResultToVerdict({ unavailable: "parked" }, "m1")).toMatchObject({
      ok: false,
      disposition: "failed",
      reason: "parked",
    });
  });
});
