import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { claimedTaskForActorNode } from "../src/renderer/lib/claimed-task";
import { ActorRef } from "../src/shared/work-protocol";
import type { CanvasDoc } from "../src/shared/canvas";

const actor = Schema.decodeUnknownSync(ActorRef)({
  seatId: `seat_${"a".repeat(64)}`,
  canvasName: "factory",
  nodeId: "agent",
});

const doc = (state: "submitted" | "working" | "completed"): CanvasDoc => ({
  nodes: [
    {
      id: "tasks",
      type: "text",
      text: "task",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      ether: {
        entity: { kind: "task" },
        tasks: {
          items: [
            {
              id: "task-1",
              state,
              ...(state === "submitted" ? {} : { claimedBy: actor.seatId }),
              history: [],
            },
          ],
        },
      },
    },
  ],
  edges: [],
});

describe("claimed task projection", () => {
  it("resolves active work through the compiled ActorSeatId", () => {
    expect(claimedTaskForActorNode(doc("working"), [actor], "agent")).toMatchObject({
      sinkNodeId: "tasks",
      task: { id: "task-1", state: "working" },
    });
  });

  it("does not present queued or closed history as the current claim", () => {
    expect(claimedTaskForActorNode(doc("submitted"), [actor], "agent")).toBeUndefined();
    expect(claimedTaskForActorNode(doc("completed"), [actor], "agent")).toBeUndefined();
  });
});
