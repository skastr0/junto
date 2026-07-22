import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { ExecutionSnapshot } from "../src/shared/ipc";
import {
  edgeImpactClass,
  executionGraphForImpact,
  nodeImpactClass,
  selectionImpact,
} from "../src/renderer/lib/impact-mode";
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

const stoppageDoc = (): CanvasDoc => ({
  nodes: [
    text("r1", "Requests", {
      entity: { kind: "requests" },
      requests: { items: [a2aTask("q1", "approve deploy?", "input-required")] },
    }),
    projectNode("p1", "Ship", "ship"),
    projectNode("p2", "Release", "release"),
    projectNode("outsider", "Other", "other"),
  ],
  edges: [
    {
      id: "e-rp",
      fromNode: "r1",
      toNode: "p1",
      ether: { criteria: { mode: "tasks" } },
    },
    {
      id: "e-pp",
      fromNode: "p1",
      toNode: "p2",
      ether: { criteria: { mode: "tasks" } },
    },
  ],
});

describe("selectionImpact — canvas impact mode", () => {
  it("activates for generators / blocked nodes and dims outsiders via classes", () => {
    const doc = stoppageDoc();
    const impact = selectionImpact(doc, "r1", null);
    expect(impact.active).toBe(true);
    expect(impact.cone.nodeIds).toEqual(new Set(["r1", "p1", "p2"]));
    expect(impact.cone.edgeIds.has("e-rp")).toBe(true);
    expect(impact.seedLabel).toMatch(/in cone/i);

    expect(nodeImpactClass(true, impact.cone, "r1")).toBe("impact-in impact-root");
    expect(nodeImpactClass(true, impact.cone, "p1")).toBe("impact-in");
    expect(nodeImpactClass(true, impact.cone, "outsider")).toBe("impact-out");
    expect(edgeImpactClass(true, impact.cone, "e-rp")).toBe("impact-edge-in");
    expect(edgeImpactClass(true, impact.cone, "missing")).toBe("impact-edge-out");
  });

  it("stays inactive outside the stoppage cone", () => {
    const doc = stoppageDoc();
    const impact = selectionImpact(doc, "outsider", null);
    expect(impact.active).toBe(false);
    expect(nodeImpactClass(false, impact.cone, "outsider")).toBeUndefined();
  });

  it("rebuilds graph fields from a live execution snapshot", () => {
    const doc = stoppageDoc();
    const execution: ExecutionSnapshot = {
      phaseByEdgeId: { "e-rp": "blocks", "e-pp": "depends" },
      detailByEdgeId: { "e-rp": "input-required", "e-pp": "" },
      blocked: ["p1", "p2"],
      blockedEdgeIds: ["e-rp", "e-pp"],
      reasonsByNodeId: {
        p1: [{ kind: "edge", edgeId: "e-rp", fromNodeId: "r1", detail: "input-required" }],
        p2: [{ kind: "relay", viaNodeId: "p1", edgeId: "e-pp" }],
      },
    };
    const graph = executionGraphForImpact(doc, execution);
    expect(graph.edgeEvalById.get("e-rp")?.generates).toBe(true);
    expect(graph.edgeEvalById.get("e-pp")?.relays).toBe(true);
    expect(graph.blocked.has("p1")).toBe(true);

    const impact = selectionImpact(doc, "p1", execution);
    expect(impact.active).toBe(true);
    expect(impact.cone.nodeIds.has("r1")).toBe(true);
    expect(impact.cone.nodeIds.has("p2")).toBe(true);
  });
});
