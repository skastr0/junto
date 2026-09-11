import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import {
  aliasesLiveOverseerBinding,
  applyNodeChanges,
  applyOverseerFlag,
  callerGrantLive,
  canvasDeleteRetiresCaller,
  edgeVerbAdmitted,
  flowCycleIfInvalid,
  nodeGeometry,
  nodeHasOverseerGrant,
  nodeSeatBinding,
  reconcileOverseerGrants,
  removalIncludesCaller,
  retiresOccupant,
  setBindingOverseer,
} from "../src/shared/overseer-authoring";

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

  it("setBindingOverseer updates every alias of the same binding", () => {
    const docs = new Map<string, CanvasDoc>([
      ["alpha", { nodes: [agent("a1", "bind-1"), agent("other", "bind-9")], edges: [] }],
      ["beta", { nodes: [agent("a2", "bind-1", false, "local")], edges: [] }],
    ]);
    const next = setBindingOverseer(docs, { hostId: "local", bindingId: "bind-1" }, true);
    expect(next.get("alpha")!.nodes[0]!.ether?.overseer).toBe(true);
    expect(next.get("alpha")!.nodes[1]!.ether?.overseer).toBeUndefined();
    expect(next.get("beta")!.nodes[0]!.ether?.overseer).toBe(true);
  });

  it("refuses copied nodes that alias a live overseer binding", () => {
    const docs = new Map<string, CanvasDoc>([
      ["alpha", { nodes: [agent("a1", "bind-1", true)], edges: [] }],
    ]);
    expect(aliasesLiveOverseerBinding(docs, agent("copy", "bind-1"))).toBe(true);
    expect(aliasesLiveOverseerBinding(docs, agent("copy", "bind-2"))).toBe(false);
  });

  it("self-preservation uses the removal set, not geometry", () => {
    const caller = { canvasName: "ops", nodeId: "overseer" };
    const regionContains = new Set(["region"]);
    expect(removalIncludesCaller(caller, "ops", regionContains)).toBe(false);
    expect(removalIncludesCaller(caller, "ops", new Set(["overseer"]))).toBe(true);
    expect(canvasDeleteRetiresCaller(caller, "ops")).toBe(true);
    expect(canvasDeleteRetiresCaller(caller, "other")).toBe(false);
  });

  it("treats agentKey/harness/launch/session changes as occupant retirement", () => {
    const before = agent("a1", "bind-1", true);
    const renamed = applyNodeChanges(before, {
      ether: { entity: { kind: "agent", name: "local:other" } },
    });
    expect(retiresOccupant(before, renamed)).toBe(true);
    const moved = nodeGeometry(before, { x: 10, y: 20 });
    expect(retiresOccupant(before, moved)).toBe(false);
  });

  it("configure cannot mint an overseer grant", () => {
    const node = agent("a1", "bind-1");
    const patched = applyNodeChanges(node, { text: "renamed" });
    expect(patched.ether?.overseer).not.toBe(true);
    expect(applyOverseerFlag(node, true).ether?.overseer).toBe(true);
  });

  it("rejects illegal edges and task-path cycles without silent drop", () => {
    const from: CanvasNode = {
      id: "n1",
      type: "text",
      text: "note",
      x: 0,
      y: 0,
      width: 100,
      height: 40,
    };
    const to: CanvasNode = {
      id: "n2",
      type: "text",
      text: "note",
      x: 200,
      y: 0,
      width: 100,
      height: 40,
    };
    expect(edgeVerbAdmitted(from, to, "messages")).toBe(false);

    const tasks = (id: string): CanvasNode => ({
      id,
      type: "text",
      text: id,
      x: 0,
      y: 0,
      width: 240,
      height: 120,
      ether: { entity: { kind: "task" } },
    });
    const cyclic: CanvasDoc = {
      nodes: [tasks("t1"), tasks("t2")],
      edges: [
        { id: "e1", fromNode: "t1", toNode: "t2", ether: { verb: "feeds" } },
        { id: "e2", fromNode: "t2", toNode: "t1", ether: { verb: "feeds" } },
      ],
    };
    expect(flowCycleIfInvalid(cyclic)).toMatch(/cycle/i);
  });

  it("caller grant is live only on the granted seat", () => {
    const docs = new Map<string, CanvasDoc>([
      ["ops", { nodes: [agent("overseer", "bind-1", true), note("n1")], edges: [] }],
    ]);
    expect(callerGrantLive(docs, { canvasName: "ops", nodeId: "overseer" })).toBe(true);
    expect(callerGrantLive(docs, { canvasName: "ops", nodeId: "n1" })).toBe(false);
    expect(nodeSeatBinding(agent("overseer", "bind-1"))).toEqual({
      hostId: "local",
      bindingId: "bind-1",
    });
  });
});
