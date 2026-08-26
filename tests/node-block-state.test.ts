import { describe, expect, it } from "vitest";
import { nodeBlockPresentation } from "../src/renderer/lib/node-block-state";

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

describe("nodeBlockPresentation", () => {



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
    expect(p.flags).toEqual(["blocker"]);
  });

  it("relay with flag:blocker shows rail tag, never seat dress", () => {
    const p = nodeBlockPresentation({
      node: relayNode,
      graphBlocked: false,
    });
    expect(p.flags).toEqual(["blocker"]);
    expect(p.isBlocker).toBe(false);
    expect(p.shellBlocked).toBe(false);
  });

  it("graph blocked never elevates non-seat nodes", () => {
    const p = nodeBlockPresentation({
      node: noteNode,
      graphBlocked: true,
    });
    expect(p.shellBlocked).toBe(false);
    expect(p.isBlocker).toBe(false);
  });
});
