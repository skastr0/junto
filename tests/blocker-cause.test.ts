import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { deriveExecutionGraph as deriveExecutionGraphWithContext } from "../src/shared/execution-graph";
import { resolveBlockerCause } from "../src/renderer/lib/blocker-cause";
import {
  actorRefFixture,
  claimedByNode as claimed,
  executionContextForDoc,
} from "./helpers/actor-ref-fixtures";
import { taskItem } from "./helpers/task-fixtures";
import { seat } from "./helpers/physics-seats";

const deriveExecutionGraph = (doc: CanvasDoc) =>
  deriveExecutionGraphWithContext(doc, executionContextForDoc(doc));

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

/** Actor blocked by requests sink needing input (tasks criteria edge). */
const blockedByRequestsDoc = (): CanvasDoc => ({
  nodes: [
    text("req", "Inbox", {
      entity: { kind: "requests" },
      requests: {
        items: [claimed(taskItem("q1", "approve deploy?", "input-required"), "agent")],
      },
    }),
    seat("agent", "actor", { label: "Codex" }),
    seat("free", "actor", { label: "Idle" }),
  ],
  edges: [
    {
      id: "e1",
      fromNode: "req",
      toNode: "agent",
      ether: { criteria: { mode: "tasks" } },
    },
  ],
});

describe("resolveBlockerCause", () => {
  it("points a blocked actor at the requests generator and the holding item", () => {
    const doc = blockedByRequestsDoc();
    const graph = deriveExecutionGraph(doc);
    expect(graph.blocked.has("agent")).toBe(true);

    const seatId = actorRefFixture("agent").seatId;
    const cause = resolveBlockerCause(doc, graph, "agent", {
      blockedActorSeatId: seatId,
    });
    expect(cause).not.toBeNull();
    expect(cause!.causeNodeId).toBe("req");
    expect(cause!.isSelf).toBe(false);
    expect(cause!.openWorkDetail).toBe(true);
    expect(cause!.role).toBe("generator");
    expect(cause!.workItemId).toBe("q1");
    expect(cause!.title.toLowerCase()).toMatch(/inbox|approve/i);
  });

  it("on the generator itself, resolves self + open work detail", () => {
    const doc = blockedByRequestsDoc();
    const graph = deriveExecutionGraph(doc);
    const cause = resolveBlockerCause(doc, graph, "req");
    expect(cause).not.toBeNull();
    expect(cause!.causeNodeId).toBe("req");
    expect(cause!.isSelf).toBe(true);
    expect(cause!.openWorkDetail).toBe(true);
  });

  it("returns null outside any stoppage cone", () => {
    const doc = blockedByRequestsDoc();
    const graph = deriveExecutionGraph(doc);
    expect(resolveBlockerCause(doc, graph, "free")).toBeNull();
  });

  it("manual blocker seed on an actor resolves to self", () => {
    const doc: CanvasDoc = {
      nodes: [
        seat("a", "actor", {
          label: "Blocked",
          flags: ["blocker"],
        }),
      ],
      edges: [],
    };
    const graph = deriveExecutionGraph(doc);
    expect(graph.seedNodeIds.has("a")).toBe(true);
    const cause = resolveBlockerCause(doc, graph, "a");
    expect(cause).not.toBeNull();
    expect(cause!.causeNodeId).toBe("a");
    expect(cause!.isSelf).toBe(true);
    expect(cause!.openWorkDetail).toBe(false);
    expect(cause!.role).toBe("seed");
  });
});
