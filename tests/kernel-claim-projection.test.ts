import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { retainSuccessfulClaimProjection } from "../src/main/vellum-command/kernel/service";

const doc = (text: string): CanvasDoc => ({
  nodes: [
    {
      id: "tasks",
      type: "text",
      x: 0,
      y: 0,
      width: 220,
      height: 84,
      text,
    },
  ],
  edges: [],
});

describe("kernel claim hot projection", () => {
  it("makes the post-claim Work document visible to same-cycle delivery", () => {
    const before = doc("submitted");
    const claimed = doc("working");
    const documents = new Map([["factory", before]]);

    expect(
      retainSuccessfulClaimProjection(documents, "factory", {
        ok: true,
        doc: claimed,
      }),
    ).toBe(true);
    expect(documents.get("factory")).toBe(claimed);
  });

  it("does not replace the hot document for a failed claim", () => {
    const before = doc("submitted");
    const documents = new Map([["factory", before]]);

    expect(
      retainSuccessfulClaimProjection(documents, "factory", { ok: false }),
    ).toBe(false);
    expect(documents.get("factory")).toBe(before);
  });
});
