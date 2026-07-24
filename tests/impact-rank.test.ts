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

const projectNode = (id: string, label: string, projectKey: string) =>
  text(id, label, {
    entity: { kind: "project", name: projectKey },
  });

/** Two independent stoppage seeds: big cone (size 4) and small (size 1 generator alone is empty — size 2). */
const twoSeedDoc = (): CanvasDoc => ({
  nodes: [
    // Big seed: requests → p1 → p2 → p3  (cone: r-big, p1, p2, p3 = 4)
    text("r-big", "Big Requests", {
      entity: { kind: "requests" },
      requests: { items: [a2aTask("q1", "approve deploy?", "input-required")] },
    }),
    projectNode("p1", "Ship", "ship"),
    projectNode("p2", "Release", "release"),
    projectNode("p3", "Announce", "announce"),
    // Small seed: requests → only s1 (cone: r-small, s1 = 2)
    text("r-small", "Small Requests", {
      entity: { kind: "requests" },
      requests: { items: [a2aTask("q2", "ping?", "input-required")] },
    }),
    projectNode("s1", "Side", "side"),
    // Attention lead into the big cone
    text("agent1", "hermes", {
      entity: { kind: "agent", name: "local:default" },
    }),
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
      fromNode: "p1",
      toNode: "p2",
      ether: { criteria: { mode: "tasks" } },
    },
    {
      id: "e-big-3",
      fromNode: "p2",
      toNode: "p3",
      ether: { criteria: { mode: "tasks" } },
    },
    {
      id: "e-small-1",
      fromNode: "r-small",
      toNode: "s1",
      ether: { criteria: { mode: "tasks" } },
    },
    // Soft relates from agent into blocked p2 — attention lead
    { id: "e-lead", fromNode: "agent1", toNode: "p2" },
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

    // Leads on the big cone
    expect(ranked[0]!.attentionLeadIds).toContain("agent1");

    const line = formatRankedStoppageLine(ranked[0]!, {
      titleOf: (id) => (id === "agent1" ? "hermes" : id),
    });
    expect(line).toMatch(/1 request · stops 4/);
    expect(line).toMatch(/leads: hermes/);
  });

  it("marks empty lead seats unstaffed when occupancy is available", () => {
    const doc = twoSeedDoc();
    const graph = deriveExecutionGraph(doc);
    const ranked = rankStoppageSeeds(doc, graph);
    const big = ranked.find((r) => r.seedNodeId === "r-big")!;
    expect(big.attentionLeadIds).toContain("agent1");

    expect(leadStaffing("agent1")).toBe("unknown");
    expect(leadStaffing("agent1", new Map())).toBe("unknown");
    expect(leadStaffing("agent1", new Map([["agent1", "empty"]]))).toBe("unstaffed");
    expect(leadStaffing("agent1", new Map([["agent1", "gone"]]))).toBe("unstaffed");
    expect(leadStaffing("agent1", new Map([["agent1", "idle"]]))).toBe("staffed");
    expect(leadStaffing("agent1", new Map([["agent1", "working"]]))).toBe("staffed");

    const line = formatRankedStoppageLine(big, {
      titleOf: (id) => (id === "agent1" ? "hermes" : id),
      occupancyByNodeId: new Map([["agent1", "empty"]]),
    });
    expect(line).toContain("hermes (unstaffed)");
  });

  it("includes clear-action on ranked rows", () => {
    const doc = twoSeedDoc();
    const graph = deriveExecutionGraph(doc);
    const ranked = rankStoppageSeeds(doc, graph);
    expect(ranked[0]!.clearAction).toMatch(/resolve:|approve deploy/i);
  });
});

describe("waitingOnPath — reverse walk to seed", () => {
  it("lists seed and every relay hop from a deep blocked node", () => {
    const doc = twoSeedDoc();
    const graph = deriveExecutionGraph(doc);

    expect(graph.blocked.has("p3")).toBe(true);
    const path = waitingOnPath(doc, graph, "p3");
    expect(path.hops.length).toBeGreaterThanOrEqual(2);

    // Path is blocked → … → seed (generator)
    expect(path.hops[0]!.nodeId).toBe("p3");
    expect(path.seedNodeId).toBe("r-big");
    expect(path.hops[path.hops.length - 1]!.nodeId).toBe("r-big");
    expect(path.hops[path.hops.length - 1]!.role).toBe("generator");

    // Every intermediate hop present
    const ids = path.hops.map((h) => h.nodeId);
    expect(ids).toContain("p3");
    expect(ids).toContain("p2");
    expect(ids).toContain("p1");
    expect(ids).toContain("r-big");

    // Relay reasons appear on intermediate blocked nodes
    const p2 = path.hops.find((h) => h.nodeId === "p2");
    expect(p2?.role).toBe("blocked");
    expect(p2?.reasons.some((r) => r.kind === "relay")).toBe(true);

    const lines = formatWaitingOnLines(path, doc);
    expect(lines[0]).toMatch(/Announce/);
    expect(lines[lines.length - 1]).toMatch(/Big Requests/);
  });

  it("returns empty outside any stoppage cone", () => {
    const doc = twoSeedDoc();
    const graph = deriveExecutionGraph(doc);
    // agent is soft lead, not in phase cone
    const path = waitingOnPath(doc, graph, "agent1");
    expect(path.hops).toEqual([]);
  });
});
