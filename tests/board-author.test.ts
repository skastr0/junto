import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import { boardAuthorLabel } from "../src/renderer/lib/board-author";

const agentNode = (): CanvasNode => ({
  id: "agent-1",
  type: "text",
  text: "Pi - claude - max",
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: { entity: { kind: "agent", name: "local:claude" } },
});

describe("boardAuthorLabel", () => {
  it("resolves an actor id to the authored agent title", () => {
    expect(
      boardAuthorLabel(
        { kind: "actor", nodeId: "agent-1", label: "agent-1" },
        [agentNode()],
      ),
    ).toBe("Pi - claude - max");
  });

  it("keeps historical labels when an actor node is no longer on the canvas", () => {
    expect(
      boardAuthorLabel({ kind: "actor", nodeId: "agent-old", label: "Pi" }),
    ).toBe("Pi");
  });

  it("keeps operator labels independent from canvas actors", () => {
    expect(boardAuthorLabel({ kind: "operator", label: "operator" })).toBe(
      "operator",
    );
  });
});
