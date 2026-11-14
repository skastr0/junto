import { describe, expect, it } from "vitest";
import { handleQuads, takesHandles } from "../src/window/canvas/paint/handles";
import { paintCard } from "../src/window/canvas/paint/index";
import { TIER_BIT } from "../src/window/canvas/contract";
import { tok } from "../src/window/canvas/paint/refs";
import { agentFact, fakeEnv, view } from "./canvas-paint-fixtures";

const keys = (quads: ReturnType<typeof handleQuads>): string[] => quads.map((q) => q.key);

describe("connection handles", () => {
  it("a hover bloom keeps its handle dots out of the scaled card", () => {
    const bloomed = paintCard(agentFact(), undefined, view({ hovered: true }), fakeEnv).quads
      .filter((quad) => quad.key.startsWith("handle."));
    expect(bloomed.length).toBeGreaterThan(0);
    expect(bloomed.every((quad) => quad.tiers === TIER_BIT.near)).toBe(true);
    // A connect gesture has no bloom; its handles stay at mid as well.
    const connecting = paintCard(agentFact(), undefined, view({ hovered: true, connecting: true }), fakeEnv).quads
      .filter((quad) => quad.key.startsWith("handle."));
    expect(connecting.some((quad) => (quad.tiers & TIER_BIT.mid) !== 0)).toBe(true);
  });
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

  it("the landing side adds its dashed dot, 5 units inside the source", () => {
    const quads = handleQuads(
      agentFact(),
      view({ connecting: true, connectTarget: { nodeId: "agent-1", side: "right", role: "target" } }),
    );
    expect(keys(quads).filter((key) => key.startsWith("handle.target."))).toEqual([
      "handle.target.frame",
      "handle.target.room.right",
      "handle.target.right",
    ]);
    const source = quads.find((q) => q.key === "handle.source.right")!;
    const target = quads.find((q) => q.key === "handle.target.right")!;
    expect(source.rect.x - target.rect.x).toBe(5);
    expect(target.rect.y).toBe(source.rect.y);
  });

  it("says the landing from the pointer being anywhere: a snap and a body drop paint it too", () => {
    // The DOM gates the dot on `connectingto`, not on the pointer being over a
    // handle: a snap within the radius and a drop on the body both land there.
    for (const hoveredPart of [undefined, "body", "handle"] as const) {
      const quads = handleQuads(
        agentFact(),
        view({
          connecting: true,
          ...(hoveredPart === undefined ? {} : { hoveredPart }),
          connectTarget: { nodeId: "agent-1", side: "bottom", role: "target" },
        }),
      );
      expect(keys(quads), String(hoveredPart)).toContain("handle.target.bottom");
    }
  });

  it("the landing card takes a second-colour frame, two units out", () => {
    const quads = handleQuads(
      agentFact(),
      view({ connecting: true, connectTarget: { nodeId: "agent-1", side: "right", role: "target" } }),
    );
    const frame = quads.find((q) => q.key === "handle.target.frame")!;
    expect(frame).toMatchObject({ kind: "shape", band: "lifted", rect: { x: -2, y: -2, width: 220, height: 60 } });
    expect(frame.style?.stroke).toMatchObject({ color: tok("second", 0.55), width: 1 });
  });

  it("the landing dot wears the connectingto.valid paint", () => {
    const quads = handleQuads(
      agentFact(),
      view({ connecting: true, connectTarget: { nodeId: "agent-1", side: "right", role: "target" } }),
    );
    const target = quads.find((q) => q.key === "handle.target.right")!;
    const stroke = target.style?.stroke;
    expect(stroke && "color" in stroke ? stroke.color : undefined).toEqual(tok("second", 0.95));
    const fill = target.style?.fill;
    expect(fill).toMatchObject({ kind: "flat", color: tok("second", 0.25) });
    const room = quads.find((q) => q.key === "handle.target.room.right")!;
    expect(room.rect).toMatchObject({ width: 19, height: 19 });
  });

  it("only the hovered source dot lights, as the DOM's :hover does", () => {
    const quads = handleQuads(agentFact(), view({ hovered: true, hoveredHandle: { side: "left", role: "source" } }));
    const fill = (key: string) => {
      const quad = quads.find((q) => q.key === key)!;
      const quadFill = quad.style?.fill;
      return quadFill !== undefined && "color" in quadFill ? quadFill.color : undefined;
    };
    expect(fill("handle.source.left")).toEqual(tok("main", 0.35));
    expect(fill("handle.source.right")).toEqual(tok("ground"));
  });

  it("no target dot for another card's landing or a source-role landing", () => {
    expect(keys(handleQuads(agentFact(), view({ connecting: true, connectTarget: { nodeId: "other", side: "right", role: "target" } })))).not.toContain("handle.target.right");
    expect(keys(handleQuads(agentFact(), view({ connecting: true, connectTarget: { nodeId: "agent-1", side: "right", role: "source" } })))).not.toContain("handle.target.right");
  });

  it("regions, labels, git and files take no handles", () => {
    for (const kind of ["region", "label", "git", "files"]) {
      expect(takesHandles({ ...agentFact(), row: { ...agentFact().row, kind } as never }), kind).toBe(false);
    }
    expect(takesHandles(agentFact())).toBe(true);
  });
});
