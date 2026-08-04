import { describe, expect, it } from "vitest";
import {
  isHerdrCanvasNode,
  liveHerdrBlocked,
  nodeBlockPresentation,
} from "../src/renderer/lib/node-block-state";

const herdrNode = {
  type: "text" as const,
  ether: {
    entity: { kind: "herdr" as const },
    herdr: { host: "local", paneId: "w1:p1" },
  },
};

const noteNode = {
  type: "text" as const,
  ether: {
    entity: { kind: "project" as const, name: "vellum" },
  },
};

const agentNode = {
  type: "text" as const,
  ether: {
    entity: { kind: "agent" as const, name: "local:worker" },
  },
};

const relayNode = {
  type: "text" as const,
  ether: {
    entity: { kind: "relay" as const },
    flags: ["blocker" as const],
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

  it("document flag:blocker on herdr alone does not seat-chrome (live status does)", () => {
    const flagged = {
      type: "text" as const,
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
    // Flag remains on the rail; shell is quiet until live herdr is blocked.
    expect(p.flags).toEqual(["blocker"]);
    expect(p.isBlocker).toBe(false);
    expect(p.shellBlocked).toBe(false);
    expect(p.liveHerdrBlocked).toBe(false);
  });

  it("document flag:blocker seat-chromes actor seats only", () => {
    const flaggedAgent = {
      type: "text" as const,
      ether: {
        ...agentNode.ether,
        flags: ["blocker" as const],
      },
    };
    const p = nodeBlockPresentation({
      node: flaggedAgent,
      graphBlocked: false,
    });
    expect(p.isBlocker).toBe(true);
    expect(p.shellBlocked).toBe(true);
  });

  it("relay with flag:blocker keeps the flag but no seat-stoppage dress", () => {
    const p = nodeBlockPresentation({
      node: relayNode,
      graphBlocked: false,
    });
    expect(p.flags).toEqual(["blocker"]);
    expect(p.isBlocker).toBe(false);
    expect(p.shellBlocked).toBe(false);
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
