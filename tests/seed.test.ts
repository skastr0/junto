import { describe, expect, it } from "vitest";
import { Either } from "effect";
import { decodeCanvasDoc } from "../src/shared/canvas";
import { isGroup } from "../src/shared/graph";
import { seedCanvasDoc } from "../src/shared/seed";

describe("seedCanvasDoc", () => {
  it("decodes as a valid canvas document", () => {
    const decoded = decodeCanvasDoc(seedCanvasDoc());
    expect(Either.isRight(decoded)).toBe(true);
  });

  it("contains at least one group, one blocker, and one blocks edge", () => {
    const doc = seedCanvasDoc();

    const groups = doc.nodes.filter(isGroup);
    expect(groups.length).toBeGreaterThanOrEqual(1);

    const blockers = doc.nodes.filter((node) => node.ether?.flags?.includes("blocker"));
    expect(blockers.length).toBeGreaterThanOrEqual(1);

    const blocksEdges = doc.edges.filter((edge) => edge.ether?.kind === "blocks");
    expect(blocksEdges.length).toBeGreaterThanOrEqual(1);
  });
});
