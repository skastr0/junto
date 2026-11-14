import { describe, expect, it } from "vitest";
import { handleQuads, takesHandles } from "../src/window/canvas/paint/handles";
import { agentFact, view } from "./canvas-paint-fixtures";

const keys = (quads: ReturnType<typeof handleQuads>): string[] => quads.map((q) => q.key);

describe("connection handles", () => {
  it("hover shows one source dot per side, and no target dot", () => {
    const quads = handleQuads(agentFact(), view({ hovered: true }));
    expect(keys(quads)).toEqual([
      "handle.source.top",
      "handle.source.right",
      "handle.source.bottom",
      "handle.source.left",
    ]);
  });

  it("a connect gesture with no snap still draws one ring per side, as the DOM does", () => {
    expect(keys(handleQuads(agentFact(), view({ connecting: true })))).toEqual([
      "handle.source.top",
      "handle.source.right",
      "handle.source.bottom",
      "handle.source.left",
    ]);
  });

  it("only the target handle under the pointer adds its dashed dot, 5 units inside the source", () => {
    const quads = handleQuads(
      agentFact(),
      view({ connecting: true, hoveredPart: "handle", connectTarget: { nodeId: "agent-1", side: "right", role: "target" } }),
    );
    expect(keys(quads)).toContain("handle.target.right");
    expect(keys(quads).filter((key) => key.startsWith("handle.target."))).toEqual(["handle.target.right"]);
    const source = quads.find((q) => q.key === "handle.source.right")!;
    const target = quads.find((q) => q.key === "handle.target.right")!;
    expect(source.rect.x - target.rect.x).toBe(5);
    expect(target.rect.y).toBe(source.rect.y);
  });

  it("a snap onto another card, a source handle, or a body hover adds no target dot", () => {
    expect(keys(handleQuads(agentFact(), view({ connecting: true, hoveredPart: "handle", connectTarget: { nodeId: "other", side: "right", role: "target" } })))).not.toContain("handle.target.right");
    expect(keys(handleQuads(agentFact(), view({ connecting: true, hoveredPart: "handle", connectTarget: { nodeId: "agent-1", side: "right", role: "source" } })))).not.toContain("handle.target.right");
    expect(keys(handleQuads(agentFact(), view({ connecting: true, connectTarget: { nodeId: "agent-1", side: "right", role: "target" } })))).not.toContain("handle.target.right");
  });

  it("regions, labels, git and files take no handles", () => {
    for (const kind of ["region", "label", "git", "files"]) {
      expect(takesHandles({ ...agentFact(), row: { ...agentFact().row, kind } as never }), kind).toBe(false);
    }
    expect(takesHandles(agentFact())).toBe(true);
  });
});
