import { describe, expect, it, beforeEach } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  clearSeatBlocked,
  clearSeatBlockedByRequest,
  getSeatBlock,
  liveSeatBlock,
  liveSeatBlocksForCanvas,
  markSeatBlocked,
  requestStillBlocking,
  resetSeatBlocks,
  stopDirectiveFromBlock,
} from "../src/main/vellum-command/work/blocked-seat";
import { makeStopDirective } from "../src/shared/work-control";

const docWithRequest = (
  state: "input-required" | "completed" | "rejected" | "working",
  requestId = "r1",
): CanvasDoc => ({
  nodes: [
    {
      id: "agent",
      type: "text",
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      text: "agent",
      ether: { entity: { kind: "agent", name: "local:agent" } },
    },
    {
      id: "req",
      type: "text",
      x: 200,
      y: 0,
      width: 100,
      height: 40,
      text: "requests",
      ether: {
        entity: { kind: "requests" },
        requests: {
          items: [
            {
              id: requestId,
              state,
              history: [],
              metadata: { claimedBy: "agent" },
            },
          ],
        },
      },
    },
  ],
  edges: [{ id: "e1", fromNode: "agent", toNode: "req" }],
});

describe("blocked-seat plane", () => {
  beforeEach(() => {
    resetSeatBlocks();
  });

  it("marks blocked and returns a stop directive", () => {
    const block = markSeatBlocked({
      canvasName: "demo",
      nodeId: "agent",
      requestId: "r1",
      target: "req",
      brief: "need key",
    });
    expect(getSeatBlock("demo", "agent")).toEqual(block);
    const directive = stopDirectiveFromBlock(block);
    expect(directive.action).toBe("stop");
    expect(directive.requestId).toBe("r1");
    expect(directive.reason).toBe("awaiting_operator");
    expect(makeStopDirective({ requestId: "r1", target: "req", brief: "need key" })).toEqual(
      directive,
    );
  });

  it("liveSeatBlock holds while request is input-required", () => {
    markSeatBlocked({
      canvasName: "demo",
      nodeId: "agent",
      requestId: "r1",
      target: "req",
      brief: "need key",
    });
    const live = liveSeatBlock("demo", "agent", docWithRequest("input-required"));
    expect(live?.requestId).toBe("r1");
  });

  it("projects the exact blocked actor and request into execution state", () => {
    markSeatBlocked({
      canvasName: "demo",
      nodeId: "agent",
      requestId: "r1",
      target: "requests",
      brief: "need operator choice",
    });

    expect(
      liveSeatBlocksForCanvas("demo", docWithRequest("input-required")).get("agent"),
    ).toEqual({
      requestId: "r1",
      targetNodeId: "requests",
      detail: "need operator choice",
    });
  });

  it("liveSeatBlock auto-clears when request is completed", () => {
    markSeatBlocked({
      canvasName: "demo",
      nodeId: "agent",
      requestId: "r1",
      target: "req",
      brief: "need key",
    });
    expect(liveSeatBlock("demo", "agent", docWithRequest("completed"))).toBeUndefined();
    expect(getSeatBlock("demo", "agent")).toBeUndefined();
  });

  it("clearSeatBlockedByRequest restores the seat", () => {
    markSeatBlocked({
      canvasName: "demo",
      nodeId: "agent",
      requestId: "r1",
      target: "req",
      brief: "need key",
    });
    expect(clearSeatBlockedByRequest("demo", "r1")).toBe(true);
    expect(getSeatBlock("demo", "agent")).toBeUndefined();
  });

  it("requestStillBlocking is false when request missing or terminal", () => {
    const block = markSeatBlocked({
      canvasName: "demo",
      nodeId: "agent",
      requestId: "r1",
      target: "req",
      brief: "x",
    });
    expect(requestStillBlocking(docWithRequest("input-required"), block)).toBe(true);
    expect(requestStillBlocking(docWithRequest("rejected"), block)).toBe(false);
    expect(
      requestStillBlocking(
        {
          nodes: [
            {
              id: "req",
              type: "text",
              x: 0,
              y: 0,
              width: 10,
              height: 10,
              text: "r",
              ether: { entity: { kind: "requests" }, requests: { items: [] } },
            },
          ],
          edges: [],
        },
        block,
      ),
    ).toBe(false);
    clearSeatBlocked("demo", "agent");
  });
});
