import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import { reconcileOverseerGrants } from "../src/shared/overseer-authoring";

const nodeHasOverseerGrant = (node: CanvasNode): boolean => node.ether?.overseer === true;

const agent = (
  id: string,
  bindingId: string,
  overseer = false,
  host = "local",
): CanvasNode => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 260,
  height: 96,
  ether: {
    entity: { kind: "agent", name: `${host}:amp` },
    host,
    terminal: { bindingId, harness: "amp" },
    ...(overseer ? { overseer: true } : {}),
  },
});

const note = (id: string, x = 0, y = 0, width = 120, height = 60): CanvasNode => ({
  id,
  type: "text",
  text: id,
  x,
  y,
  width,
  height,
});

describe("overseer authoring", () => {
  it("preserves grant only for unchanged host/binding on the same node id", () => {
    const previous: CanvasDoc = {
      nodes: [agent("a1", "bind-1", true)],
      edges: [],
    };
    const moved = reconcileOverseerGrants(previous, {
      nodes: [{ ...agent("a1", "bind-1", false), x: 40, y: 80 }],
      edges: [],
    });
    expect(nodeHasOverseerGrant(moved.nodes[0]!)).toBe(true);

    const reseated = reconcileOverseerGrants(previous, {
      nodes: [agent("a1", "bind-2", true)],
      edges: [],
    });
    expect(nodeHasOverseerGrant(reseated.nodes[0]!)).toBe(false);

    const copied = reconcileOverseerGrants(previous, {
      nodes: [agent("a1", "bind-1", true), agent("a2", "bind-1", true)],
      edges: [],
    });
    expect(nodeHasOverseerGrant(copied.nodes[0]!)).toBe(true);
    expect(nodeHasOverseerGrant(copied.nodes[1]!)).toBe(false);
  });

  it("strips incoming overseer on brand-new nodes", () => {
    const next = reconcileOverseerGrants(
      { nodes: [], edges: [] },
      { nodes: [agent("a1", "bind-1", true)], edges: [] },
    );
    expect(nodeHasOverseerGrant(next.nodes[0]!)).toBe(false);
  });
});
