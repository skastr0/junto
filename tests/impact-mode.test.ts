import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { ExecutionSnapshot } from "../src/shared/ipc";
import {
  connectionFocusSelection,
  edgeImpactClass,
  executionGraphForImpact as executionGraphForImpactWithContext,
  nodeImpactClass,
  selectionImpact as selectionImpactWithContext,
} from "../src/renderer/lib/impact-mode";
import {
  claimedByNode as claimed,
  executionContextForDoc,
} from "./helpers/actor-ref-fixtures";
import { taskItem } from "./helpers/task-fixtures";
import { seat } from "./helpers/physics-seats";

const executionGraphForImpact = (
  doc: CanvasDoc,
  execution: ExecutionSnapshot | null | undefined,
) =>
  executionGraphForImpactWithContext(
    doc,
    execution,
    executionContextForDoc(doc),
  );

const selectionImpact = (
  doc: CanvasDoc,
  rootNodeId: string,
  execution: ExecutionSnapshot | null | undefined,
) =>
  selectionImpactWithContext(
    doc,
    rootNodeId,
    execution,
    executionContextForDoc(doc),
  );

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

const stoppageDoc = (): CanvasDoc => ({
  nodes: [
    text("r1", "Requests", {
      entity: { kind: "requests" },
      requests: {
        items: [
          claimed(taskItem("q1", "approve deploy?", "input-required"), "a1"),
          claimed(taskItem("q2", "approve rollback?", "input-required"), "a2"),
        ],
      },
    }),
    seat("a1", "actor", { label: "Ship" }),
    seat("a2", "actor", { label: "Release" }),
    seat("outsider", "actor", { label: "Other" }),
  ],
  edges: [
    {
      id: "e-rp",
      fromNode: "r1",
      toNode: "a1",
      ether: { criteria: { mode: "tasks" } },
    },
    {
      id: "e-rp2",
      fromNode: "r1",
      toNode: "a2",
      ether: { criteria: { mode: "tasks" } },
    },
  ],
});

describe("selectionImpact — canvas impact mode", () => {
  it("activates for generators / blocked actors and dims outsiders via classes", () => {
    const doc = stoppageDoc();
    const impact = selectionImpact(doc, "r1", null);
    expect(impact.active).toBe(true);
    expect(impact.cone.nodeIds).toEqual(new Set(["r1", "a1", "a2"]));
    expect(impact.cone.edgeIds.has("e-rp")).toBe(true);
    expect(impact.cone.edgeIds.has("e-rp2")).toBe(true);
    expect(impact.seedLabel).toMatch(/in cone/i);

    expect(nodeImpactClass(true, impact.cone, "r1")).toBe("impact-in impact-root");
    expect(nodeImpactClass(true, impact.cone, "a1")).toBe("impact-in");
    expect(nodeImpactClass(true, impact.cone, "outsider")).toBeUndefined();
    expect(edgeImpactClass(true, impact.cone, "e-rp")).toBe("impact-edge-in");
    expect(edgeImpactClass(true, impact.cone, "missing")).toBeUndefined();
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
      phaseByEdgeId: { "e-rp": "blocks", "e-rp2": "blocks" },
      detailByEdgeId: { "e-rp": "input-required", "e-rp2": "input-required" },
      blocked: ["a1", "a2"],
      blockedEdgeIds: ["e-rp", "e-rp2"],
      reasonsByNodeId: {
        a1: [{ kind: "edge", edgeId: "e-rp", fromNodeId: "r1", detail: "input-required" }],
        a2: [{ kind: "edge", edgeId: "e-rp2", fromNodeId: "r1", detail: "input-required" }],
      },
    };
    const graph = executionGraphForImpact(doc, execution);
    expect(graph.edgeEvalById.get("e-rp")?.generates).toBe(true);
    expect(graph.edgeEvalById.get("e-rp2")?.generates).toBe(true);
    expect(graph.blocked.has("a1")).toBe(true);

    const impact = selectionImpact(doc, "a1", execution);
    expect(impact.active).toBe(true);
    expect(impact.cone.nodeIds.has("r1")).toBe(true);
    expect(impact.cone.nodeIds.has("a2")).toBe(true);
  });
});

describe("connectionFocusSelection — direct neighborhood focus", () => {
  it("keeps the root, incident edges, and their neighboring nodes only", () => {
    const doc = stoppageDoc();
    const focus = connectionFocusSelection(doc, "a1");

    expect(focus.active).toBe(true);
    expect(focus.cone.nodeIds).toEqual(new Set(["a1", "r1"]));
    expect(focus.cone.edgeIds).toEqual(new Set(["e-rp"]));
    expect(focus.seedLabel).toBe("1 connected · 1 edge");
    expect(nodeImpactClass(true, focus.cone, "a1")).toBe("impact-in impact-root");
    expect(nodeImpactClass(true, focus.cone, "r1")).toBe("impact-in");
    expect(nodeImpactClass(true, focus.cone, "a2")).toBeUndefined();
    expect(edgeImpactClass(true, focus.cone, "e-rp")).toBe("impact-edge-in");
    expect(edgeImpactClass(true, focus.cone, "e-rp2")).toBeUndefined();
  });

  it("still focuses an isolated node so the operator can dismiss the noise", () => {
    const doc = stoppageDoc();
    const focus = connectionFocusSelection(doc, "outsider");

    expect(focus.active).toBe(true);
    expect(focus.cone.nodeIds).toEqual(new Set(["outsider"]));
    expect(focus.cone.edgeIds.size).toBe(0);
    expect(focus.seedLabel).toBe("0 connected · 0 edges");
  });

  it("stays inactive when the requested node no longer exists", () => {
    const focus = connectionFocusSelection(stoppageDoc(), "missing");
    expect(focus.active).toBe(false);
    expect(focus.cone.nodeIds.size).toBe(0);
  });
});
