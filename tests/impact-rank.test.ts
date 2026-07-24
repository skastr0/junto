import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { deriveExecutionGraph } from "../src/shared/execution-graph";
import {
  formatRankedStoppageLine,
  formatWaitingOnLines,
  leadStaffing,
  rankStoppageSeeds,
  waitingOnPath,
} from "../src/shared/impact";
import { a2aTask } from "./helpers/a2a-fixtures";
import { seat } from "./helpers/physics-seats";

const text = (
  id: string,
  label: string,
  ether?: CanvasDoc["nodes"][number]["ether"],
): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: label,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ...(ether ? { ether } : {}),
});

/**
 * Two independent stoppage seeds via sink fan-out (no actor→actor cascade).
 * Big cone size 4 = r-big + p1 + p2 + p3; small size 2 = r-small + s1.
 */
const twoSeedDoc = (): CanvasDoc => ({
  nodes: [
    text("r-big", "Big Requests", {
      entity: { kind: "requests" },
      requests: { items: [a2aTask("q1", "approve deploy?", "input-required")] },
    }),
    seat("p1", "actor", { label: "Ship" }),
    seat("p2", "actor", { label: "Release" }),
    seat("p3", "actor", { label: "Announce" }),
    text("r-small", "Small Requests", {
      entity: { kind: "requests" },
      requests: { items: [a2aTask("q2", "ping?", "input-required")] },
    }),
    seat("s1", "actor", { label: "Side" }),
    // Soft attention lead into the big cone (free actor, not blocked)
    seat("lead1", "actor", { label: "lead worker" }),
  ],
  edges: [
    {
      id: "e-big-1",
      fromNode: "r-big",
      toNode: "p1",
      ether: { criteria: { mode: "tasks" } },
    },
    {
      id: "e-big-2",
      fromNode: "r-big",
      toNode: "p2",
      ether: { criteria: { mode: "tasks" } },
    },
    {
      id: "e-big-3",
      fromNode: "r-big",
      toNode: "p3",
      ether: { criteria: { mode: "tasks" } },
    },
    {
      id: "e-small-1",
      fromNode: "r-small",
      toNode: "s1",
      ether: { criteria: { mode: "tasks" } },
    },
    { id: "e-lead", fromNode: "lead1", toNode: "p2" },
  ],
});

describe("rankStoppageSeeds — blast-radius ranking", () => {
  it("orders two seeds by cone size (4 then 2)", () => {
    const doc = twoSeedDoc();
    const graph = deriveExecutionGraph(doc);
    const ranked = rankStoppageSeeds(doc, graph);

    expect(ranked.length).toBeGreaterThanOrEqual(2);
    expect(ranked[0]!.seedNodeId).toBe("r-big");
    expect(ranked[0]!.stops).toBe(4);
    expect(ranked[0]!.seedBrief).toBe("1 request");
    expect(ranked[1]!.seedNodeId).toBe("r-small");
    expect(ranked[1]!.stops).toBe(2);

    expect(ranked[0]!.attentionLeadIds).toContain("lead1");

    const line = formatRankedStoppageLine(ranked[0]!, {
      titleOf: (id) => (id === "lead1" ? "lead worker" : id),
    });
    expect(line).toMatch(/1 request · stops 4/);
    expect(line).toMatch(/leads: lead worker/);
  });

  it("marks empty lead seats unstaffed when occupancy is available", () => {
    const doc = twoSeedDoc();
    const graph = deriveExecutionGraph(doc);
    const ranked = rankStoppageSeeds(doc, graph);
    const big = ranked.find((r) => r.seedNodeId === "r-big")!;
    expect(big.attentionLeadIds).toContain("lead1");

    expect(leadStaffing("lead1")).toBe("unknown");
    expect(leadStaffing("lead1", new Map())).toBe("unknown");
    expect(leadStaffing("lead1", new Map([["lead1", "empty"]]))).toBe("unstaffed");
    expect(leadStaffing("lead1", new Map([["lead1", "gone"]]))).toBe("unstaffed");
    expect(leadStaffing("lead1", new Map([["lead1", "idle"]]))).toBe("staffed");
    expect(leadStaffing("lead1", new Map([["lead1", "working"]]))).toBe("staffed");

    const line = formatRankedStoppageLine(big, {
      titleOf: (id) => (id === "lead1" ? "lead worker" : id),
      occupancyByNodeId: new Map([["lead1", "empty"]]),
    });
    expect(line).toContain("lead worker (unstaffed)");
  });

  it("includes clear-action on ranked rows", () => {
    const doc = twoSeedDoc();
    const graph = deriveExecutionGraph(doc);
    const ranked = rankStoppageSeeds(doc, graph);
    expect(ranked[0]!.clearAction).toMatch(/resolve:|approve deploy/i);
  });
});

describe("waitingOnPath — reverse walk to seed", () => {
  it("lists blocked actor then generator apex (direct hop; no cascade chain)", () => {
    const doc = twoSeedDoc();
    const graph = deriveExecutionGraph(doc);

    expect(graph.blocked.has("p3")).toBe(true);
    const path = waitingOnPath(doc, graph, "p3");
    expect(path.hops.map((h) => h.nodeId)).toEqual(["p3", "r-big"]);

    expect(path.hops[0]!.nodeId).toBe("p3");
    expect(path.hops[0]!.role).toBe("blocked");
    expect(path.hops[0]!.reasons.some((r) => r.kind === "edge")).toBe(true);
    expect(path.seedNodeId).toBe("r-big");
    expect(path.hops[path.hops.length - 1]!.role).toBe("generator");

    const lines = formatWaitingOnLines(path, doc);
    expect(lines[0]).toMatch(/Announce/);
    expect(lines[lines.length - 1]).toMatch(/Big Requests/);
  });

  it("returns empty outside any stoppage cone", () => {
    const doc = twoSeedDoc();
    const graph = deriveExecutionGraph(doc);
    // free attention lead is not in the phase cone
    const path = waitingOnPath(doc, graph, "lead1");
    expect(path.hops).toEqual([]);
  });
});
