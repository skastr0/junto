import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { attentionOf, isReservedClaimActor, sinkGlance, workerClaimId } from "../src/shared/attention";
import { deriveExecutionGraph } from "../src/shared/execution-graph";
import { factoryClaimTick } from "../src/shared/factory-tick";
import { taskItem, claimed } from "./helpers/task-fixtures";
import { seat } from "./helpers/physics-seats";

const tasksNode = (
  id: string,
  items: CanvasDoc["nodes"][number]["ether"] extends infer E
    ? E extends { tasks?: { items: infer I } }
      ? I
      : never
    : never,
  workRole?: string,
): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: {
    entity: { kind: "task" },
    tasks: { items: [...items] },
    ...(workRole ? { workRole } : {}),
  },
});

describe("sinkGlance + attention", () => {
  it("splits queued / in-flight / needs-input; only working is in flight", () => {
    const items = [
      taskItem("a", "one", "submitted"),
      taskItem("b", "two", "working"),
      taskItem("c", "three", "input-required"),
      taskItem("d", "four", "completed"),
    ];
    expect(sinkGlance(items)).toEqual({ queued: 1, inFlight: 1, needsInput: 1, total: 4 });
  });

  it("task sink fires on input-required; ice when empty", () => {
    const empty = tasksNode("t", []);
    expect(attentionOf(empty, undefined)).toBe("empty");

    const hot = tasksNode("t", [taskItem("i1", "x", "input-required")]);
    expect(attentionOf(hot, undefined)).toBe("fire");

    const calm = tasksNode("t", [taskItem("i1", "x", "submitted")]);
    expect(attentionOf(calm, undefined)).toBe("idle");
  });

  it("actor fire when phase-blocked else ice", () => {
    const actor = seat("a1", "actor");
    const graph = deriveExecutionGraph({
      nodes: [
        tasksNode("t", [claimed(taskItem("i1", "x", "input-required"), "a1")]),
        actor,
      ],
      edges: [
        {
          id: "e1",
          fromNode: "t",
          toNode: "a1",
          ether: { criteria: { mode: "tasks" } },
        },
      ],
    });
    expect(graph.blocked.has("a1")).toBe(true);
    expect(attentionOf(actor, graph)).toBe("fire");
    expect(attentionOf(actor, deriveExecutionGraph({ nodes: [actor], edges: [] }))).toBe("ice");
  });

  it("actor manual flags: attention fires, parked idles", () => {
    const flagged = (flags: ReadonlyArray<"blocker" | "parked" | "attention">) =>
      seat("a1", "actor", { flags });
    expect(attentionOf(flagged(["attention"]), undefined)).toBe("fire");
    expect(attentionOf(flagged(["parked"]), undefined)).toBe("idle");
  });

  it("workerClaimId never invents operator", () => {
    const actor = seat("a1", "actor");
    expect(workerClaimId(actor)).not.toMatch(/operator/i);
    expect(isReservedClaimActor("operator")).toBe(true);
    expect(isReservedClaimActor("builder")).toBe(false);
  });
});

describe("factoryClaimTick", () => {
  it("role-matched free actor claims submitted task", () => {
    const doc: CanvasDoc = {
      nodes: [
        tasksNode("t", [taskItem("i1", "ship", "submitted")], "builder"),
        {
          ...seat("w1", "actor", { label: "worker" }),
          ether: {
            ...seat("w1", "actor").ether,
            workRole: "builder",
          },
        },
      ],
      edges: [{ id: "e1", fromNode: "t", toNode: "w1" }],
    };
    const { doc: next, claimed } = factoryClaimTick(doc, "c");
    // Claim identity is the seat, never the shared role tag.
    expect(claimed).toEqual([{ taskId: "i1", actor: "w1" }]);
    const task = next.nodes
      .find((n) => n.id === "t")
      ?.ether?.tasks?.items.find((t) => t.id === "i1");
    expect(task?.state).toBe("working");
    expect(task?.metadata?.claimedBy).toBe("w1");
  });

  it("two seats sharing a role are distinct workers — one claim each per tick", () => {
    const withRole = (id: string) => ({
      ...seat(id, "actor"),
      ether: { ...seat(id, "actor").ether, workRole: "builder" },
    });
    const doc: CanvasDoc = {
      nodes: [
        tasksNode(
          "t",
          [taskItem("i1", "ship", "submitted"), taskItem("i2", "docs", "submitted")],
          "builder",
        ),
        withRole("w1"),
        withRole("w2"),
      ],
      edges: [
        { id: "e1", fromNode: "t", toNode: "w1" },
        { id: "e2", fromNode: "t", toNode: "w2" },
      ],
    };
    const { claimed } = factoryClaimTick(doc, "c");
    expect(new Set(claimed.map((c) => c.actor))).toEqual(new Set(["w1", "w2"]));
  });

  it("does not claim when roles mismatch", () => {
    const doc: CanvasDoc = {
      nodes: [
        tasksNode("t", [taskItem("i1", "ship", "submitted")], "builder"),
        {
          ...seat("w1", "actor"),
          ether: { ...seat("w1", "actor").ether, workRole: "reviewer" },
        },
      ],
      edges: [{ id: "e1", fromNode: "t", toNode: "w1" }],
    };
    const { claimed } = factoryClaimTick(doc, "c");
    expect(claimed).toEqual([]);
  });
});
