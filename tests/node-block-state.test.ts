import { describe, expect, it } from "vitest";
import {
  isHerdrCanvasNode,
  liveHerdrBlocked,
  nodeBlockPresentation,
} from "../src/renderer/lib/node-block-state";

const herdrNode = {
  ether: {
    entity: { kind: "herdr" as const },
    herdr: { host: "local", paneId: "w1:p1" },
  },
};

const noteNode = {
  ether: {
    entity: { kind: "project" as const, name: "vellum" },
  },
};

describe("liveHerdrBlocked", () => {
  it("true only for herdr nodes with agent_status blocked", () => {
    expect(liveHerdrBlocked(herdrNode, "blocked")).toBe(true);
    expect(liveHerdrBlocked(herdrNode, "working")).toBe(false);
    expect(liveHerdrBlocked(herdrNode, "done")).toBe(false);
    expect(liveHerdrBlocked(herdrNode, "idle")).toBe(false);
    expect(liveHerdrBlocked(herdrNode, undefined)).toBe(false);
    expect(liveHerdrBlocked(noteNode, "blocked")).toBe(false);
  });

  it("recognizes herdr binding without entity.kind", () => {
    const bound = { ether: { herdr: { host: "local", paneId: "w1:p2" } } };
    expect(isHerdrCanvasNode(bound)).toBe(true);
    expect(liveHerdrBlocked(bound, "blocked")).toBe(true);
  });
});

describe("nodeBlockPresentation", () => {
  it("paints shell blocker chrome from live herdr blocked without document flag", () => {
    const p = nodeBlockPresentation({
      node: herdrNode,
      graphBlocked: false,
      herdrAgentStatus: "blocked",
    });
    expect(p.isBlocker).toBe(true);
    expect(p.shellBlocked).toBe(true);
    expect(p.liveHerdrBlocked).toBe(true);
    expect(p.flags).toEqual([]);
  });

  it("clears when herdr unblocks", () => {
    const p = nodeBlockPresentation({
      node: herdrNode,
      graphBlocked: false,
      herdrAgentStatus: "working",
    });
    expect(p.isBlocker).toBe(false);
    expect(p.shellBlocked).toBe(false);
    expect(p.liveHerdrBlocked).toBe(false);
  });

  it("document flag:blocker still seeds shell even when herdr is not blockable in the graph", () => {
    const flagged = {
      ether: {
        ...herdrNode.ether,
        flags: ["blocker" as const],
      },
    };
    const p = nodeBlockPresentation({
      node: flagged,
      graphBlocked: false,
      herdrAgentStatus: "idle",
    });
    expect(p.isBlocker).toBe(true);
    expect(p.shellBlocked).toBe(true);
    expect(p.liveHerdrBlocked).toBe(false);
  });

  it("graph blocked still elevates non-herdr nodes", () => {
    const p = nodeBlockPresentation({
      node: noteNode,
      graphBlocked: true,
      herdrAgentStatus: "blocked",
    });
    expect(p.shellBlocked).toBe(true);
    expect(p.isBlocker).toBe(false);
    expect(p.liveHerdrBlocked).toBe(false);
  });
});
